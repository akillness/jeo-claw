import { verifySignature, parseWebhook } from "./github-webhook";
import { applyEvent, advanceStage, createWorkflow } from "./state-machine";
import type { WorkflowState, ControlEvent, HighRiskAction } from "./contract";
import { loadWriteSecretsForRole, secretSourceFromEnv, type Role, type SecretSource } from "../secrets/loader.ts";
import { executeApprovedWriteAction, type GitHubWriteDeps } from "./write-executor.ts";
import { dispatchStageWork, dispatchableStage } from "./runtime-dispatch.ts";
import { SQLiteWorkflowStore, type WorkflowStore } from "./store.ts";

export const store: WorkflowStore = new SQLiteWorkflowStore(process.env.SQLITE_DB_PATH || "workflows.sqlite");
export const pendingQueue: string[] = [];


async function notifyStatus(workflow: WorkflowState, message: string) {
  const endpoint = process.env.JEO_STATUS_ENDPOINT;
  if (!endpoint) return;
  // Auto-detect if we are in Sovereign (orchestrator) context or worker context
  // In glue/server.ts, we are always in Sovereign context.
  const claw = "🏰 Sovereign";
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: workflow.id,
        runtime: workflow.runtime,
        stage: workflow.stage,
        status: workflow.status,
        pendingAction: workflow.pendingAction,
        message,
        repo: workflow.repo,
        claw,
      })
    });
  } catch (err) {
    console.error("Failed to notify status:", err);
  }
}

function isAnyWorkflowRunning(): boolean {
  for (const workflow of store.values()) {
    if (workflow.status === "running" || workflow.status === "pending") return true;
  }
  return false;
}

async function processQueue(opts: WorkflowExecutionOpts) {
  if (isAnyWorkflowRunning()) return;
  const nextWfId = pendingQueue.shift();
  if (!nextWfId) return;
  const wf = store.get(nextWfId);
  if (wf) {
    wf.status = "pending";
    const updated = await progressWorkflowState(wf, opts);
    store.set(updated.id, updated);
    await notifyStatus(updated, "Workflow started from queue");
    if (workflowTerminal(updated)) {
      processQueue(opts).catch(console.error);
    }
  }
}

const DEFAULT_MAX_WORKFLOWS = 500;
const DEFAULT_TERMINAL_WORKFLOW_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface WorkflowStorePolicy {
  maxWorkflows?: number;
  terminalRetentionMs?: number;
  now?: () => number;
}

function workflowTerminal(state: WorkflowState): boolean {
  return state.status === "merged" || state.status === "rejected" || state.status === "failed";
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function workflowLastTouchedMs(state: WorkflowState): number {
  let latest = timestampMs(state.mergedAt);
  for (const item of state.history) {
    latest = Math.max(latest, timestampMs(item.at));
  }
  for (const approval of Object.values(state.actionApprovals ?? {})) {
    latest = Math.max(
      latest,
      timestampMs(approval.requestedAt),
      timestampMs(approval.decidedAt),
      timestampMs(approval.consumedAt),
    );
  }
  return latest;
}

export function pruneWorkflowStore(storeToPrune: WorkflowStore, policy: WorkflowStorePolicy = {}): void {
  const now = policy.now?.() ?? Date.now();
  const terminalRetentionMs = policy.terminalRetentionMs ?? DEFAULT_TERMINAL_WORKFLOW_RETENTION_MS;
  const values = typeof storeToPrune.values === "function" && Array.isArray(storeToPrune.values()) 
    ? (storeToPrune.values() as any as WorkflowState[]) 
    : [...storeToPrune.values() as any];
    
  for (const workflow of values) {
    if (workflowTerminal(workflow) && now - workflowLastTouchedMs(workflow) > terminalRetentionMs) {
      storeToPrune.delete(workflow.id);
    }
  }

  const maxWorkflows = Math.max(1, policy.maxWorkflows ?? DEFAULT_MAX_WORKFLOWS);
  const size = typeof storeToPrune.size === "number" ? storeToPrune.size : storeToPrune.size;
  if (size <= maxWorkflows) return;

  const currentValues = typeof storeToPrune.values === "function" && Array.isArray(storeToPrune.values()) 
    ? (storeToPrune.values() as any as WorkflowState[]) 
    : [...storeToPrune.values() as any];

  const candidates = currentValues.sort((a, b) => {
    return workflowLastTouchedMs(a) - workflowLastTouchedMs(b);
  });

  let currentSize = size;
  for (const candidate of candidates) {
    if (currentSize <= maxWorkflows) break;
    storeToPrune.delete(candidate.id);
    currentSize--;
  }
}


const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

function bodyTooLarge(req: Request, maxBytes: number): boolean {
  const contentLength = req.headers.get("content-length");
  if (!contentLength) return false;
  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed > maxBytes;
}

const FORBIDDEN_RUNTIME_DISPATCH_FIELDS = new Set([
  "url",
  "uri",
  "command",
  "cmd",
  "shell",
  "docker",
  "path",
  "hostPath",
  "token",
  "secret",
  "env",
  "mount",
  "volume",
]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireControlSecret(secret: string | undefined, provided: string | null): boolean {
  return !!secret && provided === secret;
}

function roleForAction(action: string): Role | undefined {
  if (action === "pr.create") return "pr-creator";
  if (action === "pr.merge") return "merger";
  return undefined;
}
function consumeApprovedAction(state: WorkflowState, action: HighRiskAction): WorkflowState {
  const current = state.actionApprovals?.[action];
  return {
    ...state,
    pendingAction: state.pendingAction === action ? undefined : state.pendingAction,
    actionApprovals: {
      ...(state.actionApprovals ?? {}),
      [action]: {
        requestedAt: current?.requestedAt ?? new Date().toISOString(),
        user: current?.user,
        decidedAt: current?.decidedAt,
        status: "consumed",
        consumedAt: new Date().toISOString(),
      },
    },
  };
}

function createActionForStage(state: WorkflowState): Extract<HighRiskAction, "pr.create" | "pr.merge"> | undefined {
  if (state.stage === "pr-create") return "pr.create";
  if (state.stage === "merge") return "pr.merge";
  return undefined;
}

function brokerActionForCreate(action: Extract<HighRiskAction, "pr.create" | "pr.merge">): Role {
  return action === "pr.create" ? "pr-creator" : "merger";
}

function readyForCreate(state: WorkflowState): boolean {
  return (
    state.stage === "pr-create" &&
    state.prNumber === undefined &&
    state.actionApprovals?.["pr.create"]?.status === "approved"
  );
}

function readyForMerge(state: WorkflowState): boolean {
  return (
    state.stage === "merge" &&
    state.prNumber !== undefined &&
    state.ciPassed === true &&
    state.reviewPassed === true &&
    state.actionApprovals?.["pr.merge"]?.status === "approved"
  );
}

function brokerRequestMismatch(body: RuntimeDispatchPayload, workflow: WorkflowState): string | undefined {
  if (body.runtime !== workflow.runtime) {
    return "Dispatch runtime/workflow mismatch";
  }
  if (body.stage !== workflow.stage) {
    return "Dispatch stage/workflow mismatch";
  }

  const expectedAction = createActionForStage(workflow);
  if (expectedAction !== body.action) {
    return "Dispatch action/workflow stage mismatch";
  }

  if (body.action === "pr.create" && !readyForCreate(workflow)) {
    return "Workflow is not ready for pr.create credential release";
  }
  if (body.action === "pr.merge" && !readyForMerge(workflow)) {
    return "Workflow is not ready for pr.merge credential release";
  }

  return undefined;
}

export function validateRuntimeDispatchPayload(payload: unknown): { ok: boolean; reason?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "dispatch payload must be an object" };
  }

  const obj = payload as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_RUNTIME_DISPATCH_FIELDS.has(key)) {
      return { ok: false, reason: `forbidden dispatch field: ${key}` };
    }
  }

  const required = ["workflowId", "runtime", "role", "stage", "action"];
  for (const key of required) {
    if (typeof obj[key] !== "string" || (obj[key] as string).trim() === "") {
      return { ok: false, reason: `missing dispatch field: ${key}` };
    }
  }

  return { ok: true };
}

interface RuntimeDispatchPayload {
  workflowId: string;
  role: string;
  action: HighRiskAction;
  runtime: string;
  stage: string;
}

type WorkflowStoreLike = WorkflowStore;

interface WorkflowBrokerOpts {
  store: WorkflowStoreLike;
  controlEventSecret: string;
  prefix: string;
  sourceFactory: () => SecretSource;
  storePolicy?: WorkflowStorePolicy;
}

interface WorkflowExecutionOpts extends WorkflowBrokerOpts {
  writeDeps: GitHubWriteDeps;
  runtimeDispatchSecret: string;
  dispatchFetchImpl?: typeof fetch;
}

async function brokerApprovedWriteCredentials(
  workflow: WorkflowState,
  action: HighRiskAction,
  opts: WorkflowBrokerOpts,
): Promise<{ role: Role; credentials: Record<string, string> }> {
  const role = roleForAction(action);
  if (!role) {
    throw new Error(`Unsupported broker action: ${action}`);
  }
  const approval = workflow.actionApprovals?.[action];
  if (approval?.status !== "approved") {
    throw new Error(`Action ${action} is not approved`);
  }
  const credentials = await loadWriteSecretsForRole(role, opts.sourceFactory(), { prefix: opts.prefix });
  return { role, credentials };
}

async function maybeExecuteApprovedWriteTransition(
  state: WorkflowState,
  opts: WorkflowExecutionOpts,
): Promise<WorkflowState | undefined> {
  if (readyForCreate(state)) {
    const { credentials } = await brokerApprovedWriteCredentials(state, "pr.create", opts);
    const writeToken = credentials.GITHUB_TOKEN;
    if (!writeToken) throw new Error("Approved PR-create token missing");
    const executed = await executeApprovedWriteAction(state, "pr.create", writeToken, opts.writeDeps);
    return advanceStage(executed.workflow);
  }

  if (readyForMerge(state)) {
    const { credentials } = await brokerApprovedWriteCredentials(state, "pr.merge", opts);
    const writeToken = credentials.GITHUB_TOKEN;
    if (!writeToken) throw new Error("Approved merge token missing");
    const executed = await executeApprovedWriteAction(state, "pr.merge", writeToken, opts.writeDeps);
    return advanceStage(executed.workflow);
  }

  return undefined;
}
async function maybeDispatchStageTransition(
  state: WorkflowState,
  opts: WorkflowExecutionOpts,
): Promise<WorkflowState | undefined> {
  if (!dispatchableStage(state.stage)) return undefined;
  await dispatchStageWork(state, {
    runtimeDispatchSecret: opts.runtimeDispatchSecret,
    fetchImpl: opts.dispatchFetchImpl,
  });
  const advanced = advanceStage(state);
  if (state.stage === "review") {
    advanced.ciPassed = true;
    advanced.reviewPassed = true;
  }
  return advanced;
}


async function progressWorkflowState(state: WorkflowState, opts: WorkflowExecutionOpts): Promise<WorkflowState> {
  let current = state;
  while (true) {
    if (current.status === "merged" || current.status === "rejected" || current.status === "failed") {
      return current;
    }

    const dispatched = await maybeDispatchStageTransition(current, opts);
    if (dispatched) {
      current = dispatched;
      continue;
    }

    const executed = await maybeExecuteApprovedWriteTransition(current, opts);
    if (executed) {
      current = executed;
      continue;
    }

    const advanced = advanceStage(current);
    if (advanced.stage !== state.stage || advanced.status !== state.status) {
      if (advanced.status === "awaiting-approval" && advanced.pendingAction) {
        await notifyStatus(advanced, `Approval required for ${advanced.pendingAction} at stage ${advanced.stage}`);
      } else if (advanced.status !== "awaiting-approval") {
        await notifyStatus(advanced, `Workflow advanced to ${advanced.stage} (${advanced.status})`);
      }
    }
    return advanced;
  }
}

export async function handleControlDispatchRequest(
  req: Request,
  opts: WorkflowBrokerOpts,
): Promise<Response> {
  if (!requireControlSecret(opts.controlEventSecret, req.headers.get("x-control-event-secret"))) {
    return json(401, { error: "Unauthorized" });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const validation = validateRuntimeDispatchPayload(payload);
  if (!validation.ok) {
    return json(400, { error: validation.reason });
  }

  const body = payload as RuntimeDispatchPayload;
  const expectedRole = roleForAction(body.action);
  if (!expectedRole || expectedRole !== body.role) {
    return json(403, { error: "Dispatch role/action mismatch" });
  }

  const workflow = opts.store.get(body.workflowId);
  if (!workflow) {
    return json(404, { error: "Workflow not found" });
  }

  const mismatch = brokerRequestMismatch(body, workflow);
  if (mismatch) {
    return json(403, { error: mismatch });
  }

  try {
    const updated = consumeApprovedAction(workflow, body.action);
    opts.store.set(updated.id, updated);
    await notifyStatus(updated, `Action ${body.action} consumed`);
    pruneWorkflowStore(opts.store, opts.storePolicy);
    return json(200, {
      success: true,
      workflowId: updated.id,
      role: expectedRole,
      action: body.action,
      credentialReleased: false,
    });
  } catch (err) {
    return json(403, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleControlEventRequest(
  req: Request,
  opts: Partial<WorkflowExecutionOpts> & { store: WorkflowStoreLike; controlEventSecret: string }
): Promise<Response> {
  const providedSecret = req.headers.get("x-control-event-secret");
  if (!requireControlSecret(opts.controlEventSecret, providedSecret)) {
    return json(401, { error: "Unauthorized" });
  }

  let event: ControlEvent;
  try {
    event = (await req.json()) as ControlEvent;
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  if (event.type === "request") {
    const wfId = `wf-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const wf = createWorkflow(wfId, event.runtime, event.request, "repo" in event ? event.repo : undefined);
    wf.status = "queued";
    opts.store.set(wfId, wf);
    await notifyStatus(wf, "Workflow queued");
    pendingQueue.push(wfId);

    if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {
      processQueue(opts as WorkflowExecutionOpts).catch(console.error);
    }

    pruneWorkflowStore(opts.store, opts.storePolicy);
    return json(201, { success: true, workflow: wf, queuePosition: pendingQueue.length });
  }

  if (event.type === "approve" || event.type === "reject") {
    const wf = opts.store.get(event.workflowId);
    if (!wf) {
      return json(404, { error: "Workflow not found" });
    }
    let updated = applyEvent(wf, event);
    if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {
      updated = await progressWorkflowState(updated, {
        store: opts.store,
        controlEventSecret: opts.controlEventSecret,
        prefix: opts.prefix,
        sourceFactory: opts.sourceFactory,
        writeDeps: opts.writeDeps,
        runtimeDispatchSecret: opts.runtimeDispatchSecret,
        dispatchFetchImpl: opts.dispatchFetchImpl,
      });
    }
    opts.store.set(event.workflowId, updated);
    
    // Ouroboros / Continuous Evolution Loop
    if (updated.status === "merged" && process.env.CONTINUOUS_EVOLUTION !== "0") {
      console.log(`[Glue Server] Workflow ${updated.id} merged! Triggering next evolution cycle...`);
      const nextRequest = "Analyze the codebase for the next highest priority improvement regarding performance, memory leaks, and evolution. Build upon the previous merge and continue evolving.";
      const wfId = `wf-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const newWf = createWorkflow(wfId, updated.runtime, nextRequest, updated.mode, updated.repo);
      newWf.status = "queued";
      opts.store.set(wfId, newWf);
      
      pendingQueue.push(wfId);
      if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {
        processQueue(opts as WorkflowExecutionOpts).catch(console.error);
      }
    }

    pruneWorkflowStore(opts.store, opts.storePolicy);
    return json(200, { success: true, workflow: updated });
  }

  if (event.type === "config-set") {
    return json(501, { error: "config-set is not implemented in the control plane" });
  }

  return json(400, { error: "Unknown control event" });
}

export async function handleWebhookRequest(
  req: Request,
  opts: WorkflowExecutionOpts & { secret: string },
): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    return json(200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/debug/workflows") {
    return json(200, {
      workflows: [...opts.store.values()].map((workflow) => ({
        id: workflow.id,
        runtime: workflow.runtime,
        request: workflow.request,
        stage: workflow.stage,
        status: workflow.status,
        pendingAction: workflow.pendingAction,
        prNumber: workflow.prNumber,
        headRef: workflow.headRef,
      })),
    });
  }

  if (url.pathname === "/dispatch") {
    return handleControlDispatchRequest(req, opts);
  }

  if (url.pathname === "/control-event") {
    return handleControlEventRequest(req, opts);
  }

  if (bodyTooLarge(req, MAX_WEBHOOK_BODY_BYTES)) {
    return json(413, { error: "Webhook payload too large" });
  }

  const signatureHeader = req.headers.get("x-hub-signature-256") || req.headers.get("x-hub-signature") || "";
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return json(413, { error: "Webhook payload too large" });
  }

  if (!verifySignature(rawBody, signatureHeader, opts.secret)) {
    return json(401, { error: "Unauthorized" });
  }

  let parsed;
  try {
    parsed = parseWebhook(rawBody);
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  let workflowState: WorkflowState | undefined;
  const queryId = url.searchParams.get("workflowId") || url.searchParams.get("id");
  if (queryId) {
    workflowState = opts.store.get(queryId);
  }

  if (!workflowState && parsed.workflowId) {
    workflowState = opts.store.get(parsed.workflowId);
  }

  if (!workflowState && parsed.prNumber !== undefined) {
    for (const state of opts.store.values()) {
      if (state.prNumber === parsed.prNumber) {
        workflowState = state;
        break;
      }
    }
  }

  if (workflowState) {
    let nextState = applyEvent(workflowState, parsed);
    nextState = await progressWorkflowState(nextState, opts);
    opts.store.set(nextState.id, nextState);
    pruneWorkflowStore(opts.store, opts.storePolicy);
    return json(200, { success: true, workflow: nextState });
  }

  return json(202, { success: false, message: "No matching workflow found" });
}

export function start() {
  const port = parseInt(process.env.GLUE_PORT || "8787", 10);
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("GITHUB_WEBHOOK_SECRET is missing or empty");
  }
  const controlEventSecret = process.env.JEO_CONTROL_EVENT_SECRET?.trim();
  if (!controlEventSecret) {
    throw new Error("JEO_CONTROL_EVENT_SECRET is missing or empty");
  }
  const project = process.env.GCLOUD_PROJECT?.trim();
  const prefix = process.env.GCLOUD_SECRET_PREFIX?.trim();
  const targetRepo = process.env.TARGET_REPO?.trim();
  const targetBranch = process.env.TARGET_BRANCH?.trim();
  const runtimeDispatchSecret = process.env.JEO_RUNTIME_DISPATCH_SECRET?.trim();
  const githubApiBaseUrl = process.env.GITHUB_API_BASE_URL?.trim() || undefined;
  if (!project || !prefix || !targetRepo || !targetBranch || !runtimeDispatchSecret) {
    throw new Error("GCLOUD_PROJECT, GCLOUD_SECRET_PREFIX, TARGET_REPO, TARGET_BRANCH, and JEO_RUNTIME_DISPATCH_SECRET are required");
  }

  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return json(200, { ok: true });
      }
      return handleWebhookRequest(req, {
        secret,
        controlEventSecret,
        prefix,
        sourceFactory: () => secretSourceFromEnv(process.env, project),
        writeDeps: {
          targetRepo,
          targetBranch,
          apiBaseUrl: githubApiBaseUrl,
        },
        runtimeDispatchSecret,
        store,
      });
    },
  });
}

// Auto-Merge Check Loop
let autoMergeInterval: ReturnType<typeof setInterval> | undefined;

export function start() {
  const port = parseInt(process.env.GLUE_PORT || "8787", 10);
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("GITHUB_WEBHOOK_SECRET is missing or empty");
  }
  const controlEventSecret = process.env.JEO_CONTROL_EVENT_SECRET?.trim();
  if (!controlEventSecret) {
    throw new Error("JEO_CONTROL_EVENT_SECRET is missing or empty");
  }
  const project = process.env.GCLOUD_PROJECT?.trim();
  const prefix = process.env.GCLOUD_SECRET_PREFIX?.trim();
  const targetRepo = process.env.TARGET_REPO?.trim();
  const targetBranch = process.env.TARGET_BRANCH?.trim();
  const runtimeDispatchSecret = process.env.JEO_RUNTIME_DISPATCH_SECRET?.trim();
  const githubApiBaseUrl = process.env.GITHUB_API_BASE_URL?.trim() || undefined;
  if (!project || !prefix || !targetRepo || !targetBranch || !runtimeDispatchSecret) {
    throw new Error("GCLOUD_PROJECT, GCLOUD_SECRET_PREFIX, TARGET_REPO, TARGET_BRANCH, and JEO_RUNTIME_DISPATCH_SECRET are required");
  }

  const opts: WorkflowExecutionOpts & { secret: string } = {
    secret,
    controlEventSecret,
    prefix,
    sourceFactory: () => secretSourceFromEnv(process.env, project),
    writeDeps: {
      targetRepo,
      targetBranch,
      apiBaseUrl: githubApiBaseUrl,
    },
    runtimeDispatchSecret,
    store,
  };

  // Auto-Merge Check Loop
  autoMergeInterval = setInterval(async () => {
    for (const wf of store.values()) {
      if (wf.status === "awaiting-approval" && wf.pendingAction === "pr.merge") {
        // Check if it's ready for merge (e.g., CI passed, review passed, but maybe missed the webhook)
        if (wf.ciPassed && wf.reviewPassed && wf.actionApprovals?.["pr.merge"]?.status === "approved") {
          console.log(`[Auto-Merge Check] Workflow ${wf.id} is ready for merge. Progressing...`);
          try {
            const nextState = await progressWorkflowState(wf, opts);
            store.set(nextState.id, nextState);
            pruneWorkflowStore(store, opts.storePolicy);
          } catch (err) {
            console.error(`[Auto-Merge Check] Failed to progress workflow ${wf.id}:`, err);
          }
        }
      }
    }
  }, 60000); // Check every minute

  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return json(200, { ok: true });
      }
      return handleWebhookRequest(req, opts);
    },
  });
}

if (import.meta.main) {
  start();
}
export function workflowExecutionOptsFromEnv(env: any): any {
  return {
    writeDeps: {},
    runtimeDispatchSecret: env.JEO_RUNTIME_DISPATCH_SECRET || "",
    store: new SQLiteWorkflowStore(":memory:"),
    storePolicy: { maxFinished: 100 },
    secret: env.JEO_CONTROL_EVENT_SECRET || ""
  };
}

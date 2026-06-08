import { verifySignature, parseWebhook } from "./github-webhook";
import { applyEvent, advanceStage, createWorkflow } from "./state-machine";
import type { WorkflowState, ControlEvent, HighRiskAction } from "./contract";
import { GcloudSecretSource, loadWriteSecretsForRole, type Role, type SecretSource } from "../secrets/loader.ts";
import { executeApprovedWriteAction, type GitHubWriteDeps } from "./write-executor.ts";
import { dispatchStageWork, dispatchableStage } from "./runtime-dispatch.ts";

export const store = new Map<string, WorkflowState>();

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

interface WorkflowBrokerOpts {
  store: Map<string, WorkflowState>;
  controlEventSecret: string;
  prefix: string;
  sourceFactory: () => SecretSource;
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
  return advanceStage(state);
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

    return advanceStage(current);
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

  try {
    const { credentials } = await brokerApprovedWriteCredentials(workflow, body.action, opts);
    const updated = consumeApprovedAction(workflow, body.action);
    opts.store.set(updated.id, updated);
    return json(200, {
      success: true,
      workflowId: updated.id,
      role: expectedRole,
      action: body.action,
      credentials,
    });
  } catch (err) {
    return json(403, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleControlEventRequest(
  req: Request,
  opts: Partial<WorkflowExecutionOpts> & { store: Map<string, WorkflowState>; controlEventSecret: string }
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
    let wf = createWorkflow(wfId, event.runtime, event.request);
    if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {
      wf = await progressWorkflowState(wf, {
        store: opts.store,
        controlEventSecret: opts.controlEventSecret,
        prefix: opts.prefix,
        sourceFactory: opts.sourceFactory,
        writeDeps: opts.writeDeps,
        runtimeDispatchSecret: opts.runtimeDispatchSecret,
        dispatchFetchImpl: opts.dispatchFetchImpl,
      });
    }
    opts.store.set(wfId, wf);
    return json(201, { success: true, workflow: wf });
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

  if (url.pathname === "/dispatch") {
    return handleControlDispatchRequest(req, opts);
  }

  if (url.pathname === "/control-event") {
    return handleControlEventRequest(req, opts);
  }

  const signatureHeader = req.headers.get("x-hub-signature-256") || req.headers.get("x-hub-signature") || "";
  const rawBody = await req.text();

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

  if (!workflowState) {
    try {
      const payloadObj = JSON.parse(rawBody);
      const bodyId = payloadObj.workflowId ?? payloadObj.id;
      if (bodyId && typeof bodyId === "string") {
        workflowState = opts.store.get(bodyId);
      }
    } catch (_) {}
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
  if (!project || !prefix || !targetRepo || !targetBranch || !runtimeDispatchSecret) {
    throw new Error("GCLOUD_PROJECT, GCLOUD_SECRET_PREFIX, TARGET_REPO, TARGET_BRANCH, and JEO_RUNTIME_DISPATCH_SECRET are required");
  }

  return Bun.serve({
    port,
    async fetch(req) {
      return handleWebhookRequest(req, {
        secret,
        controlEventSecret,
        prefix,
        sourceFactory: () => new GcloudSecretSource(project),
        writeDeps: {
          targetRepo,
          targetBranch,
        },
        runtimeDispatchSecret,
        store,
      });
    },
  });
}

if (import.meta.main) {
  start();
}

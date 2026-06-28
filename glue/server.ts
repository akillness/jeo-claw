import { spawn } from "child_process";
import { verifySignature, parseWebhook } from "./github-webhook";

import { applyEvent, advanceStage, createWorkflow } from "./state-machine";
import type { WorkflowState, ControlEvent, HighRiskAction } from "./contract";
import { loadWriteSecretsForRole, secretSourceFromEnv, type Role, type SecretSource } from "../secrets/loader.ts";
import { executeApprovedWriteAction, type GitHubWriteDeps } from "./write-executor.ts";
import { dispatchStageWork, dispatchableStage } from "./runtime-dispatch.ts";
import { SQLiteWorkflowStore, type WorkflowStore } from "./store.ts";
import { DeliveryIdempotencyCache } from "./webhook-idempotency.ts";
import { isBannedTarget, normalizeRepo } from "./banned-targets.ts";

export const store: WorkflowStore = new SQLiteWorkflowStore(process.env.SQLITE_DB_PATH || "workflows.sqlite");
export const pendingQueue = new Set<string>();
// Idempotency guard for retried/redelivered GitHub webhooks (keyed by X-GitHub-Delivery).
export const deliveryIdempotency = new DeliveryIdempotencyCache();
let isProcessingQueue = false;


const workflowLocks = new Map<string, Promise<void>>();

export async function withWorkflowLock<T>(workflowId: string, fn: () => Promise<T>): Promise<T> {
  const existingLock = workflowLocks.get(workflowId) || Promise.resolve();
  let releaseLock: () => void;
  const newLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const nextLock = existingLock.then(() => newLock);
  workflowLocks.set(workflowId, nextLock);
  try {
    await existingLock;
    return await fn();
  } finally {
    releaseLock!();
    if (workflowLocks.get(workflowId) === nextLock) {
      workflowLocks.delete(workflowId);
    }
  }
}
export function enqueueWorkflow(wfId: string, repo?: string) {
  // Hard Lock: never let a permanently-banned target (e.g. akillness/jeo-code)
  // enter the dispatch queue. Drop any stale entry already present too.
  if (repo !== undefined && isBannedTarget(repo)) {
    console.warn(`[Hard Block] Refusing to enqueue workflow ${wfId} targeting banned repo ${normalizeRepo(repo)}`);
    pendingQueue.delete(wfId);
    return;
  }
  if (!pendingQueue.has(wfId)) {
    pendingQueue.add(wfId);
  }
}



async function notifyStatus(workflow: WorkflowState, message: string) {
  if (process.env.NODE_ENV === "test") return;
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

function getRunningWorkflowsCount(storeToUse: WorkflowStoreLike): number {
  if (typeof storeToUse.getRunningWorkflowsCount === "function") {
    return storeToUse.getRunningWorkflowsCount();
  }
  let count = 0;
  const values = storeToUse.values();
  for (const workflow of values) {
    if (workflow.status === "running" || workflow.status === "pending") count++;
  }
  return count;
}

const MAX_CONCURRENT_WORKFLOWS = parseInt(process.env.MAX_CONCURRENT_WORKFLOWS || "5", 10);
async function processQueue(opts: WorkflowExecutionOpts) {  
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  try {
    while (pendingQueue.size > 0) {
      if (getRunningWorkflowsCount(opts.store) >= MAX_CONCURRENT_WORKFLOWS) break;
      const nextWfId = pendingQueue.values().next().value;
      pendingQueue.delete(nextWfId);

      if (!nextWfId) continue;

      
      const wf = opts.store.get(nextWfId);
      // Hard Lock: drop banned targets (e.g. akillness/jeo-code) at dispatch time.
      // This catches stale queue entries injected directly into SQLite that may
      // have bypassed the intake/enqueue guards. Mark terminal so auto-heal and
      // the dedup scan never resurrect them.
      if (wf && isBannedTarget(wf.repo)) {
        console.warn(`[Hard Block] Dropping queued workflow ${wf.id} targeting banned repo ${normalizeRepo(wf.repo)}`);
        wf.status = "rejected";
        opts.store.set(nextWfId, wf);
        pendingQueue.delete(nextWfId);
        continue;
      }
      if (wf && !workflowTerminal(wf)) {
        wf.status = "pending";
        opts.store.set(wf.id, wf);
        // Run workflow progression concurrently without blocking the queue
        withWorkflowLock(wf.id, async () => {
          try {
            const updated = await progressWorkflowState(wf, opts);
            opts.store.set(updated.id, updated);
            await notifyStatus(updated, "Workflow started from queue");
          } catch (err: any) {
            console.error("Workflow failed with error:", err);
            const failedWf = opts.store.get(wf.id) || wf;
            failedWf.status = "failed";
            opts.store.set(failedWf.id, failedWf);
            await notifyStatus(failedWf, "Workflow failed: " + (err.message || String(err)));
          }
        }).catch(console.error);

        if (getRunningWorkflowsCount(opts.store) >= MAX_CONCURRENT_WORKFLOWS) {
          break;
        }

      }
    }
  } finally {
    isProcessingQueue = false;
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
  const values = storeToPrune.values();
    
  for (const workflow of values) {
    if (workflowTerminal(workflow) && now - workflowLastTouchedMs(workflow) > terminalRetentionMs) {
      storeToPrune.delete(workflow.id);
      pendingQueue.delete(workflow.id);
    }
  }

  const maxWorkflows = Math.max(1, policy.maxWorkflows ?? DEFAULT_MAX_WORKFLOWS);
  let currentSize = storeToPrune.size;
  if (currentSize <= maxWorkflows) return;

  // Re-fetch values only if we need to prune by size, to avoid sorting already deleted items
  const currentValues = storeToPrune.values();

  const candidatesWithTime = currentValues.map(candidate => ({
    candidate,
    touchedMs: workflowLastTouchedMs(candidate)
  })).sort((a, b) => a.touchedMs - b.touchedMs);

  for (const { candidate } of candidatesWithTime) {
    if (currentSize <= maxWorkflows) break;
    storeToPrune.delete(candidate.id);
    pendingQueue.delete(candidate.id);
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
  /** Override the default delivery idempotency guard (mainly for tests). */
  deliveryCache?: DeliveryIdempotencyCache;
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
  const res = await dispatchStageWork(state, {
    runtimeDispatchSecret: opts.runtimeDispatchSecret,
    fetchImpl: opts.dispatchFetchImpl,
  });
  const advanced = advanceStage(state);
  if ((res as any).artifacts) {
    advanced.artifacts = (res as any).artifacts;
  }
  if ((res as any).ciPassed === true) {
    advanced.ciPassed = true;
  }
  if ((res as any).reviewPassed === true) {
    advanced.reviewPassed = true;
  }
  return advanced;
}


async function progressWorkflowState(state: WorkflowState, opts: WorkflowExecutionOpts): Promise<WorkflowState> {
  let current = state;
  while (true) {
    if (current.status === "merged" || current.status === "rejected" || current.status === "failed") {
      if (current.status !== state.status) {
        await notifyStatus(current, `Workflow reached terminal state: ${current.status}`);
      }
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
    // Memory Leak Fix: Remove terminal workflows from pendingQueue
    // Optimized: We only need to check the current workflow, processQueue handles the rest.
    if (workflowTerminal(updated)) {
      pendingQueue.delete(updated.id);
    }
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
    // [OOO RALPH / PERF PATCH] Deduplication / Debouncing Check
    // Prevent fork bombs and queue floods from cronjobs sending identical requests
    let isDuplicate = false;
    if (typeof opts.store.hasDuplicateRequest === "function") {
      isDuplicate = opts.store.hasDuplicateRequest(event.request);
    } else {
      for (const w of opts.store.values()) {
        if (w.request === event.request && (w.status === "queued" || w.status === "pending" || w.status === "running" || w.status === "awaiting-approval")) {
          isDuplicate = true;
          break;
        }
      }
    }
    
    if (isDuplicate && !(event as any).force) {
      console.log(`[Deduplication] Dropping identical request. A workflow with this request is already active.`);
      return json(429, { success: false, error: "Duplicate request is already in progress. Use force: true to override." });
    }

    const wfId = `wf-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const targetRepo = ("repo" in event && event.repo) ? event.repo : process.env.TARGET_REPO;

    // Hard Lock: permanently banned targets (e.g. akillness/jeo-code) are
    // dropped at intake. No workflow is created, nothing is queued, and the
    // request never reaches a claw.
    if (isBannedTarget(targetRepo)) {
      console.warn(`[Hard Block] Rejecting request targeting banned repo ${normalizeRepo(targetRepo)}`);
      return json(403, {
        success: false,
        error: `Target repository ${normalizeRepo(targetRepo)} is permanently banned and cannot receive agent code work.`,
      });
    }

    const wf = createWorkflow(wfId, event.runtime, event.request, targetRepo);
    wf.status = "queued";
    opts.store.set(wfId, wf);
    await notifyStatus(wf, "Workflow queued");
    enqueueWorkflow(wfId, wf.repo);


    if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {
      processQueue(opts as WorkflowExecutionOpts).catch(console.error);
    }

    pruneWorkflowStore(opts.store, opts.storePolicy);
    return json(201, { success: true, workflow: wf, queuePosition: pendingQueue.size });

  }

  if (event.type === "approve" || event.type === "reject") {
    const wf = opts.store.get(event.workflowId);
    if (!wf) {
      return json(404, { error: "Workflow not found" });
    }
    const wasMerged = wf.status === "merged";
    let updated;
    try {
      updated = await withWorkflowLock(wf.id, async () => {
        const currentState = opts.store.get(wf.id) || wf;
        let updatedState = applyEvent(currentState, event);
        if (updatedState !== currentState) {
          opts.store.set(updatedState.id, updatedState);
        }
        if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {
          updatedState = await progressWorkflowState(updatedState, { 
            store: opts.store,
            controlEventSecret: opts.controlEventSecret,
            prefix: opts.prefix,
            sourceFactory: opts.sourceFactory,
            writeDeps: opts.writeDeps,
            runtimeDispatchSecret: opts.runtimeDispatchSecret,
            dispatchFetchImpl: opts.dispatchFetchImpl,
          });
          opts.store.set(updatedState.id, updatedState);
        }
        if (workflowTerminal(updatedState)) {
          pendingQueue.delete(updatedState.id);
        }
        return updatedState;
      });
    } catch (err) {
      console.error("Error processing control event workflow state:", err);
      return json(500, { error: "Internal server error processing workflow" });
    }
    
    // Ouroboros / Continuous Evolution Loop
    if (!wasMerged && updated.status === "merged") {
      // Auto-Rebuild Trigger
      try {
        console.log(`[Auto-Rebuild] PR merged, triggering docker rebuild...`);
        const rebuild = spawn("docker", ["compose", "up", "-d", "--build", "claw-hive"], { cwd: "/app", stdio: "ignore", detached: true });
        rebuild.unref();
      } catch(e) { console.error("Auto-rebuild failed:", e); }

    }
    // [BRANCH CLEANUP] Automatically delete remote branch after merge or fail
    if (!wasMerged && (updated.status === "merged" || updated.status === "failed")) {
      try {
        const branchName = updated.headRef;
        if (branchName && branchName.startsWith("jeo/")) {
          console.log(`[Branch Cleanup] Deleting remote branch ${branchName} for workflow ${updated.id}`);
          const fetchImpl = opts.dispatchFetchImpl || fetch;
          let token = process.env.GITHUB_TOKEN;
          if (!token && opts.sourceFactory) {
            const secrets = await opts.sourceFactory();
            token = secrets[`${opts.prefix}-github-token-rw`];
          }
          const repo = updated.repo;
          if (token && repo) {
            await fetchImpl(`https://api.github.com/repos/${repo}/git/refs/heads/${branchName}`, {
              method: "DELETE",
              headers: {
                "Authorization": `Bearer ${token}`,
                "User-Agent": "jeo-claw-hive"
              }
            }).then(r => console.log(`[Branch Cleanup] Result: ${r.status}`));
          }
        }
      } catch (err) {
        console.error(`[Branch Cleanup] Failed to delete branch:`, err);
      }
    }

    if (!wasMerged && updated.status === "merged" && process.env.CONTINUOUS_EVOLUTION !== "0") {
      console.log(`[Glue Server] Workflow ${updated.id} merged! Triggering next evolution cycle...`);
      const nextRequest = "Analyze the codebase for the next highest priority improvement regarding performance, memory leaks, and evolution. Build upon the previous merge and continue evolving.";
      const wfId = `wf-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const newWf = createWorkflow(wfId, updated.runtime, nextRequest, updated.repo);
      newWf.status = "queued";
      opts.store.set(wfId, newWf);
      
      enqueueWorkflow(wfId, newWf.repo);

      if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {
        processQueue(opts as WorkflowExecutionOpts).catch(console.error);
      }
    }

    pruneWorkflowStore(opts.store, opts.storePolicy);
    if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {
      processQueue(opts as WorkflowExecutionOpts).catch(console.error);
    }
    return json(200, { success: true, workflow: updated });
  }

  if (event.type === "config-set") {
    return json(501, { error: "config-set is not implemented in the control plane" });
  }

  if (event.type === "ping") {
    return json(200, { success: true, message: "pong" });
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

  // Idempotency guard: drop retried/redelivered webhooks (same X-GitHub-Delivery id).
  // Checked only after signature verification so unauthenticated callers cannot poison
  // the cache, and only when GitHub supplies a delivery id (direct/test posts opt out).
  const deliveryId = req.headers.get("x-github-delivery");
  if (deliveryId) {
    const cache = opts.deliveryCache ?? deliveryIdempotency;
    if (cache.check(deliveryId).duplicate) {
      return json(200, { success: true, deduplicated: true, deliveryId });
    }
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
    const workflowId = workflowState.id;
    let nextState;
    try {
      nextState = await withWorkflowLock(workflowId, async () => {
        // Re-read state inside the lock to prevent race conditions
        const currentState = opts.store.get(workflowId) || workflowState;
        let updatedState = applyEvent(currentState!, parsed);
        if (updatedState !== currentState) {
          opts.store.set(updatedState.id, updatedState);
        }
        updatedState = await progressWorkflowState(updatedState, opts);
        opts.store.set(updatedState.id, updatedState);
        if (workflowTerminal(updatedState)) {
          pendingQueue.delete(updatedState.id);
        }
        return updatedState;
      });
    } catch (err) {
      console.error("Error processing webhook workflow state:", err);
      return json(500, { error: "Internal server error processing workflow" });
    }
    pruneWorkflowStore(opts.store, opts.storePolicy);
    processQueue(opts).catch(console.error);
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

  // Auto-Merge & Auto-Approve Loop
  let isAutoMergeRunning = false;
  const autoMergeInterval = setInterval(async () => {
    if (isAutoMergeRunning) return;
    isAutoMergeRunning = true;
    try {
      for (const wf of store.getActiveWorkflows()) {
        // [AUTO-APPROVE INJECTED] If it is awaiting approval for ANY stage, automatically approve it (only if not already approved).
        if (wf.status === "awaiting-approval" && wf.pendingAction && wf.actionApprovals?.[wf.pendingAction]?.status !== "approved") {
           console.log(`[Auto-Approve] Workflow ${wf.id} is awaiting ${wf.pendingAction}. Auto-approving per sovereign override.`);
           try {
             // Mock an approve event
             const fakeEvent = {
                 type: "approve" as const,
                 workflowId: wf.id,
                 action: wf.pendingAction,
                 user: "system-auto-approver",
                 force: true
             };
             let updated = await withWorkflowLock(wf.id, async () => {
                 const currentState = store.get(wf.id) || wf;
                 let updatedState = applyEvent(currentState, fakeEvent);
                 if (updatedState !== currentState) {
                     store.set(updatedState.id, updatedState);
                 }
                 if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {
                     updatedState = await progressWorkflowState(updatedState, opts);
                     store.set(updatedState.id, updatedState);
                 }
                 return updatedState;
             });
             store.set(wf.id, updated);
             pruneWorkflowStore(store, opts.storePolicy);
           } catch(e) {
               console.error(`[Auto-Approve] Failed for ${wf.id}:`, e);
               // Mark as failed to prevent infinite retry loops on API errors
               wf.status = "failed";
               store.set(wf.id, wf);
               await notifyStatus(wf, "Workflow failed during auto-approve: " + String(e));
               
               // Auto-Cleanup branch on failure
               try {
                 const branchName = wf.headRef;
                 if (branchName && branchName.startsWith("jeo/")) {
                   console.log(`[Branch Cleanup] Deleting remote branch ${branchName} for failed workflow ${wf.id}`);
                   let token = process.env.GITHUB_TOKEN;
                   if (!token && opts.sourceFactory) {
                     const secrets = await opts.sourceFactory();
                     token = secrets[`${opts.prefix}-github-token-rw`];
                   }
                   if (token && wf.repo) {
                     fetch(`https://api.github.com/repos/${wf.repo}/git/refs/heads/${branchName}`, {
                       method: "DELETE",
                       headers: { "Authorization": `Bearer ${token}`, "User-Agent": "jeo-claw-hive" }
                     }).then(r => console.log(`[Branch Cleanup] Fail-safe Result: ${r.status}`));
                   }
                 }
               } catch(cleanupErr) { console.error("[Branch Cleanup] fail-safe error:", cleanupErr); }
           }
        }

        if (wf.status === "awaiting-approval" && wf.pendingAction === "pr.merge") {
          // Fallback legacy merge logic
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
    } finally {
      isAutoMergeRunning = false;
    }
  }, 10000); // Check every 10 seconds for ultra-fast autonomous execution

  // [OOO RALPH / PERF PATCH] Self-healing and auto-polling mechanism.
  // Periodically checks the SQLite store for any 'queued' workflows that are NOT in the pendingQueue.
  // This prevents workflows from getting stuck due to memory crashes or direct database injections.

  let isAutoHealRunning = false;
  const autoHealInterval = setInterval(async () => {
      if (isAutoHealRunning) return;
      isAutoHealRunning = true;
      try {
          const activeWfs = store.getActiveWorkflows();

          // 0. Hard Lock purge: permanently remove banned targets (e.g.
          // akillness/jeo-code) that may have been injected directly into
          // SQLite. Mark terminal and evict from the queue so they are never
          // re-dispatched and never reported as "stranded" again.
          const bannedWfs = activeWfs.filter((w: any) => isBannedTarget(w.repo) && !workflowTerminal(w));
          if (bannedWfs.length > 0) {
              console.warn(`[Hard Block] Auto-Heal purging ${bannedWfs.length} banned-target workflow(s) from SQLite.`);
              for (const wf of bannedWfs) {
                  if (!wf.id) continue;
                  wf.status = "rejected";
                  store.set(wf.id, wf);
                  pendingQueue.delete(wf.id);
              }
          }

          // 1. Re-queue stranded 'queued' workflows (banned ones are now 'rejected' above).
          const queuedWfs = activeWfs.filter((w: any) => w.status === "queued" && !pendingQueue.has(w.id));
          if (queuedWfs.length > 0) {
              console.log(`[Auto-Heal] Found ${queuedWfs.length} stranded workflows in SQLite. Re-queueing...`);
              for (const wf of queuedWfs) {
                  enqueueWorkflow(wf.id, wf.repo);
              }
          }


          // 2. Detect and reset Zombie workflows (stuck in 'pending'/'running' for > 15 mins)
          const ZOMBIE_TIMEOUT_MS = 15 * 60 * 1000;
          let zombiesRescued = false;
          for (const wf of activeWfs) {
              if (wf.status === "pending" || wf.status === "running") {
                  let lastActiveTime = Date.now(); // default to now if no history
                  if (wf.history && wf.history.length > 0) {
                      const lastEntry = wf.history[wf.history.length - 1];
                      if (lastEntry.at) {
                          lastActiveTime = new Date(lastEntry.at).getTime();
                      }
                  }
                  
                  if (Date.now() - lastActiveTime > ZOMBIE_TIMEOUT_MS) {
                      console.warn(`[Auto-Heal] Zombie detected! Workflow ${wf.id} stuck in ${wf.status} for >15 mins. Resetting to queued.`);
                      wf.status = "queued";
                      store.set(wf.id, wf);
                      enqueueWorkflow(wf.id, wf.repo);

                      zombiesRescued = true;
                  }
              }
          }

          if (queuedWfs.length > 0 || zombiesRescued) {
              await processQueue(opts);
          }
      } catch(e) {
          // Silently ignore to prevent polling crashes
      } finally {
          isAutoHealRunning = false;
      }
  }, 15000);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return json(200, { ok: true });
      }
      return handleWebhookRequest(req, opts);
    },
  });

  // Attach intervals to server object for cleanup during tests
  (server as any)._autoMergeInterval = autoMergeInterval;
  (server as any)._autoHealInterval = autoHealInterval;

  const origStop = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean) => {
    clearInterval(autoMergeInterval);
    clearInterval(autoHealInterval);
    origStop(closeActiveConnections);
  };
  return server;
}


import { createHash } from "node:crypto";
import { verifySignature, parseWebhook } from "./github-webhook";

import { applyEvent, advanceStage, createWorkflow } from "./state-machine";
import { parseControlMode, type ControlMode, type WorkflowState, type ControlEvent, type HighRiskAction } from "./contract";
import { loadWriteSecretsForRole, secretSourceFromEnv, SecretAccessCleanupError, type Role, type SecretSource } from "../secrets/loader.ts";
import { executeApprovedWriteAction, type GitHubWriteDeps } from "./write-executor.ts";
import { dispatchStageWork, dispatchableStage } from "./runtime-dispatch.ts";
import { SQLiteWorkflowStore, type WorkflowStore } from "./store.ts";
import { DeliveryIdempotencyCache } from "./webhook-idempotency.ts";
import { isBannedTarget, normalizeRepo } from "./banned-targets.ts";
import { reconcileGitHubHeadEvidence } from "./head-evidence.ts";

const processControlMode = parseControlMode(process.env.JEO_CONTROL_MODE);
function ordinaryFrozen(mode?: ControlMode): boolean {
  return processControlMode === "probe-only" || mode === "probe-only";
}
const defaultStorePath = process.env.SQLITE_DB_PATH || "workflows.sqlite";
let defaultStore: SQLiteWorkflowStore | undefined;
function getDefaultStore(): SQLiteWorkflowStore {
  return defaultStore ??= new SQLiteWorkflowStore(defaultStorePath);
}
// Importing the server or injecting a probe store must not open ordinary SQLite.
export const store: WorkflowStore = {
  get: (id) => getDefaultStore().get(id),
  set: (id, state) => getDefaultStore().set(id, state),
  delete: (id) => getDefaultStore().delete(id),
  values: () => getDefaultStore().values(),
  getActiveWorkflows: () => getDefaultStore().getActiveWorkflows(),
  getRunningWorkflowsCount: () => getDefaultStore().getRunningWorkflowsCount(),
  hasDuplicateRequest: (request) => getDefaultStore().hasDuplicateRequest(request),
  get size() { return getDefaultStore().size; },
};
export const pendingQueue = new Set<string>();
// Idempotency guard for retried/redelivered GitHub webhooks (keyed by X-GitHub-Delivery).
export const deliveryIdempotency = new DeliveryIdempotencyCache();
let isProcessingQueue = false;
let queueReservations = 0;


const workflowLocks = new Map<string, Promise<void>>();
const deliveryLocks = new Map<string, Promise<void>>();

export async function withWorkflowLock<T>(workflowId: string, fn: () => Promise<T>): Promise<T> {
  return withLock(workflowLocks, workflowId, fn);
}

async function withLock<T>(locks: Map<string, Promise<void>>, workflowId: string, fn: () => Promise<T>): Promise<T> {
  const existingLock = locks.get(workflowId) || Promise.resolve();
  let releaseLock: () => void;
  const newLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const nextLock = existingLock.then(() => newLock);
  locks.set(workflowId, nextLock);
  try {
    await existingLock;
    return await fn();
  } finally {
    releaseLock!();
    if (locks.get(workflowId) === nextLock) {
      locks.delete(workflowId);
    }
  }
}
export function enqueueWorkflow(wfId: string, repo?: string) {
  if (ordinaryFrozen()) return;
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



async function notifyStatus(workflow: WorkflowState, message: string, shutdownSignal?: AbortSignal) {
  if (process.env.NODE_ENV === "test") return;
  const endpoint = process.env.JEO_STATUS_ENDPOINT;
  if (!endpoint) return;
  const secret = process.env.JEO_STATUS_RELAY_SECRET?.trim();
  if (!secret || secret === process.env.JEO_CONTROL_EVENT_SECRET?.trim()) return;
  let statusUrl: URL;
  try {
    statusUrl = new URL(endpoint);
  } catch {
    return;
  }
  if (statusUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(statusUrl.hostname) || statusUrl.username || statusUrl.password) return;
  // Auto-detect if we are in Sovereign (orchestrator) context or worker context
  // In glue/server.ts, we are always in Sovereign context.
  const claw = "🏰 Sovereign";
  const controller = new AbortController();
  const abortOnShutdown = () => controller.abort();
  if (shutdownSignal?.aborted) return;
  shutdownSignal?.addEventListener("abort", abortOnShutdown, { once: true });
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-status-relay-secret": secret },
      body: JSON.stringify({
        workflowId: workflow.id,
        runtime: workflow.runtime,
        stage: workflow.stage,
        status: workflow.status,
        headSha: workflow.headSha,
        pendingAction: workflow.pendingAction,
        message,
        repo: workflow.repo,
        claw,
      })
    });
  } catch {
    console.error("Failed to notify status");
  } finally {
    clearTimeout(timeout);
    shutdownSignal?.removeEventListener("abort", abortOnShutdown);
  }
}

function workflowId(workflow: WorkflowState): string {
  if (!workflow.id) throw new Error("Workflow is missing an id");
  return workflow.id;
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
  if (ordinaryFrozen(opts.controlMode)) return;
  if (isProcessingQueue || opts.shutdownSignal?.aborted) return;
  isProcessingQueue = true;
  try {
    while (pendingQueue.size > 0 && !opts.shutdownSignal?.aborted) {
      if (getRunningWorkflowsCount(opts.store) + queueReservations >= MAX_CONCURRENT_WORKFLOWS) break;
      const nextWfId = pendingQueue.values().next().value;
      if (nextWfId === undefined) break;
      pendingQueue.delete(nextWfId);
      if (!nextWfId) continue;

      
      const wf = opts.store.get(nextWfId);
      if (wf && wf.status === "queued") {
        queueReservations++;
        const task: Promise<void> = withWorkflowLock(nextWfId, async () => {
          queueReservations--;
          if (opts.shutdownSignal?.aborted) return;
          const current = opts.store.get(nextWfId);
          if (!current || current.status !== "queued") return;
          if (isBannedTarget(current.repo)) {
            current.status = "rejected";
            opts.store.set(nextWfId, current);
            return;
          }
          current.status = "pending";
          opts.store.set(nextWfId, current);
          try {
            const updated = await progressWorkflowState(current, opts);
            if (opts.shutdownSignal?.aborted) return;
            opts.store.set(workflowId(updated), updated);
            await notifyStatus(updated, "Workflow started from queue", opts.shutdownSignal);
          } catch (error) {
            if (error instanceof SecretAccessCleanupError) opts.cleanupFailures?.push(error);
            if (opts.shutdownSignal?.aborted) return;
            console.error("Workflow failed");
            const failedWf = opts.store.get(nextWfId) || current;
            failedWf.status = "failed";
            opts.store.set(workflowId(failedWf), failedWf);
            await notifyStatus(failedWf, "Workflow failed", opts.shutdownSignal);
          }
        }).catch(console.error).finally(() => {
          opts.inFlight?.delete(task);
          if (!opts.shutdownSignal?.aborted) processQueue(opts).catch(console.error);
        });
        opts.inFlight?.add(task);

        if (getRunningWorkflowsCount(opts.store) + queueReservations >= MAX_CONCURRENT_WORKFLOWS) {
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
  if (ordinaryFrozen()) return;
  const now = policy.now?.() ?? Date.now();
  const terminalRetentionMs = policy.terminalRetentionMs ?? DEFAULT_TERMINAL_WORKFLOW_RETENTION_MS;
  const values = storeToPrune.values();
    
  for (const workflow of values) {
    if (workflowTerminal(workflow) && now - workflowLastTouchedMs(workflow) > terminalRetentionMs) {
      storeToPrune.delete(workflowId(workflow));
      pendingQueue.delete(workflowId(workflow));
    }
  }

  const maxWorkflows = Math.max(0, policy.maxWorkflows ?? DEFAULT_MAX_WORKFLOWS);
  let currentSize = storeToPrune.size;
  if (currentSize <= maxWorkflows) return;

  // Re-fetch values only if we need to prune by size, to avoid sorting already deleted items
  const currentValues = storeToPrune.values();

  const candidatesWithTime = currentValues.filter(workflowTerminal).map(candidate => ({
    candidate,
    touchedMs: workflowLastTouchedMs(candidate)
  })).sort((a, b) => a.touchedMs - b.touchedMs);

  for (const { candidate } of candidatesWithTime) {
    if (currentSize <= maxWorkflows) break;
    storeToPrune.delete(workflowId(candidate));
    pendingQueue.delete(workflowId(candidate));
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

async function readBoundedBody(req: Request, maxBytes: number): Promise<string | undefined> {
  if (bodyTooLarge(req, maxBytes)) {
    void req.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
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
    state.actionApprovals?.["pr.merge"]?.status === "approved" &&
    typeof state.headSha === "string" && /^[0-9a-f]{40}$/.test(state.headSha) &&
    state.actionApprovals["pr.merge"]?.headSha === state.headSha
  );
}

function brokerRequestMismatch(body: RuntimeDispatchPayload, workflow: WorkflowState): string | undefined {
  if (workflow.webhookPendingDigest !== undefined) return "Workflow requires webhook recovery";
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
  controlMode?: ControlMode;
  controlEventSecret: string;
  prefix: string;
  sourceFactory: () => SecretSource;
  storePolicy?: WorkflowStorePolicy;
  shutdownSignal?: AbortSignal;
}

interface WorkflowExecutionOpts extends WorkflowBrokerOpts {
  writeDeps: GitHubWriteDeps;
  runtimeDispatchSecret: string;
  dispatchFetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Override the default delivery idempotency guard (mainly for tests). */
  deliveryCache?: DeliveryIdempotencyCache;
  inFlight?: Set<Promise<unknown>>;
  cleanupFailures?: Error[];
  reconcileHeadEvidence?: typeof reconcileGitHubHeadEvidence;
}

async function brokerApprovedWriteCredentials(
  workflow: WorkflowState,
  action: HighRiskAction,
  opts: WorkflowBrokerOpts,
): Promise<{ role: Role; credentials: Record<string, string> }> {
  if (ordinaryFrozen(opts.controlMode)) throw new Error("Ordinary workflows frozen in probe-only mode");
  if (action === "pr.merge") {
    throw new Error("Merge disabled: effective GitHub policy cannot yet be verified safely");
  }
  const role = roleForAction(action);
  if (!role) {
    throw new Error(`Unsupported broker action: ${action}`);
  }
  const approval = workflow.actionApprovals?.[action];
  if (approval?.status !== "approved") {
    throw new Error(`Action ${action} is not approved`);
  }
  const credentials = await loadWriteSecretsForRole(role, opts.sourceFactory(), { prefix: opts.prefix, signal: opts.shutdownSignal });
  return { role, credentials };
}

async function maybeExecuteApprovedWriteTransition(
  state: WorkflowState,
  opts: WorkflowExecutionOpts,
): Promise<WorkflowState | undefined> {
  if (ordinaryFrozen(opts.controlMode)) throw new Error("Ordinary workflows frozen in probe-only mode");
  const id = workflowId(state);
  if (readyForCreate(state)) {
    const { credentials } = await brokerApprovedWriteCredentials(state, "pr.create", opts);
    const writeToken = credentials.GITHUB_TOKEN;
    if (!writeToken) throw new Error("Approved PR-create token missing");
    opts.shutdownSignal?.throwIfAborted();
    const executed = await executeApprovedWriteAction(state, "pr.create", writeToken, opts.writeDeps);
    const advanced = advanceStage(executed.workflow);
    opts.store.set(id, advanced);
    return advanced;
  }

  if (readyForMerge(state)) {
    const { credentials } = await brokerApprovedWriteCredentials(state, "pr.merge", opts);
    const writeToken = credentials.GITHUB_TOKEN;
    if (!writeToken) throw new Error("Approved merge token missing");
    opts.shutdownSignal?.throwIfAborted();
    const executed = await executeApprovedWriteAction(state, "pr.merge", writeToken, opts.writeDeps);
    const advanced = advanceStage(executed.workflow);
    opts.store.set(id, advanced);
    return advanced;
  }

  return undefined;
}
async function maybeDispatchStageTransition(
  state: WorkflowState,
  opts: WorkflowExecutionOpts,
): Promise<WorkflowState | undefined> {
  if (ordinaryFrozen(opts.controlMode)) throw new Error("Ordinary workflows frozen in probe-only mode");
  if (!dispatchableStage(state.stage)) return undefined;
  await dispatchStageWork(state, {
    runtimeDispatchSecret: opts.runtimeDispatchSecret,
    fetchImpl: opts.dispatchFetchImpl,
    shutdownSignal: opts.shutdownSignal,
  });
  opts.shutdownSignal?.throwIfAborted();
  return advanceStage(state);
}


async function progressWorkflowState(state: WorkflowState, opts: WorkflowExecutionOpts): Promise<WorkflowState> {
  if (ordinaryFrozen(opts.controlMode)) throw new Error("Ordinary workflows frozen in probe-only mode");
  let current = state;
  while (true) {
    opts.shutdownSignal?.throwIfAborted();
    if (current.status === "merged" || current.status === "rejected" || current.status === "failed") {
      if (current.status !== state.status) {
        await notifyStatus(current, `Workflow reached terminal state: ${current.status}`, opts.shutdownSignal);
      }
      return current;
    }

    const dispatched = await maybeDispatchStageTransition(current, opts);
    if (dispatched) {
      current = dispatched;
      continue;
    }

    const executed = await maybeExecuteApprovedWriteTransition(current, opts);
    opts.shutdownSignal?.throwIfAborted();
    if (executed) {
      current = executed;
      continue;
    }

    const advanced = advanceStage(current);
    if (advanced.status === "merged") return current;
    if (advanced.stage !== state.stage || advanced.status !== state.status) {
      if (advanced.status === "awaiting-approval" && advanced.pendingAction) {
        await notifyStatus(advanced, `Approval required for ${advanced.pendingAction} at stage ${advanced.stage}`, opts.shutdownSignal);
      } else if (advanced.status !== "awaiting-approval") {
        await notifyStatus(advanced, `Workflow advanced to ${advanced.stage} (${advanced.status})`, opts.shutdownSignal);
      }
    }
    opts.shutdownSignal?.throwIfAborted();
    return advanced;
  }
}

export async function handleControlDispatchRequest(
  req: Request,
  opts: WorkflowBrokerOpts,
): Promise<Response> {
  if (opts.shutdownSignal?.aborted) return json(503, { error: "Server is shutting down" });
  if (!requireControlSecret(opts.controlEventSecret, req.headers.get("x-control-event-secret"))) {
    return json(401, { error: "Unauthorized" });
  }

  let payload: unknown;
  try {
    const body = await readBoundedBody(req, MAX_WEBHOOK_BODY_BYTES);
    if (body === undefined) return json(413, { error: "Payload too large" });
    payload = JSON.parse(body);
  } catch {
    return json(400, { error: "Invalid JSON" });
  }
  if (opts.shutdownSignal?.aborted) return json(503, { error: "Server is shutting down" });
  if (ordinaryFrozen(opts.controlMode)) return json(403, { error: "Ordinary workflows frozen in probe-only mode", reason: "probe-only" });

  const validation = validateRuntimeDispatchPayload(payload);
  if (!validation.ok) {
    return json(400, { error: validation.reason });
  }

  const body = payload as RuntimeDispatchPayload;
  if (body.action === "pr.merge") return json(503, { error: "Merge is disabled pending GitHub policy verification" });
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
    opts.store.set(workflowId(updated), updated);
    await notifyStatus(updated, `Action ${body.action} consumed`, opts.shutdownSignal);
    // Memory Leak Fix: Remove terminal workflows from pendingQueue
    // Optimized: We only need to check the current workflow, processQueue handles the rest.
    if (workflowTerminal(updated)) {
      pendingQueue.delete(workflowId(updated));
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
  if (opts.shutdownSignal?.aborted) return json(503, { error: "Server is shutting down" });
  const providedSecret = req.headers.get("x-control-event-secret");
  if (!requireControlSecret(opts.controlEventSecret, providedSecret)) {
    return json(401, { error: "Unauthorized" });
  }

  let event: ControlEvent;
  try {
    const body = await readBoundedBody(req, MAX_WEBHOOK_BODY_BYTES);
    if (body === undefined) return json(413, { error: "Payload too large" });
    event = JSON.parse(body) as ControlEvent;
  } catch {
    return json(400, { error: "Invalid JSON" });
  }
  if (opts.shutdownSignal?.aborted) return json(503, { error: "Server is shutting down" });
  if (!event || typeof event !== "object" || Array.isArray(event)) return json(400, { error: "Invalid control event" });
  if (ordinaryFrozen(opts.controlMode) && event.type !== "ping") return json(409, { error: "Ordinary workflows frozen in probe-only mode", reason: "probe-only" });

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

    const maxWorkflows = Math.max(1, opts.storePolicy?.maxWorkflows ?? DEFAULT_MAX_WORKFLOWS);
    pruneWorkflowStore(opts.store, { ...opts.storePolicy, maxWorkflows: maxWorkflows - 1 });
    if (opts.store.size >= maxWorkflows) {
      return json(503, { success: false, error: "Workflow capacity reached" });
    }

    const wf = createWorkflow(wfId, event.runtime, event.request, targetRepo);
    wf.status = "queued";
    opts.store.set(wfId, wf);
    enqueueWorkflow(wfId, wf.repo);
    await notifyStatus(wf, "Workflow queued", opts.shutdownSignal);


    if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {
      processQueue(opts as WorkflowExecutionOpts).catch(console.error);
    }

    pruneWorkflowStore(opts.store, opts.storePolicy);
    return json(201, { success: true, workflow: wf, queuePosition: pendingQueue.size });

  }

  if (event.type === "approve" || event.type === "reject") {
    if (event.source !== "discord") {
      return json(403, { error: "Approval decisions must originate from Discord" });
    }
    const allowedKeys = event.type === "approve"
      ? ["type", "source", "workflowId", "action", "user", "headSha"]
      : ["type", "source", "workflowId", "action", "user"];
    if (Object.keys(event).some((key) => !allowedKeys.includes(key))) {
      return json(400, { error: "Unexpected approval fields" });
    }
    const wf = opts.store.get(event.workflowId);
    if (!wf) {
      return json(404, { error: "Workflow not found" });
    }
    let updated;
    try {
      updated = await withWorkflowLock(workflowId(wf), async () => {
        opts.shutdownSignal?.throwIfAborted();
        const currentState = opts.store.get(workflowId(wf)) || wf;
        if (currentState.webhookPendingDigest !== undefined) throw new Error("Workflow requires webhook recovery");
        let updatedState = applyEvent(currentState, event);
        if (updatedState !== currentState) {
          opts.store.set(workflowId(updatedState), updatedState);
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
            shutdownSignal: opts.shutdownSignal,
          });
          opts.shutdownSignal?.throwIfAborted();
          opts.store.set(workflowId(updatedState), updatedState);
        }
        if (workflowTerminal(updatedState)) {
          pendingQueue.delete(workflowId(updatedState));
        }
        return updatedState;
      });
    } catch (err) {
      if (err instanceof SecretAccessCleanupError) opts.cleanupFailures?.push(err);
      console.error("Error processing control event workflow state:", err);
      return json(500, { error: "Internal server error processing workflow" });
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
  if (opts.shutdownSignal?.aborted) return json(503, { error: "Server is shutting down" });
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    return json(200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/debug/workflows") {
    if (!requireControlSecret(opts.controlEventSecret, req.headers.get("x-control-event-secret"))) {
      return json(401, { error: "Unauthorized" });
    }
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

  const signatureHeader = req.headers.get("x-hub-signature-256") || req.headers.get("x-hub-signature") || "";
  let rawBody: string | undefined;
  try {
    rawBody = await readBoundedBody(req, MAX_WEBHOOK_BODY_BYTES);
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  if (rawBody === undefined) return json(413, { error: "Webhook payload too large" });

  if (!verifySignature(rawBody, signatureHeader, opts.secret)) {
    return json(401, { error: "Unauthorized" });
  }
  if (ordinaryFrozen(opts.controlMode)) return json(409, { error: "Ordinary workflows frozen in probe-only mode", reason: "probe-only" });

  const deliveryId = req.headers.get("x-github-delivery");
  const processDelivery = async (): Promise<Response> => {

  let parsed;
  try {
    parsed = parseWebhook(rawBody!);
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const payload: unknown = JSON.parse(rawBody!);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json(400, { error: "Invalid webhook payload" });
  }
  const fields = payload as Record<string, unknown>;
  const repository = fields.repository;
  const repo = repository && typeof repository === "object" && !Array.isArray(repository)
    ? (repository as Record<string, unknown>).full_name : undefined;
  const pull = fields.pull_request;
  const suite = fields.check_suite;
  const suitePulls = suite && typeof suite === "object" && !Array.isArray(suite)
    ? (suite as Record<string, unknown>).pull_requests : undefined;
  const signedPull = pull && typeof pull === "object" && !Array.isArray(pull)
    ? pull : Array.isArray(suitePulls) && suitePulls.length === 1 ? suitePulls[0] : undefined;
  const prNumber = signedPull && typeof signedPull === "object" && !Array.isArray(signedPull)
    ? (signedPull as Record<string, unknown>).number : undefined;
  const pullFields = pull && typeof pull === "object" && !Array.isArray(pull) ? pull as Record<string, unknown> : undefined;
  const pullHead = pullFields?.head;
  const syncSha = pullHead && typeof pullHead === "object" && !Array.isArray(pullHead)
    ? (pullHead as Record<string, unknown>).sha : undefined;
  const isSync = !fields.review && (fields.action === "opened" || fields.action === "reopened" || fields.action === "synchronize");
  if (isSync && (typeof syncSha !== "string" || !/^[0-9a-f]{40}$/.test(syncSha))) {
    return json(400, { error: "A valid signed PR head is required" });
  }
  if (typeof repo !== "string" || !repo.trim() || !Number.isSafeInteger(prNumber) || (prNumber as number) <= 0) {
    return json(400, { error: "Signed repository and pull request are required" });
  }
  parsed.prNumber = prNumber as number;
  const matches = opts.store.values().filter((state) =>
    normalizeRepo(state.repo || opts.writeDeps.targetRepo) === normalizeRepo(repo) &&
    state.prNumber === prNumber && (!parsed.workflowId || state.id === parsed.workflowId));
  if (matches.length > 1) return json(409, { error: "Ambiguous webhook workflow" });
  const workflowState = matches[0];

  if (workflowState) {
    const workflowId = workflowState.id;
    if (!workflowId) return json(500, { error: "Workflow is missing an id" });
    let nextState;
    const digest = createHash("sha256").update(rawBody!).digest("hex");
    try {
      nextState = await withWorkflowLock(workflowId, async () => {
        opts.shutdownSignal?.throwIfAborted();
        // Re-read state inside the lock to prevent race conditions
        const currentState = opts.store.get(workflowId);
        if (!currentState || normalizeRepo(currentState.repo || opts.writeDeps.targetRepo) !== normalizeRepo(repo) || currentState.prNumber !== prNumber) {
          throw new Error("Webhook workflow identity changed");
        }
        const digests = currentState.webhookDigests ?? [];
        if (!Array.isArray(digests) || digests.some((value) => typeof value !== "string")) {
          throw new Error("Invalid webhook replay ledger");
        }
        if (currentState.webhookPendingDigest !== undefined) {
          throw new Error("A previous webhook requires explicit recovery");
        }
        if (digests.includes(digest)) return currentState;
        if (digests.length >= 10000) throw new Error("Webhook replay ledger is full");
        let base = currentState;
        if (isSync && typeof syncSha === "string" && syncSha !== currentState.headSha) {
          base = { ...currentState, headSha: syncSha, ciPassed: false, reviewPassed: false, approved: false,
            actionApprovals: { ...currentState.actionApprovals, "pr.merge": { status: "pending" } } };
        }
        if (parsed.ciPassed === true || parsed.reviewPassed === true) {
          throw new Error("Positive evidence cannot yet be verified safely");
        }
        let updatedState: WorkflowState = { ...applyEvent(base, parsed), webhookDigests: [...digests, digest], webhookPendingDigest: digest };
        opts.store.set(workflowId, updatedState);
        updatedState = await progressWorkflowState(updatedState, opts);
        opts.shutdownSignal?.throwIfAborted();
        delete updatedState.webhookPendingDigest;
        opts.store.set(workflowId, updatedState);
        if (workflowTerminal(updatedState)) {
          pendingQueue.delete(workflowId);
        }
        return updatedState;
      });
    } catch (err) {
      // Failed deliveries are retryable. Preserve any idempotent write receipt
      // produced before the failure, but release this payload's replay marker.
      const failedState = opts.store.get(workflowId);
      if (failedState?.webhookPendingDigest === digest) {
        const retryableState: WorkflowState = {
          ...failedState,
          webhookDigests: (failedState.webhookDigests ?? []).filter((value) => value !== digest),
        };
        delete retryableState.webhookPendingDigest;
        opts.store.set(workflowId, retryableState);
      }
      if (err instanceof SecretAccessCleanupError) opts.cleanupFailures?.push(err);
      if (err instanceof Error && (err.message.startsWith("Positive evidence") || err.message.startsWith("GitHub evidence") || err.message.startsWith("Pull request head"))) {
        return json(503, { error: err.message });
      }
      console.error("Error processing webhook workflow state:", err);
      return json(500, { error: "Internal server error processing workflow" });
    }
    pruneWorkflowStore(opts.store, opts.storePolicy);
    processQueue(opts).catch(console.error);
    return json(200, { success: true, workflow: nextState });
  }

  return json(202, { success: false, message: "No matching workflow found" });
  };
  if (!deliveryId) return processDelivery();
  return withLock(deliveryLocks, deliveryId, async () => {
    const cache = opts.deliveryCache ?? deliveryIdempotency;
    if (cache.has(deliveryId)) {
      return json(200, { success: true, deduplicated: true, deliveryId });
    }
    const response = await processDelivery();
    if (response.status === 200) cache.check(deliveryId);
    return response;
  });
}

export function start(options: { controlMode?: ControlMode; store?: WorkflowStore; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval; dispatchFetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; sourceFactory?: () => SecretSource } = {}) {
  const controlMode = parseControlMode(options.controlMode ?? process.env.JEO_CONTROL_MODE);
  if (processControlMode === "probe-only" && controlMode !== "probe-only") throw new Error("Cannot override probe-only control mode");
  const selectedStore = options.store ?? (controlMode === "normal" ? getDefaultStore() : new SQLiteWorkflowStore(":memory:"));

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
  if (controlMode === "normal" && (!project || !prefix || !targetRepo || !targetBranch || !runtimeDispatchSecret)) {
    throw new Error("GCLOUD_PROJECT, GCLOUD_SECRET_PREFIX, TARGET_REPO, TARGET_BRANCH, and JEO_RUNTIME_DISPATCH_SECRET are required");
  }
  if (process.env.JEO_STATUS_ENDPOINT) {
    const statusSecret = process.env.JEO_STATUS_RELAY_SECRET?.trim();
    if (!statusSecret || statusSecret.length < 24 || [secret, controlEventSecret, runtimeDispatchSecret].includes(statusSecret)) {
      throw new Error("JEO_STATUS_RELAY_SECRET must be at least 24 characters and distinct from other secrets");
    }
  }

  const shutdownController = new AbortController();
  const opts: WorkflowExecutionOpts & { secret: string } = {
    secret,
    controlMode,
    controlEventSecret,
    prefix: prefix ?? "",
    sourceFactory: controlMode === "probe-only" ? () => { throw new Error("Ordinary secrets unavailable in probe-only mode"); } : options.sourceFactory ?? (() => secretSourceFromEnv(process.env, project!)),
    writeDeps: {
      targetRepo: targetRepo ?? "",
      targetBranch: targetBranch ?? "",
      apiBaseUrl: githubApiBaseUrl,
    },
    runtimeDispatchSecret: runtimeDispatchSecret ?? "",
    dispatchFetchImpl: options.dispatchFetchImpl,
    store: selectedStore,
    shutdownSignal: shutdownController.signal,
    inFlight: new Set(),
    cleanupFailures: [],
  };

  const server = Bun.serve({
    port,
    maxRequestBodySize: MAX_WEBHOOK_BODY_BYTES,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return json(200, { ok: true });
      }
      const task = handleWebhookRequest(req, opts);
      opts.inFlight!.add(task);
      try {
        return await task;
      } finally {
        opts.inFlight!.delete(task);
      }
    },
  });

  // [OOO RALPH / PERF PATCH] Self-healing and auto-polling mechanism.
  // Periodically checks the SQLite store for any 'queued' workflows that are NOT in the pendingQueue.
  // This prevents workflows from getting stuck due to memory crashes or direct database injections.

  let isAutoHealRunning = false;
  const autoHealInterval = controlMode === "normal" ? (options.setInterval ?? setInterval)(async () => {
      if (isAutoHealRunning || shutdownController.signal.aborted) return;
      isAutoHealRunning = true;
      try {
          const activeWfs = selectedStore.getActiveWorkflows();

          // 0. Hard Lock purge: permanently remove banned targets (e.g.
          // akillness/jeo-code) that may have been injected directly into
          // SQLite. Mark terminal and evict from the queue so they are never
          // re-dispatched and never reported as "stranded" again.
          const bannedWfs = activeWfs.filter((w: WorkflowState) => w.id && !workflowLocks.has(w.id) && isBannedTarget(w.repo) && !workflowTerminal(w));
          if (bannedWfs.length > 0) {
              console.warn(`[Hard Block] Auto-Heal purging ${bannedWfs.length} banned-target workflow(s) from SQLite.`);
              for (const wf of bannedWfs) {
                  if (!wf.id) continue;
                  wf.status = "rejected";
                  selectedStore.set(wf.id, wf);
                  pendingQueue.delete(wf.id);
              }
          }

          // 1. Re-queue stranded 'queued' workflows (banned ones are now 'rejected' above).
          const queuedWfs = activeWfs.filter((w: WorkflowState) => w.id && w.status === "queued" && !pendingQueue.has(w.id) && !workflowLocks.has(w.id));
          if (queuedWfs.length > 0) {
              console.log(`[Auto-Heal] Found ${queuedWfs.length} stranded workflows in SQLite. Re-queueing...`);
              for (const wf of queuedWfs) {
                  enqueueWorkflow(workflowId(wf), wf.repo);
              }
          }


          // Elapsed time cannot establish that an external worker is dead.
          if (pendingQueue.size > 0) await processQueue(opts);
      } catch(e) {
          // Silently ignore to prevent polling crashes
      } finally {
          isAutoHealRunning = false;
      }
  }, 15000) : undefined;

  (server as any)._autoHealInterval = autoHealInterval;

  const origStop = server.stop.bind(server);
  let stopPromise: Promise<void> | undefined;
  let forceRequested = false;
  server.stop = (closeActiveConnections?: boolean) => {
    if (stopPromise) {
      if (closeActiveConnections && !forceRequested) {
        forceRequested = true;
        const forcedStop = origStop(true);
        stopPromise = Promise.allSettled([stopPromise, forcedStop]).then((results) => {
          const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
          if (failures.length) throw new AggregateError(failures, "Workflow shutdown failed");
        });
      }
      return stopPromise;
    }
    shutdownController.abort();
    if (autoHealInterval !== undefined) (options.clearInterval ?? clearInterval)(autoHealInterval);
    forceRequested = closeActiveConnections === true;
    stopPromise = Promise.allSettled([origStop(closeActiveConnections), ...opts.inFlight!]).then((results) => {
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      failures.push(...opts.cleanupFailures!);
      if (failures.length) throw new AggregateError(failures, "Workflow shutdown failed");
    });
    return stopPromise;
  };
  return server;
}

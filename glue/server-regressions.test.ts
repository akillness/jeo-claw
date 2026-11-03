import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { enqueueWorkflow, handleControlEventRequest, handleWebhookRequest, pendingQueue, pruneWorkflowStore, withWorkflowLock } from "./server.ts";
import { createWorkflow } from "./state-machine.ts";
import { SQLiteWorkflowStore } from "./store.ts";
import { DeliveryIdempotencyCache } from "./webhook-idempotency.ts";

function fakeFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: () => { throw new Error("unexpected preconnect"); } });
}

const secret = "test-control-secret";
const webhookSecret = "test-webhook-secret";
const options = (store: SQLiteWorkflowStore) => ({
  secret: webhookSecret, controlEventSecret: secret, store, prefix: "test",
  sourceFactory: () => ({ access: async () => { throw new Error("unexpected credential request"); } }),
  writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
  runtimeDispatchSecret: "test-dispatch-secret",
});

test("store size pruning preserves queued, running and approval-pending workflows", () => {
  const store = new SQLiteWorkflowStore(":memory:");
  for (const [id, status] of [["queued", "queued"], ["running", "running"], ["approval", "awaiting-approval"], ["done", "merged"]] as const) {
    const wf = createWorkflow(id, "zeroclaw", id);
    wf.status = status;
    wf.history = [{ stage: wf.stage, status, at: "2020-01-01T00:00:00.000Z" }];
    store.set(id, wf);
  }
  pruneWorkflowStore(store, { maxWorkflows: 1, terminalRetentionMs: 1000, now: () => Date.parse("2026-01-01T00:00:00Z") });
  expect(store.get("queued")?.status).toBe("queued");
  expect(store.get("running")?.status).toBe("running");
  expect(store.get("approval")?.status).toBe("awaiting-approval");
  expect(store.get("done")).toBeUndefined();
});

test("debug workflow details require the control secret", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  store.set("wf-debug-auth", createWorkflow("wf-debug-auth", "zeroclaw", "private request", "acme/repo"));
  const opts = options(store);
  const denied = await handleWebhookRequest(new Request("http://localhost/debug/workflows"), opts);
  expect(denied.status).toBe(401);
  expect(await denied.text()).not.toContain("private request");
  const allowed = await handleWebhookRequest(new Request("http://localhost/debug/workflows", {
    headers: { "x-control-event-secret": secret },
  }), opts);
  expect(allowed.status).toBe(200);
  const payload = await allowed.json() as { workflows: { request: string }[] };
  expect(payload.workflows[0]?.request).toBe("private request");
});

test("failed webhook delivery is reprocessed on retry rather than acknowledged as duplicate", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const wf = createWorkflow("wf-delivery-failed", "zeroclaw", "change", "acme/repo");
  wf.stage = "pr-review-schedule";
  wf.prNumber = 77;
  store.set(wf.id!, wf);
  let attempts = 0;
  const dispatchFetchImpl = fakeFetch(async () => { attempts++; return Response.json({ error: "temporary failure" }, { status: 503 }); });
  const opts = { ...options(store), deliveryCache: new DeliveryIdempotencyCache(), dispatchFetchImpl };
  const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 77 } });
  const signature = createHmac("sha256", webhookSecret).update(body).digest("hex");
  const request = () => new Request("http://localhost/webhook", { method: "POST",
    headers: { "x-hub-signature-256": `sha256=${signature}`, "x-github-delivery": "delivery-failure" }, body });
  expect((await handleWebhookRequest(request(), opts)).status).toBe(500);
  const retry = await handleWebhookRequest(request(), opts);
  expect(retry.status).toBe(500);
  expect(attempts).toBe(2);
  expect(store.get(wf.id!)?.stage).toBe("pr-review-schedule");
});

test("a concurrent duplicate retries after the first delivery fails", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const wf = createWorkflow("wf-delivery-concurrent", "zeroclaw", "change", "acme/repo");
  wf.stage = "pr-review-schedule";
  wf.prNumber = 78;
  store.set(wf.id!, wf);
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  const dispatchFetchImpl = fakeFetch(async () => {
    attempts++;
    if (attempts === 1) { entered(); await blocked; }
    return Response.json({ error: "temporary failure" }, { status: 503 });
  });
  const opts = { ...options(store), deliveryCache: new DeliveryIdempotencyCache(), dispatchFetchImpl };
  const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 78 } });
  const signature = createHmac("sha256", webhookSecret).update(body).digest("hex");
  const request = () => new Request("http://localhost/webhook", { method: "POST",
    headers: { "x-hub-signature-256": `sha256=${signature}`, "x-github-delivery": "delivery-concurrent" }, body });
  const first = handleWebhookRequest(request(), opts);
  await firstEntered;
  const second = handleWebhookRequest(request(), opts);
  release();
  expect((await first).status).toBe(500);
  expect((await second).status).toBe(500);
  expect(attempts).toBe(2);
});

test("a queued workflow starts after an occupied slot is released", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const capacity = Number(process.env.MAX_CONCURRENT_WORKFLOWS || "5");
  for (let index = 1; index < capacity; index++) {
    const active = createWorkflow(`wf-occupied-${index}`, "zeroclaw", `occupied ${index}`, "acme/repo");
    store.set(active.id!, active);
  }
  const abort = new AbortController();
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const requests: string[] = [];
  const dispatchFetchImpl = fakeFetch(async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    requests.push(payload.request);
    if (payload.request === "queue-first") {
      firstEntered();
      await firstBlocked;
    }
    return Response.json({ error: "test failure" }, { status: 503 });
  });
  const opts = { ...options(store), dispatchFetchImpl, shutdownSignal: abort.signal };
  const submit = (request: string) => handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": secret, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "request", runtime: "zeroclaw", request, repo: "acme/repo" }),
  }), opts);
  const firstId = "wf-queue-first-regression";
  const first = createWorkflow(firstId, "zeroclaw", "queue-first", "acme/repo");
  first.status = "queued";
  store.set(firstId, first);
  enqueueWorkflow(firstId, first.repo);
  let secondId = "";
  try {
    const second = await submit("queue-second");
    const secondBody = await second.json() as { workflow: { id: string } };
    secondId = secondBody.workflow.id;
    await entered;
    expect(store.get(secondId)?.status).toBe("queued");
    releaseFirst();
    await withWorkflowLock(firstId, async () => {});
    await withWorkflowLock(secondId, async () => {});
    expect(requests).toEqual(["queue-first", "queue-second"]);
    expect(store.get(secondId)?.status).toBe("failed");
  } finally {
    abort.abort();
    releaseFirst();
    if (firstId) await withWorkflowLock(firstId, async () => {});
    if (secondId) await withWorkflowLock(secondId, async () => {});
    pendingQueue.delete(firstId);
    pendingQueue.delete(secondId);
  }
});

test("shutdown while a control body is arriving prevents workflow creation", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const shutdown = new AbortController();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      entered();
      await blocked;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "request", runtime: "zeroclaw", request: "late work", repo: "acme/repo" })));
      controller.close();
    },
  });
  const response = handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": secret }, body,
  }), { store, controlEventSecret: secret, shutdownSignal: shutdown.signal });
  await reading;
  shutdown.abort();
  release();
  expect((await response).status).toBe(503);
  expect(store.size).toBe(0);
});

test("capacity admission rejects new work without evicting active workflows", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const running = createWorkflow("wf-cap-running", "zeroclaw", "running", "acme/repo");
  const pending = createWorkflow("wf-cap-approval", "nullclaw", "approval", "acme/repo");
  pending.status = "awaiting-approval";
  const done = createWorkflow("wf-cap-done", "zeroclaw", "done", "acme/repo");
  done.status = "merged";
  store.set(running.id!, running);
  store.set(pending.id!, pending);
  store.set(done.id!, done);
  const response = await handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": secret, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "new capacity request", repo: "acme/repo" }),
  }), { store, controlEventSecret: secret, storePolicy: { maxWorkflows: 2 } });
  const result = await response.json() as { workflow?: { id?: string } };
  try {
    expect(response.status).toBe(503);
    expect(store.get(running.id!)?.status).toBe("running");
    expect(store.get(pending.id!)?.status).toBe("awaiting-approval");
    expect(store.get(done.id!)).toBeUndefined();
    expect(store.values().map((wf) => wf.request).sort()).toEqual(["approval", "running"]);
  } finally {
    if (result.workflow?.id) pendingQueue.delete(result.workflow.id);
  }
});

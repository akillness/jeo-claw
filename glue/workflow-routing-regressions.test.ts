import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { enqueueWorkflow, handleControlDispatchRequest, handleControlEventRequest, handleWebhookRequest, pendingQueue, withWorkflowLock } from "./server.ts";
import { createWorkflow } from "./state-machine.ts";
import { SQLiteWorkflowStore } from "./store.ts";
import { DeliveryIdempotencyCache } from "./webhook-idempotency.ts";

const secret = "test-webhook-secret";
const controlSecret = "test-control-secret";
const options = (store: SQLiteWorkflowStore) => ({
  store, secret, controlEventSecret: controlSecret, prefix: "test", runtimeDispatchSecret: "test-dispatch",
  sourceFactory: () => ({ access: async () => { throw new Error("unexpected secret access"); } }),
  writeDeps: { targetRepo: "acme/repo", targetBranch: "main", fetchImpl: async () => { throw new Error("unexpected GitHub write"); } },
  dispatchFetchImpl: async () => Response.json({ error: "unavailable" }, { status: 503 }),
  deliveryCache: new DeliveryIdempotencyCache(),
});

const signed = (body: string, url: string, delivery: string) => new Request(url, {
  method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`, "x-github-delivery": delivery }, body,
});

test("signed event for one repository cannot alter a different repository with the same PR number", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const other = createWorkflow("wf-other-repo", "zeroclaw", "other", "elsewhere/repo");
  other.stage = "merge"; other.prNumber = 42; other.reviewPassed = true;
  const target = createWorkflow("wf-target-repo", "zeroclaw", "target", "acme/repo");
  target.stage = "merge"; target.prNumber = 42; target.reviewPassed = true;
  store.set(other.id!, other); store.set(target.id!, target);
  const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 42 }, review: { state: "changes_requested" } });
  await handleWebhookRequest(signed(body, "http://localhost/webhook", "repo-routing"), options(store));
  expect(store.get(other.id!)?.reviewPassed).toBe(true);
  expect(store.get(other.id!)?.status).toBe("running");
  expect(store.get(target.id!)?.reviewPassed).toBe(false);
});

test("an unsigned query parameter cannot redirect a signed event or its replay to another workflow", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const target = createWorkflow("wf-signed", "zeroclaw", "target", "acme/repo");
  target.stage = "merge"; target.prNumber = 42; target.reviewPassed = true;
  const victim = createWorkflow("wf-victim", "zeroclaw", "victim", "other/repo");
  victim.stage = "merge"; victim.prNumber = 43; victim.reviewPassed = true;
  store.set(target.id!, target); store.set(victim.id!, victim);
  const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 42 }, review: { state: "changes_requested" } });
  const opts = options(store);
  await handleWebhookRequest(signed(body, "http://localhost/webhook?workflowId=wf-victim", "delivery-one"), opts);
  await handleWebhookRequest(signed(body, "http://localhost/webhook?workflowId=wf-victim", "delivery-replay"), opts);
  expect(store.get(victim.id!)?.reviewPassed).toBe(true);
  expect(store.get(victim.id!)?.status).toBe("running");
  expect(store.get(target.id!)?.reviewPassed).toBe(false);
});

test("a previously applied review event cannot be replayed after the delivery cache is reset", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const wf = createWorkflow("wf-review-replay", "zeroclaw", "change", "acme/repo");
  wf.stage = "merge"; wf.prNumber = 55; wf.reviewPassed = true;
  store.set(wf.id!, wf);
  const opts = options(store);
  const rejection = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 55 }, review: { state: "changes_requested" } });
  const first = await handleWebhookRequest(signed(rejection, "http://localhost/webhook", "review-original"), opts);
  expect(first.status).toBe(200);
  expect(store.get(wf.id!)?.reviewPassed).toBe(false);
  const refreshed = store.get(wf.id!)!;
  refreshed.reviewPassed = true;
  store.set(wf.id!, refreshed);
  await handleWebhookRequest(signed(rejection, "http://localhost/webhook", "review-replay-new-id"), options(store));
  expect(store.get(wf.id!)?.reviewPassed).toBe(true);
});

test("an approval for an unverified old commit cannot establish review evidence", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const wf = createWorkflow("wf-old-head", "zeroclaw", "change", "acme/repo");
  wf.stage = "merge"; wf.prNumber = 56; wf.reviewPassed = false;
  store.set(wf.id!, wf);
  const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 56, head: { sha: "old-head" } }, review: { state: "approved", commit_id: "old-head" } });
  const response = await handleWebhookRequest(signed(body, "http://localhost/webhook", "old-head"), options(store));
  expect(response.status).toBe(503);
  expect(store.get(wf.id!)?.reviewPassed).toBe(false);
});

test("a full durable replay ledger rejects new evidence without changing the workflow", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const wf = createWorkflow("wf-full-ledger", "zeroclaw", "change", "acme/repo");
  wf.stage = "merge"; wf.prNumber = 57; wf.reviewPassed = true;
  wf.webhookDigests = Array.from({ length: 10000 }, (_, index) => index.toString(16).padStart(64, "0"));
  store.set(wf.id!, wf);
  const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 57 }, review: { state: "changes_requested" } });
  const response = await handleWebhookRequest(signed(body, "http://localhost/webhook", "ledger-overflow"), options(store));
  expect(response.status).toBe(500);
  expect(store.get(wf.id!)?.reviewPassed).toBe(true);
  expect(store.get(wf.id!)?.webhookDigests).toEqual(wf.webhookDigests);
});

test("a workflow rejected while its queue entry waits on a lock is not dispatched or resurrected", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const wf = createWorkflow("wf-queued-race", "zeroclaw", "queued work", "acme/repo");
  wf.status = "queued"; store.set(wf.id!, wf);
  let entered!: () => void;
  const locked = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const holder = withWorkflowLock(wf.id!, async () => {
    entered(); await blocked;
    const current = store.get(wf.id!)!;
    current.status = "rejected";
    store.set(wf.id!, current);
  });
  await locked;
  let dispatches = 0;
  const abort = new AbortController();
  const opts = { ...options(store), shutdownSignal: abort.signal, dispatchFetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
    if (JSON.parse(String(init?.body)).workflowId === wf.id) dispatches++;
    return Response.json({ error: "unexpected dispatch" }, { status: 503 });
  } };
  enqueueWorkflow(wf.id!, wf.repo);
  let otherId = "";
  try {
    const response = await handleControlEventRequest(new Request("http://localhost/control-event", {
      method: "POST", headers: { "x-control-event-secret": controlSecret, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "separate queue trigger", repo: "acme/repo" }),
    }), opts);
    otherId = ((await response.json()) as { workflow: { id: string } }).workflow.id;
    release();
    await holder;
    await withWorkflowLock(wf.id!, async () => {});
    expect(store.get(wf.id!)?.status).toBe("rejected");
    expect(dispatches).toBe(0);
  } finally {
    abort.abort(); release(); await holder;
    await withWorkflowLock(wf.id!, async () => {});
    if (otherId) await withWorkflowLock(otherId, async () => {});
    pendingQueue.delete(wf.id!); pendingQueue.delete(otherId);
  }
});

test("positive webhook can merge only after authoritative reconciliation and prior Discord approval", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const headSha = "a".repeat(40);
  const wf = createWorkflow("wf-positive-blocked", "zeroclaw", "change", "acme/repo");
  wf.stage = "merge"; wf.prNumber = 71; wf.headSha = headSha;
  wf.ciPassed = false; wf.reviewPassed = false;
  wf.actionApprovals = { "pr.merge": { status: "approved", headSha } };
  store.set(wf.id!, wf);
  const writes: string[] = [];
  const opts = {
    ...options(store),
    sourceFactory: () => ({ access: async () => "synthetic-token" }),
    reconcileHeadEvidence: async () => ({ headSha, ciPassed: true, reviewPassed: true }),
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main", fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") writes.push(String(url));
      return Response.json({ sha: "synthetic-merge" });
    } },
  };
  const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 71 }, review: { state: "approved", commit_id: headSha } });
  const response = await handleWebhookRequest(signed(body, "http://localhost/webhook", "positive-blocked"), opts);
  expect(response.status).toBe(200);
  expect(store.get(wf.id!)?.ciPassed).toBe(true);
  expect(store.get(wf.id!)?.reviewPassed).toBe(true);
  expect(store.get(wf.id!)?.status).toBe("merged");
  expect(writes).toHaveLength(1);
});

test("a matching Discord approval completes a policy-ready merge exactly once", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const headSha = "b".repeat(40);
  const wf = createWorkflow("wf-cached-blocked", "zeroclaw", "change", "acme/repo");
  wf.stage = "merge"; wf.prNumber = 72; wf.headSha = headSha;
  wf.ciPassed = true; wf.reviewPassed = true;
  wf.actionApprovals = { "pr.merge": { status: "approved", headSha } };
  store.set(wf.id!, wf);
  const writes: string[] = [];
  const opts = {
    ...options(store),
    sourceFactory: () => ({ access: async () => "synthetic-token" }),
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main", fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") writes.push(String(url));
      return Response.json({ sha: "synthetic-merge" });
    } },
  };
  const response = await handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": controlSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "approve", source: "discord", workflowId: wf.id, action: "pr.merge", user: "alice", headSha }),
  }), opts);
  expect(response.status).toBe(200);
  expect(store.get(wf.id!)?.status).toBe("merged");
  expect(writes).toHaveLength(1);
});

test.each(["approve", "reject"] as const)("control %s rejects forged CI and PR fields", async (type) => {
  const store = new SQLiteWorkflowStore(":memory:");
  const headSha = "c".repeat(40);
  const wf = createWorkflow(`wf-forged-${type}`, "zeroclaw", "change", "acme/repo");
  wf.stage = "merge"; wf.prNumber = 73; wf.headSha = headSha;
  wf.status = "awaiting-approval"; wf.pendingAction = "pr.merge";
  wf.ciPassed = false; wf.reviewPassed = true;
  wf.actionApprovals = { "pr.merge": { status: "pending" } };
  store.set(wf.id!, wf);
  const response = await handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": controlSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ type, source: "discord", workflowId: wf.id, action: "pr.merge", user: "mallory", ciPassed: true, prNumber: 999 }),
  }), options(store));
  expect(response.status).toBe(400);
  expect(store.get(wf.id!)).toEqual(wf);
});

test("merge-stage workflow without a PR is not marked merged from cached evidence", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const headSha = "d".repeat(40);
  const wf = createWorkflow("wf-missing-pr", "zeroclaw", "change", "acme/repo");
  wf.stage = "merge"; wf.headSha = headSha; wf.ciPassed = true; wf.reviewPassed = true;
  wf.actionApprovals = { "pr.merge": { status: "approved", headSha } };
  store.set(wf.id!, wf);
  const response = await handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": controlSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "approve", source: "discord", workflowId: wf.id, action: "pr.merge", user: "alice", headSha }),
  }), options(store));
  expect(response.status).toBe(200);
  expect(store.get(wf.id!)?.status).not.toBe("merged");
  expect(store.get(wf.id!)?.actionApprovals?.["pr.merge"]?.status).toBe("approved");
});

test("ready merge dispatch consumes only its matching approval", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const headSha = "e".repeat(40);
  const wf = createWorkflow("wf-dispatch-disabled", "zeroclaw", "change", "acme/repo");
  wf.stage = "merge"; wf.prNumber = 74; wf.headSha = headSha; wf.ciPassed = true; wf.reviewPassed = true;
  wf.actionApprovals = { "pr.merge": { status: "approved", headSha } };
  store.set(wf.id!, wf);
  const response = await handleControlDispatchRequest(new Request("http://localhost/dispatch", {
    method: "POST", headers: { "x-control-event-secret": controlSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ workflowId: wf.id, runtime: "zeroclaw", role: "merger", stage: "merge", action: "pr.merge" }),
  }), options(store));
  expect(response.status).toBe(200);
  expect(store.get(wf.id!)?.actionApprovals?.["pr.merge"]?.status).toBe("consumed");
  expect(store.get(wf.id!)?.status).not.toBe("merged");
});

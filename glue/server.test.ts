import { SQLiteWorkflowStore } from "./store";
import { DeliveryIdempotencyCache } from "./webhook-idempotency.ts";
import { test, expect, spyOn } from "bun:test";
import {
  handleWebhookRequest,
  start,
  validateRuntimeDispatchPayload,
  handleControlEventRequest,
  handleControlDispatchRequest,
  pruneWorkflowStore,
  pendingQueue,
  store as serverStore,
  withWorkflowLock,
} from "./server";
import { createWorkflow, applyEvent, advanceStage } from "./state-machine";
import type { WorkflowState } from "./contract";
import { createHmac } from "node:crypto";
import type { SecretSource } from "../secrets/loader.ts";
import { buildStatusRelayHandler } from "../discord/bot.ts";

const CONTROL_SECRET = "control-shared-secret";

function assertWorkflowId(workflow: WorkflowState): asserts workflow is WorkflowState & { id: string } {
  if (!workflow.id) throw new Error("Expected workflow ID");
}

function pendingPrCreateWorkflow(id: string, request = "impl feature"): WorkflowState {
  let wf = createWorkflow(id, "zeroclaw", request);
  wf = advanceStage(wf);
  wf = advanceStage(wf);
  return advanceStage(wf);
}

function pendingMergeWorkflow(id: string, request = "merge feature"): WorkflowState {
  let wf = pendingPrCreateWorkflow(id, request);
  wf = applyEvent(wf, { type: "approve", action: "pr.create", user: "alice" });
  wf = advanceStage(wf);
  return { ...advanceStage(wf), headSha: "a".repeat(40) };
}

class MockSource implements SecretSource {
  constructor(private store: Record<string, string>) {}
  async access(id: string): Promise<string> {
    const value = this.store[id];
    if (value === undefined) throw new Error("not found");
    return value;
  }
}

function sourceFactory() {
  return new MockSource({
    "jeo-claw-github-token-ro": "ghp_read_live",
    "jeo-claw-github-token-rw": "ghp_write_live",
  });
}
const runtimeDispatchFetchImpl: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  return new Response(
    JSON.stringify({
      success: true,
      receiptPath: `/tmp/${body.workflowId ?? "wf"}-${body.stage ?? "stage"}.json`,
      runtime: body.runtime,
      role: body.role,
      stage: body.stage,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;

test("handleWebhookRequest returns 401 on bad signature", async () => {
  const secret: string = "test_webhook_secret";
  const store = new SQLiteWorkflowStore(":memory:");
  const req = new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=invalid" },
    body: JSON.stringify({ hello: "world" }),
  });

  const res = await handleWebhookRequest(req, {
    secret: secret || "",
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
    store,
  });
  expect(res.status).toBe(401);
  const data = (await res.json()) as { error?: string };
  expect(data.error).toBe("Unauthorized");
});

test("handleWebhookRequest rejects oversized webhook payloads before signature parsing", async () => {
  const body = "x".repeat(300 * 1024);
  const res = await handleWebhookRequest(new Request("http://localhost/webhook", {
    method: "POST",
    headers: {
      "x-hub-signature-256": "sha256=invalid",
      "content-length": String(body.length),
    },
    body,
  }), {
    secret: "test_webhook_secret",
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
    store: new SQLiteWorkflowStore(":memory:"),
  });

  expect(res.status).toBe(413);
});

test("handleWebhookRequest exposes health without webhook signature", async () => {
  const res = await handleWebhookRequest(new Request("http://localhost/health", { method: "GET" }), {
    secret: "test_webhook_secret",
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
    store: new SQLiteWorkflowStore(":memory:"),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { ok?: boolean };
  expect(data.ok).toBe(true);
});

test("handleWebhookRequest rejects receipt-only runtime completion after a valid pull_request event", async () => {
  const secret: string = "test_webhook_secret";
  const store = new SQLiteWorkflowStore(":memory:");

  const wf = createWorkflow("wf-123", "zeroclaw", "impl feature");
  wf.stage = "pr-review-schedule";
  wf.prNumber = 42;
  assertWorkflowId(wf);
  store.set(wf.id, wf);

  const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 42 } });
  const hmac = createHmac("sha256", secret || "").update(body).digest("hex");
  const req = new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${hmac}` },
    body,
  });

  const res = await handleWebhookRequest(req, {
    secret: secret || "",
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
    store,
  });
  expect(res.status).toBe(500);
  const updated = store.get("wf-123");
  expect(updated?.prNumber).toBe(42);
  expect(updated?.stage).toBe("pr-review-schedule");
});

test("handleWebhookRequest rejects non-boolean webhook fields without mutating workflow", async () => {
  const secret: string = "test_webhook_secret";
  const store = new SQLiteWorkflowStore(":memory:");
  const wf = createWorkflow("wf-strict", "zeroclaw", "impl feature");
  assertWorkflowId(wf);
  store.set(wf.id, wf);

  const body = JSON.stringify({ workflowId: wf.id, ciPassed: "yes" });
  const hmac = createHmac("sha256", secret || "").update(body).digest("hex");
  const req = new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${hmac}` },
    body,
  });

  const res = await handleWebhookRequest(req, {
    secret: secret || "",
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
    store,
  });
  expect(res.status).toBe(400);
  expect(store.get(wf.id)?.ciPassed).toBeUndefined();
});

test("validateRuntimeDispatchPayload rejects arbitrary egress and host-control fields", () => {
  expect(
    validateRuntimeDispatchPayload({
      workflowId: "wf-1",
      runtime: "zeroclaw",
      role: "reviewer",
      stage: "review",
      action: "review",
    }).ok,
  ).toBe(true);

  for (const key of ["url", "command", "path", "token", "env", "mount"]) {
    expect(
      validateRuntimeDispatchPayload({
        workflowId: "wf-1",
        runtime: "zeroclaw",
        role: "reviewer",
        stage: "review",
        action: "review",
        [key]: "https://evil.example",
      }).ok,
    ).toBe(false);
  }
});

test("handleControlEventRequest rejects unauthenticated mutations", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const req = new Request("http://localhost/control-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "build secure feature" }),
  });
  const res = await handleControlEventRequest(req, { store: localStore, controlEventSecret: CONTROL_SECRET });
  expect(res.status).toBe(401);
});

test("status relay credential cannot authorize control events", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const req = new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": "synthetic-relay-secret" },
    body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "build secure feature" }),
  });
  expect((await handleControlEventRequest(req, { store: localStore, controlEventSecret: CONTROL_SECRET })).status).toBe(401);
  expect(localStore.size).toBe(0);
});

test("control secret alone cannot mint a Discord approval", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const wf = pendingPrCreateWorkflow("wf-source-less-approval");
  assertWorkflowId(wf);
  localStore.set(wf.id, wf);
  const response = await handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": CONTROL_SECRET },
    body: JSON.stringify({ type: "approve", workflowId: wf.id, action: "pr.create", user: "mallory" }),
  }), { store: localStore, controlEventSecret: CONTROL_SECRET });
  expect(response.status).toBe(403);
  expect(localStore.get(wf.id)).toEqual(wf);
});

test("handleControlEventRequest creates workflows and ignores early approvals", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const createReq = new Request("http://localhost/control-event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-control-event-secret": CONTROL_SECRET,
    },
    body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "build secure feature" }),
  });
  const createRes = await handleControlEventRequest(createReq, { store: localStore, controlEventSecret: CONTROL_SECRET });
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { workflow: WorkflowState };
  assertWorkflowId(created.workflow);

  const approveReq = new Request("http://localhost/control-event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-control-event-secret": CONTROL_SECRET,
    },
    body: JSON.stringify({ type: "approve", source: "discord", workflowId: created.workflow.id, action: "pr.create", user: "alice" }),
  });
  const approveRes = await handleControlEventRequest(approveReq, { store: localStore, controlEventSecret: CONTROL_SECRET });
  expect(approveRes.status).toBe(200);
  expect(localStore.get(created.workflow.id)?.actionApprovals?.["pr.create"]?.status).toBeUndefined();
});

test("handleControlEventRequest hard-blocks banned jeo-code target at intake", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const req = new Request("http://localhost/control-event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-control-event-secret": CONTROL_SECRET,
    },
    body: JSON.stringify({
      type: "request",
      source: "discord",
      runtime: "zeroclaw",
      request: "improve jeo-code",
      repo: "akillness/jeo-code",
    }),
  });
  const queueBefore = pendingQueue.size;
  const res = await handleControlEventRequest(req, { store: localStore, controlEventSecret: CONTROL_SECRET });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { success: boolean; error: string };
  expect(body.success).toBe(false);
  expect(body.error).toContain("akillness/jeo-code");
  // No workflow is created and nothing is queued for the banned target.
  expect([...localStore.values()].length).toBe(0);
  expect(pendingQueue.size).toBe(queueBefore);
});

test("handleControlEventRequest still accepts the allowed jeo-claw target", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const req = new Request("http://localhost/control-event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-control-event-secret": CONTROL_SECRET,
    },
    body: JSON.stringify({
      type: "request",
      source: "discord",
      runtime: "zeroclaw",
      request: "improve jeo-claw",
      repo: "akillness/jeo-claw",
    }),
  });
  const res = await handleControlEventRequest(req, { store: localStore, controlEventSecret: CONTROL_SECRET });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { workflow: WorkflowState };
  expect(body.workflow.repo).toBe("akillness/jeo-claw");
});
test("wrong and rejected approvals cannot write; a matching approval writes once and cannot be replayed", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const denied = pendingPrCreateWorkflow("wf-denied-regression");
  const approved = pendingPrCreateWorkflow("wf-approved-regression");
  assertWorkflowId(denied);
  assertWorkflowId(approved);
  localStore.set(denied.id, denied);
  localStore.set(approved.id, approved);
  let writes = 0;
  const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("/pulls?state=open")) return Response.json([]);
    if (init?.method === "POST" && String(url).endsWith("/pulls")) {
      writes++;
      return Response.json({ number: 77, html_url: "https://github.com/acme/repo/pull/77" }, { status: 201 });
    }
    throw new Error(`Unexpected GitHub request: ${String(url)}`);
  }) as typeof fetch;
  const opts = {
    store: localStore, controlEventSecret: CONTROL_SECRET, prefix: "jeo-claw", sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main", fetchImpl },
    runtimeDispatchSecret: "runtime-dispatch-secret", dispatchFetchImpl: runtimeDispatchFetchImpl,
  };
  const send = (workflowId: string, type: "approve" | "reject", action: "pr.create" | "pr.merge", secret = CONTROL_SECRET) =>
    handleControlEventRequest(new Request("http://localhost/control-event", {
      method: "POST", headers: { "Content-Type": "application/json", "x-control-event-secret": secret },
      body: JSON.stringify({ type, source: "discord", workflowId, action, user: "alice" }),
    }), opts);
    expect((await send(approved.id, "approve", "pr.create", "wrong-secret")).status).toBe(401);
    await send(approved.id, "approve", "pr.merge");
    expect(localStore.get(approved.id)?.status).toBe("awaiting-approval");
    expect(writes).toBe(0);
    await send(denied.id, "reject", "pr.create");
    expect(localStore.get(denied.id)?.status).toBe("rejected");
    await send(denied.id, "approve", "pr.create");
    expect(writes).toBe(0);
    expect((await send(approved.id, "approve", "pr.create")).status).toBe(500);
    expect(localStore.get(approved.id)?.prNumber).toBe(77);
    expect(localStore.get(approved.id)?.actionApprovals?.["pr.create"]?.status).toBe("consumed");
    await send(approved.id, "approve", "pr.create");
    expect(writes).toBe(1);
});

test("handleControlEventRequest executes approved PR creation through the live write path", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const wf = pendingPrCreateWorkflow("wf-live-pr", "Build secure feature");
  assertWorkflowId(wf);
  localStore.set(wf.id, wf);

  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (String(url).includes("/pulls?state=open")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ number: 77, html_url: "https://github.com/acme/repo/pull/77" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const approveReq = new Request("http://localhost/control-event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-control-event-secret": CONTROL_SECRET,
    },
    body: JSON.stringify({ type: "approve", source: "discord", workflowId: wf.id, action: "pr.create", user: "alice" }),
  });
  const approveRes = await handleControlEventRequest(approveReq, {
    store: localStore,
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main", fetchImpl },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
  });
  expect(approveRes.status).toBe(500);
  const updated = localStore.get(wf.id)!;
  expect(updated.prNumber).toBe(77);
  expect(updated.stage).toBe("pr-review-schedule");
  expect(updated.status).toBe("running");
  expect(updated.actionApprovals?.["pr.create"]?.status).toBe("consumed");
  expect(calls.some((call) => call.url.includes("/repos/acme/repo/pulls?state=open"))).toBe(true);
  expect(calls.find((call) => call.body?.head)?.body.head).toBe(`jeo/${wf.runtime}/pr-creator/${wf.id}`);
});

test("handleWebhookRequest executes approved merge through the live write path", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  let wf = pendingMergeWorkflow("wf-live-merge", "Merge secure feature");
  wf.prNumber = 77;
  wf = applyEvent(wf, { reviewPassed: true });
  wf = advanceStage(wf);
  wf = applyEvent(wf, { type: "approve", action: "pr.merge", user: "alice", headSha: wf.headSha });
  assertWorkflowId(wf);
  localStore.set(wf.id, wf);

  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ merged: true, sha: "abc123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 77 }, review: { state: "approved", commit_id: wf.headSha } });
  const hmac = createHmac("sha256", "test_webhook_secret").update(body).digest("hex");
  const res = await handleWebhookRequest(new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${hmac}` },
    body,
  }), {
    secret: "test_webhook_secret",
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main", fetchImpl },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
    reconcileHeadEvidence: async () => ({ headSha: wf.headSha!, ciPassed: true, reviewPassed: true }),
    store: localStore,
  });
  expect(res.status).toBe(200);
  const updated = localStore.get(wf.id)!;
  expect(updated.status).toBe("merged");
  expect(updated.actionApprovals?.["pr.merge"]?.status).toBe("consumed");
  expect(calls[0]?.url).toContain("/repos/acme/repo/pulls/77/merge");
});

test("config-set through control-event is explicit not-implemented", async () => {
  const res = await handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-control-event-secret": CONTROL_SECRET,
    },
    body: JSON.stringify({ type: "config-set", key: "provider", value: "openai-codex" }),
  }), {
    store: new SQLiteWorkflowStore(":memory:"),
    controlEventSecret: CONTROL_SECRET,
  });
  expect(res.status).toBe(501);
});
test("ping control event returns pong", async () => {
  const store = new Map<string, WorkflowState>();
  const req = new Request("http://localhost/control-event", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": CONTROL_SECRET },
    body: JSON.stringify({ type: "ping" }),
  });

  const res = await handleControlEventRequest(req, {
    controlEventSecret: CONTROL_SECRET,
    store,
    storePolicy: { maxActiveWorkflows: 100, maxTerminalWorkflows: 50 },
  } as any);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ success: true, message: "pong" });
});

test("debug workflows endpoint lists current workflow summaries", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const wf = createWorkflow("wf-debug", "nullclaw", "browser verification");
  wf.stage = "pr-create";
  wf.status = "awaiting-approval";
  wf.pendingAction = "pr.create";
  wf.headRef = "jeo/nullclaw/pr-creator/wf-debug";
  assertWorkflowId(wf);
  localStore.set(wf.id, wf);

  const res = await handleWebhookRequest(new Request("http://localhost/debug/workflows", { headers: { "x-control-event-secret": CONTROL_SECRET } }), {
    secret: "test_webhook_secret",
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
    store: localStore,
  });

  expect(res.status).toBe(200);
  const body = await res.json() as { workflows: Array<{ id: string; runtime: string; request: string; stage: string; status: string; pendingAction?: string; headRef?: string }> };
  expect(body.workflows).toEqual([
    {
      id: "wf-debug",
      runtime: "nullclaw",
      request: "browser verification",
      stage: "pr-create",
      status: "awaiting-approval",
      pendingAction: "pr.create",
      headRef: "jeo/nullclaw/pr-creator/wf-debug",
    },
  ]);
});

test("handleControlDispatchRequest rejects unauthenticated or unapproved write release", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const wf = pendingPrCreateWorkflow("wf-dispatch");
  assertWorkflowId(wf);
  localStore.set(wf.id, wf);

  const unauthReq = new Request("http://localhost/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflowId: wf.id, runtime: "zeroclaw", role: "pr-creator", stage: "pr-create", action: "pr.create" }),
  });
  expect((await handleControlDispatchRequest(unauthReq, { store: localStore, controlEventSecret: CONTROL_SECRET, prefix: "jeo-claw", sourceFactory })).status).toBe(401);

  const unapprovedReq = new Request("http://localhost/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": CONTROL_SECRET },
    body: JSON.stringify({ workflowId: wf.id, runtime: "zeroclaw", role: "pr-creator", stage: "pr-create", action: "pr.create" }),
  });
  expect((await handleControlDispatchRequest(unapprovedReq, { store: localStore, controlEventSecret: CONTROL_SECRET, prefix: "jeo-claw", sourceFactory })).status).toBe(403);
});

test("handleControlDispatchRequest releases write secret only for approved matching role/action and consumes approval", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  let wf = pendingPrCreateWorkflow("wf-dispatch");
  wf = applyEvent(wf, { type: "approve", action: "pr.create", user: "alice" });
  assertWorkflowId(wf);
  localStore.set(wf.id, wf);

  const req = new Request("http://localhost/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": CONTROL_SECRET },
    body: JSON.stringify({ workflowId: wf.id, runtime: "zeroclaw", role: "pr-creator", stage: "pr-create", action: "pr.create" }),
  });
  const res = await handleControlDispatchRequest(req, { store: localStore, controlEventSecret: CONTROL_SECRET, prefix: "jeo-claw", sourceFactory });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { credentials?: Record<string, string>; credentialReleased?: boolean };
  expect(data.credentials).toBeUndefined();
  expect(data.credentialReleased).toBe(false);
  expect(localStore.get(wf.id)?.actionApprovals?.["pr.create"]?.status).toBe("consumed");
});

test("handleControlDispatchRequest rejects role/action mismatch", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const wf = pendingMergeWorkflow("wf-dispatch");
  assertWorkflowId(wf);
  localStore.set(wf.id, wf);

  const req = new Request("http://localhost/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": CONTROL_SECRET },
    body: JSON.stringify({ workflowId: wf.id, runtime: "zeroclaw", role: "pr-creator", stage: "merge", action: "pr.merge" }),
  });
  const res = await handleControlDispatchRequest(req, { store: localStore, controlEventSecret: CONTROL_SECRET, prefix: "jeo-claw", sourceFactory });
  expect(res.status).toBe(403);
});

test("handleControlDispatchRequest binds release to stored workflow runtime stage and readiness", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  let wf = pendingPrCreateWorkflow("wf-bound");
  wf = applyEvent(wf, { type: "approve", action: "pr.create", user: "alice" });
  assertWorkflowId(wf);
  localStore.set(wf.id, wf);

  const runtimeMismatch = new Request("http://localhost/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": CONTROL_SECRET },
    body: JSON.stringify({ workflowId: wf.id, runtime: "nullclaw", role: "pr-creator", stage: "pr-create", action: "pr.create" }),
  });
  const runtimeRes = await handleControlDispatchRequest(runtimeMismatch, { store: localStore, controlEventSecret: CONTROL_SECRET, prefix: "jeo-claw", sourceFactory });
  expect(runtimeRes.status).toBe(403);
  expect(((await runtimeRes.json()) as { error: string }).error).toContain("runtime/workflow mismatch");

  const stageMismatch = new Request("http://localhost/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": CONTROL_SECRET },
    body: JSON.stringify({ workflowId: wf.id, runtime: "zeroclaw", role: "pr-creator", stage: "merge", action: "pr.create" }),
  });
  const stageRes = await handleControlDispatchRequest(stageMismatch, { store: localStore, controlEventSecret: CONTROL_SECRET, prefix: "jeo-claw", sourceFactory });
  expect(stageRes.status).toBe(403);
  expect(((await stageRes.json()) as { error: string }).error).toContain("stage/workflow mismatch");
});

test("handleControlDispatchRequest refuses merge credential release before CI and review are true", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  let wf = pendingMergeWorkflow("wf-merge-not-ready", "merge feature");
  wf.prNumber = 99;
  wf = advanceStage(wf);
  wf = applyEvent(wf, { type: "approve", action: "pr.merge", user: "alice", headSha: wf.headSha });
  assertWorkflowId(wf);
  localStore.set(wf.id, wf);

  const req = new Request("http://localhost/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": CONTROL_SECRET },
    body: JSON.stringify({ workflowId: wf.id, runtime: "zeroclaw", role: "merger", stage: "merge", action: "pr.merge" }),
  });
  const res = await handleControlDispatchRequest(req, { store: localStore, controlEventSecret: CONTROL_SECRET, prefix: "jeo-claw", sourceFactory });

  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toContain("not ready for pr.merge");
  expect(localStore.get(wf.id)?.actionApprovals?.["pr.merge"]?.status).toBe("approved");
});

test("unmatched signed webhook reports non-success body", async () => {
  const secret: string = "test_webhook_secret";
  const body = JSON.stringify({ event: "pull_request", repository: { full_name: "acme/repo" }, pull_request: { number: 404 } });
  const hmac = createHmac("sha256", secret || "").update(body).digest("hex");
  const res = await handleWebhookRequest(new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${hmac}` },
    body,
  }), {
    secret: secret || "",
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
    store: new SQLiteWorkflowStore(":memory:"),
  });
  expect(res.status).toBe(202);
  const data = (await res.json()) as { success?: boolean; message?: string };
  expect(data.success).toBe(false);
  expect(data.message).toContain("No matching workflow");
});

test("start throws when required secrets/bootstrap inputs are missing or blank", () => {
  const originalWebhook = process.env.GITHUB_WEBHOOK_SECRET;
  const originalControl = process.env.JEO_CONTROL_EVENT_SECRET;
  const originalProject = process.env.GCLOUD_PROJECT;
  const originalPrefix = process.env.GCLOUD_SECRET_PREFIX;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.JEO_CONTROL_EVENT_SECRET;
  delete process.env.GCLOUD_PROJECT;
  delete process.env.GCLOUD_SECRET_PREFIX;
  try {
    expect(() => start()).toThrow("GITHUB_WEBHOOK_SECRET is missing or empty");
    process.env.GITHUB_WEBHOOK_SECRET = "whsec_test";
    expect(() => start()).toThrow("JEO_CONTROL_EVENT_SECRET is missing or empty");
    process.env.JEO_CONTROL_EVENT_SECRET = CONTROL_SECRET;
    expect(() => start()).toThrow("GCLOUD_PROJECT, GCLOUD_SECRET_PREFIX, TARGET_REPO, TARGET_BRANCH, and JEO_RUNTIME_DISPATCH_SECRET are required");
  } finally {
    process.env.GITHUB_WEBHOOK_SECRET = originalWebhook;
    process.env.JEO_CONTROL_EVENT_SECRET = originalControl;
    process.env.GCLOUD_PROJECT = originalProject;
    process.env.GCLOUD_SECRET_PREFIX = originalPrefix;
  }
});

test("pruneWorkflowStore evicts stale terminal workflows before active workflows", () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const active = createWorkflow("wf-active", "zeroclaw", "active");
  active.history = [{ stage: "review", at: "2026-06-09T10:00:00.000Z", status: "running" }];

  const staleMerged = createWorkflow("wf-stale", "zeroclaw", "old merged");
  staleMerged.status = "merged";
  staleMerged.mergedAt = "2026-06-08T00:00:00.000Z";
  staleMerged.history = [{ stage: "merge", at: "2026-06-08T00:00:00.000Z", status: "merged" }];

  const freshMerged = createWorkflow("wf-fresh", "zeroclaw", "fresh merged");
  freshMerged.status = "merged";
  freshMerged.mergedAt = "2026-06-09T09:59:00.000Z";
  freshMerged.history = [{ stage: "merge", at: "2026-06-09T09:59:00.000Z", status: "merged" }];

  assertWorkflowId(active);
  assertWorkflowId(staleMerged);
  assertWorkflowId(freshMerged);
  localStore.set(active.id, active);
  localStore.set(staleMerged.id, staleMerged);
  localStore.set(freshMerged.id, freshMerged);

  pruneWorkflowStore(localStore, {
    terminalRetentionMs: 60 * 60 * 1000,
    maxWorkflows: 2,
    now: () => Date.parse("2026-06-09T10:00:00.000Z"),
  });

  expect(localStore.get("wf-stale") !== undefined).toBe(false);
  expect(localStore.get("wf-active") !== undefined).toBe(true);
  expect(localStore.get("wf-fresh") !== undefined).toBe(true);
});

test("handleControlEventRequest prunes workflow store after mutations", async () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const oldMerged = createWorkflow("wf-old", "zeroclaw", "old");
  oldMerged.status = "merged";
  oldMerged.mergedAt = "2026-06-08T00:00:00.000Z";
  oldMerged.history = [{ stage: "merge", at: "2026-06-08T00:00:00.000Z", status: "merged" }];
  assertWorkflowId(oldMerged);
  localStore.set(oldMerged.id, oldMerged);

  const res = await handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-control-event-secret": CONTROL_SECRET,
    },
    body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "new work" }),
  }), {
    store: localStore,
    controlEventSecret: CONTROL_SECRET,
    storePolicy: {
      terminalRetentionMs: 1,
      maxWorkflows: 5,
      now: () => Date.parse("2026-06-09T10:00:00.000Z"),
    },
  });

  expect(res.status).toBe(201);
  expect(localStore.get("wf-old") !== undefined).toBe(false);
  expect(localStore.size).toBe(1);
});

test("handleWebhookRequest deduplicates redelivered webhooks by X-GitHub-Delivery", async () => {
  const secret = "test_webhook_secret";
  const store = new SQLiteWorkflowStore(":memory:");
  const deliveryCache = new DeliveryIdempotencyCache();

  const wf = createWorkflow("wf-dedupe", "zeroclaw", "impl feature");
  wf.stage = "merge";
  wf.prNumber = 77;
  wf.headSha = "a".repeat(40);
  wf.reviewPassed = true;
  store.set("wf-dedupe", wf);

  const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 77 }, review: { state: "changes_requested", commit_id: "a".repeat(40) } });
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  const opts = {
    secret,
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
    store,
    deliveryCache,
  };
  const makeReq = () =>
    new Request("http://localhost/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${hmac}`, "x-github-delivery": "delivery-77" },
      body,
    });

  const first = await handleWebhookRequest(makeReq(), opts);
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as { deduplicated?: boolean };
  expect(firstBody.deduplicated).toBeUndefined();
  expect(store.get("wf-dedupe")?.stage).toBe("merge");

  // Tamper the store to a state the redelivery would *advance* if it were reprocessed.
  const reset = store.get("wf-dedupe")!;
  reset.reviewPassed = true;
  store.set("wf-dedupe", reset);

  const replay = await handleWebhookRequest(makeReq(), opts);
  expect(replay.status).toBe(200);
  const replayBody = (await replay.json()) as { deduplicated?: boolean; deliveryId?: string };
  expect(replayBody.deduplicated).toBe(true);
  expect(replayBody.deliveryId).toBe("delivery-77");
  // Redelivery was dropped before any state mutation: stage stays where we reset it.
  expect(store.get("wf-dedupe")?.reviewPassed).toBe(true);

  // A distinct delivery id cannot replay the identical signed payload either;
  // the durable payload digest remains authoritative after cache churn.
  const distinct = new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${hmac}`, "x-github-delivery": "delivery-78" },
    body,
  });
  const distinctRes = await handleWebhookRequest(distinct, opts);
  expect(distinctRes.status).toBe(200);
  expect(store.get("wf-dedupe")?.reviewPassed).toBe(true);
});

test("glue authenticates status notifications to the relay without exposing the secret", async () => {
  const secret = "synthetic-glue-relay-secret";
  const delivered: string[] = [];
  const handler = buildStatusRelayHandler({ statusRelaySecret: secret, sendToChannel: async (_id, content) => { delivered.push(content); } });
  const relay = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  const env = {
    NODE_ENV: "development", GITHUB_WEBHOOK_SECRET: "synthetic-webhook", JEO_CONTROL_EVENT_SECRET: CONTROL_SECRET, JEO_STATUS_RELAY_SECRET: secret,
    GCLOUD_PROJECT: "test", GCLOUD_SECRET_PREFIX: "test", TARGET_REPO: "acme/repo",
    TARGET_BRANCH: "main", JEO_RUNTIME_DISPATCH_SECRET: "synthetic-dispatch", GLUE_PORT: "0",
    JEO_STATUS_ENDPOINT: `http://127.0.0.1:${relay.port}/status`,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const wf = createWorkflow("wf-relay-security", "zeroclaw", "feature");
  wf.stage = "pr-create";
  wf.prNumber = 4242;
  assertWorkflowId(wf);
  serverStore.set(wf.id, wf);
  const server = start({ dispatchFetchImpl: runtimeDispatchFetchImpl });
  try {
    const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 4242 } });
    const signature = createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(body).digest("hex");
    const response = await fetch(`http://127.0.0.1:${server.port}/webhook`, {
      method: "POST", headers: { "x-hub-signature-256": `sha256=${signature}` }, body,
    });
    expect(response.status).toBe(200);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.join("\n")).toContain("wf-relay-security");
    expect(delivered.join("\n")).not.toContain(secret);
  } finally {
    server.stop(true);
    relay.stop(true);
    serverStore.delete(wf.id);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("glue status transport failure logs no secret or endpoint", async () => {
  const secret = "synthetic-secret-in-failed-endpoint";
  const env = { NODE_ENV: "development", JEO_STATUS_RELAY_SECRET: secret, JEO_STATUS_ENDPOINT: `http://127.0.0.1:0/status?token=${secret}` };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const logs: string[] = [];
  const log = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  const localStore = new SQLiteWorkflowStore(":memory:");
  const wf = createWorkflow("wf-relay-log", "zeroclaw", "feature");
  wf.stage = "pr-create";
  wf.prNumber = 3434;
  assertWorkflowId(wf);
  localStore.set(wf.id, wf);
  try {
    const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 3434 } });
    const signature = createHmac("sha256", "synthetic-webhook").update(body).digest("hex");
    const response = await handleWebhookRequest(new Request("http://localhost/webhook", { method: "POST", headers: { "x-hub-signature-256": `sha256=${signature}` }, body }), {
      secret: "synthetic-webhook", controlEventSecret: secret, prefix: "test", sourceFactory,
      writeDeps: { targetRepo: "acme/repo", targetBranch: "main" }, runtimeDispatchSecret: "synthetic-dispatch", store: localStore,
    });
    expect(response.status).toBe(200);
    expect(logs).toContain("Failed to notify status");
    expect(logs.join("\n")).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(env.JEO_STATUS_ENDPOINT);
  } finally {
    log.mockRestore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("glue stop cancels a stalled status notification and releases the workflow lock", async () => {
  const env = {
    NODE_ENV: "development", GITHUB_WEBHOOK_SECRET: "webhook", JEO_CONTROL_EVENT_SECRET: CONTROL_SECRET,
    JEO_STATUS_RELAY_SECRET: "synthetic-relay-secret-long-enough",
    GCLOUD_PROJECT: "test", GCLOUD_SECRET_PREFIX: "test", TARGET_REPO: "acme/repo",
    TARGET_BRANCH: "main", JEO_RUNTIME_DISPATCH_SECRET: "dispatch", GLUE_PORT: "0",
  };
  const previous = Object.fromEntries(Object.keys({ ...env, JEO_STATUS_ENDPOINT: "" }).map((key) => [key, process.env[key]]));
  let received!: () => void;
  const arrived = new Promise<void>((resolve) => { received = resolve; });
  let finish!: (response: Response) => void;
  const relay = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
    received();
    return new Promise<Response>((resolve) => { finish = resolve; });
  } });
  Object.assign(process.env, env, { JEO_STATUS_ENDPOINT: `http://127.0.0.1:${relay.port}` });
  const wf = createWorkflow("wf-stalled-status-test", "zeroclaw", "feature");
  wf.stage = "pr-create";
  wf.prNumber = 42;
  wf.headSha = "a".repeat(40);
  assertWorkflowId(wf);
  serverStore.set(wf.id, wf);
  const server = start({ dispatchFetchImpl: runtimeDispatchFetchImpl });
  try {
    const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 42 }, review: { state: "changes_requested", commit_id: wf.headSha } });
    const signature = createHmac("sha256", "webhook").update(body).digest("hex");
    const response = fetch(`http://127.0.0.1:${server.port}/webhook`, {
      method: "POST", headers: { "x-hub-signature-256": `sha256=${signature}` }, body,
    }).catch(() => undefined);
    await arrived;
    const beforeStop = serverStore.get(wf.id);
    server.stop(true);
    const afterStop = await withWorkflowLock(wf.id, async () => serverStore.get(wf.id));
    expect(afterStop?.stage).toBe("pr-create");
    expect(afterStop).toEqual(beforeStop);
    await response;
  } finally {
    server.stop(true);
    finish?.(new Response("done"));
    relay.stop(true);
    serverStore.delete(wf.id);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("glue startup rejects absent, short or reused status relay credentials", () => {
  const env = {
    GITHUB_WEBHOOK_SECRET: "synthetic-webhook-secret-long", JEO_CONTROL_EVENT_SECRET: "synthetic-control-secret-long",
    JEO_RUNTIME_DISPATCH_SECRET: "synthetic-runtime-secret-long", JEO_STATUS_ENDPOINT: "http://127.0.0.1:1/status",
    GCLOUD_PROJECT: "test", GCLOUD_SECRET_PREFIX: "test", TARGET_REPO: "acme/repo", TARGET_BRANCH: "main", GLUE_PORT: "0",
  };
  const previous = Object.fromEntries(Object.keys({ ...env, JEO_STATUS_RELAY_SECRET: "" }).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    for (const value of [undefined, "short", env.GITHUB_WEBHOOK_SECRET, env.JEO_CONTROL_EVENT_SECRET, env.JEO_RUNTIME_DISPATCH_SECRET]) {
      if (value === undefined) delete process.env.JEO_STATUS_RELAY_SECRET;
      else process.env.JEO_STATUS_RELAY_SECRET = value;
      expect(() => start()).toThrow("JEO_STATUS_RELAY_SECRET must be at least 24 characters and distinct from other secrets");
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("glue repeated stop releases its listening port and occupied startup fails cleanly", () => {
  const env = {
    GITHUB_WEBHOOK_SECRET: "webhook", JEO_CONTROL_EVENT_SECRET: CONTROL_SECRET, GCLOUD_PROJECT: "test",
    GCLOUD_SECRET_PREFIX: "test", TARGET_REPO: "acme/repo", TARGET_BRANCH: "main",
    JEO_RUNTIME_DISPATCH_SECRET: "dispatch", GLUE_PORT: "0",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    for (let i = 0; i < 3; i++) {
      const server = start();
      const port = server.port;
      process.env.GLUE_PORT = String(port);
      expect(() => start()).toThrow();
      server.stop(true);
      server.stop(true);
      const probe = Bun.serve({ port, fetch: () => new Response() });
      probe.stop(true);
      process.env.GLUE_PORT = "0";
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("glue stop cancels stalled runtime dispatch and releases the workflow lock without writes", async () => {
  let githubWrites = 0;
  const github = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
    githubWrites++;
    return Response.json({ error: "unexpected write" }, { status: 500 });
  } });
  const env = {
    NODE_ENV: "test", GITHUB_WEBHOOK_SECRET: "webhook", JEO_CONTROL_EVENT_SECRET: CONTROL_SECRET,
    GCLOUD_PROJECT: "test", GCLOUD_SECRET_PREFIX: "test", TARGET_REPO: "acme/repo",
    TARGET_BRANCH: "main", JEO_RUNTIME_DISPATCH_SECRET: "dispatch", GLUE_PORT: "0",
    GITHUB_API_BASE_URL: `http://127.0.0.1:${github.port}`,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => { entered = resolve; });
  let cancelled = false;
  const dispatchFetchImpl: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    entered();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        cancelled = true;
        reject(new Error("dispatch aborted"));
      }, { once: true });
    });
  }) as typeof fetch;
  const wf = createWorkflow("wf-stalled-dispatch-test", "zeroclaw", "feature");
  wf.stage = "pr-review-schedule";
  wf.prNumber = 43;
  assertWorkflowId(wf);
  serverStore.set(wf.id, wf);
  const server = start({ dispatchFetchImpl });
  try {
    const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 43 } });
    const signature = createHmac("sha256", "webhook").update(body).digest("hex");
    const response = fetch(`http://127.0.0.1:${server.port}/webhook`, {
      method: "POST", headers: { "x-hub-signature-256": `sha256=${signature}` }, body,
    }).catch(() => undefined);
    await arrived;
    const beforeStop = serverStore.get(wf.id);
    if (!beforeStop) throw new Error("workflow disappeared before shutdown");
    server.stop(true);
    const afterStop = await withWorkflowLock(wf.id, async () => serverStore.get(wf.id));
    expect(cancelled).toBe(true);
    expect(afterStop?.stage).toBe("pr-review-schedule");
    const { webhookPendingDigest: _pending, ...beforeRetryable } = beforeStop;
    expect(afterStop).toEqual({ ...beforeRetryable, webhookDigests: [] });
    expect(githubWrites).toBe(0);
    await response;
  } finally {
    server.stop(true);
    github.stop(true);
    serverStore.delete(wf.id);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

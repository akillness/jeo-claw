import { test, expect } from "bun:test";
import {
  handleWebhookRequest,
  start,
  validateRuntimeDispatchPayload,
  handleControlEventRequest,
  handleControlDispatchRequest,
} from "./server";
import { createWorkflow, applyEvent } from "./state-machine";
import type { WorkflowState } from "./contract";
import { createHmac } from "node:crypto";
import type { SecretSource } from "../secrets/loader.ts";

const CONTROL_SECRET = "control-shared-secret";

class MockSource implements SecretSource {
  constructor(private store: Record<string, string>) {}
  async access(id: string): Promise<string> {
    const value = this.store[id];
    if (value === undefined) throw new Error("not found");
    return value;
  }
}

function sourceFactory() {
  return new MockSource({ "jeo-claw-github-token-rw": "ghp_write_live" });
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
  const secret = "test_webhook_secret";
  const store = new Map<string, WorkflowState>();
  const req = new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=invalid" },
    body: JSON.stringify({ hello: "world" }),
  });

  const res = await handleWebhookRequest(req, {
    secret,
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

test("handleWebhookRequest exposes health without webhook signature", async () => {
  const res = await handleWebhookRequest(new Request("http://localhost/health", { method: "GET" }), {
    secret: "test_webhook_secret",
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
    store: new Map(),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { ok?: boolean };
  expect(data.ok).toBe(true);
});

test("handleWebhookRequest returns 200 on valid pull_request event", async () => {
  const secret = "test_webhook_secret";
  const store = new Map<string, WorkflowState>();

  const wf = createWorkflow("wf-123", "zeroclaw", "impl feature");
  wf.stage = "pr-review-schedule";
  wf.prNumber = 42;
  store.set(wf.id, wf);

  const body = JSON.stringify({ pull_request: { number: 42 } });
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  const req = new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${hmac}` },
    body,
  });

  const res = await handleWebhookRequest(req, {
    secret,
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
    store,
  });
  expect(res.status).toBe(200);
  const updated = store.get("wf-123");
  expect(updated?.prNumber).toBe(42);
  expect(updated?.stage).toBe("merge");
});

test("handleWebhookRequest rejects non-boolean webhook fields without mutating workflow", async () => {
  const secret = "test_webhook_secret";
  const store = new Map<string, WorkflowState>();
  const wf = createWorkflow("wf-strict", "zeroclaw", "impl feature");
  store.set(wf.id, wf);

  const body = JSON.stringify({ workflowId: wf.id, ciPassed: "yes" });
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  const req = new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${hmac}` },
    body,
  });

  const res = await handleWebhookRequest(req, {
    secret,
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
  const localStore = new Map<string, WorkflowState>();
  const req = new Request("http://localhost/control-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "build secure feature" }),
  });
  const res = await handleControlEventRequest(req, { store: localStore, controlEventSecret: CONTROL_SECRET });
  expect(res.status).toBe(401);
});

test("handleControlEventRequest creates workflows and updates approval state when authenticated", async () => {
  const localStore = new Map<string, WorkflowState>();
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

  const approveReq = new Request("http://localhost/control-event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-control-event-secret": CONTROL_SECRET,
    },
    body: JSON.stringify({ type: "approve", workflowId: created.workflow.id, action: "pr.create", user: "alice" }),
  });
  const approveRes = await handleControlEventRequest(approveReq, { store: localStore, controlEventSecret: CONTROL_SECRET });
  expect(approveRes.status).toBe(200);
  expect(localStore.get(created.workflow.id)?.actionApprovals?.["pr.create"]?.status).toBe("approved");
});
test("handleControlEventRequest executes approved PR creation through the live write path", async () => {
  const localStore = new Map<string, WorkflowState>();
  let wf = createWorkflow("wf-live-pr", "zeroclaw", "Build secure feature");
  wf.stage = "pr-create";
  localStore.set(wf.id, wf);

  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
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
    body: JSON.stringify({ type: "approve", workflowId: wf.id, action: "pr.create", user: "alice" }),
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
  expect(approveRes.status).toBe(200);
  const updated = localStore.get(wf.id)!;
  expect(updated.prNumber).toBe(77);
  expect(updated.stage).toBe("merge");
  expect(updated.status).toBe("awaiting-approval");
  expect(updated.actionApprovals?.["pr.create"]?.status).toBe("consumed");
  expect(calls[0]?.url).toContain("/repos/acme/repo/pulls");
  expect(calls[0]?.body.head).toBe(`jeo/${wf.runtime}/pr-creator/${wf.id}`);
});

test("handleWebhookRequest executes approved merge through the live write path", async () => {
  const localStore = new Map<string, WorkflowState>();
  let wf = createWorkflow("wf-live-merge", "zeroclaw", "Merge secure feature");
  wf.stage = "merge";
  wf.prNumber = 77;
  wf = applyEvent(wf, { reviewPassed: true });
  wf = applyEvent(wf, { type: "approve", action: "pr.merge", user: "alice" });
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

  const body = JSON.stringify({ workflowId: wf.id, ciPassed: true });
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
    body: JSON.stringify({ type: "config-set", key: "provider", value: "openai" }),
  }), {
    store: new Map(),
    controlEventSecret: CONTROL_SECRET,
  });
  expect(res.status).toBe(501);
});

test("handleControlDispatchRequest rejects unauthenticated or unapproved write release", async () => {
  const localStore = new Map<string, WorkflowState>();
  const wf = createWorkflow("wf-dispatch", "zeroclaw", "impl feature");
  wf.stage = "pr-create";
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
  const localStore = new Map<string, WorkflowState>();
  let wf = createWorkflow("wf-dispatch", "zeroclaw", "impl feature");
  wf.stage = "pr-create";
  wf = applyEvent(wf, { type: "approve", action: "pr.create", user: "alice" });
  localStore.set(wf.id, wf);

  const req = new Request("http://localhost/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": CONTROL_SECRET },
    body: JSON.stringify({ workflowId: wf.id, runtime: "zeroclaw", role: "pr-creator", stage: "pr-create", action: "pr.create" }),
  });
  const res = await handleControlDispatchRequest(req, { store: localStore, controlEventSecret: CONTROL_SECRET, prefix: "jeo-claw", sourceFactory });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { credentials: Record<string, string> };
  expect(data.credentials.GITHUB_TOKEN).toBe("ghp_write_live");
  expect(localStore.get(wf.id)?.actionApprovals?.["pr.create"]?.status).toBe("consumed");
});

test("handleControlDispatchRequest rejects role/action mismatch", async () => {
  const localStore = new Map<string, WorkflowState>();
  let wf = createWorkflow("wf-dispatch", "zeroclaw", "impl feature");
  wf.stage = "merge";
  wf = applyEvent(wf, { type: "approve", action: "pr.merge", user: "alice" });
  localStore.set(wf.id, wf);

  const req = new Request("http://localhost/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": CONTROL_SECRET },
    body: JSON.stringify({ workflowId: wf.id, runtime: "zeroclaw", role: "pr-creator", stage: "merge", action: "pr.merge" }),
  });
  const res = await handleControlDispatchRequest(req, { store: localStore, controlEventSecret: CONTROL_SECRET, prefix: "jeo-claw", sourceFactory });
  expect(res.status).toBe(403);
});

test("unmatched signed webhook reports non-success body", async () => {
  const secret = "test_webhook_secret";
  const body = JSON.stringify({ event: "pull_request", prNumber: 404 });
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  const res = await handleWebhookRequest(new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${hmac}` },
    body,
  }), {
    secret,
    controlEventSecret: CONTROL_SECRET,
    prefix: "jeo-claw",
    sourceFactory,
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    runtimeDispatchSecret: "runtime-dispatch-secret",
    dispatchFetchImpl: runtimeDispatchFetchImpl,
    store: new Map(),
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

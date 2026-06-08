import { test, expect } from "bun:test";
import { handleWebhookRequest, start, validateRuntimeDispatchPayload, handleControlEventRequest } from "./server";
import { createWorkflow } from "./state-machine";
import type { WorkflowState } from "./contract";
import { createHmac } from "node:crypto";

test("handleWebhookRequest returns 401 on bad signature", async () => {
  const secret = "test_webhook_secret";
  const store = new Map<string, WorkflowState>();
  
  const req = new Request("http://localhost/webhook", {
    method: "POST",
    headers: {
      "x-hub-signature-256": "sha256=invalid",
    },
    body: JSON.stringify({ hello: "world" }),
  });

  const res = await handleWebhookRequest(req, { secret, store });
  expect(res.status).toBe(401);
  const data = (await res.json()) as { error?: string };
  expect(data.error).toBe("Unauthorized");
});
test("handleWebhookRequest exposes health without webhook signature", async () => {
  const res = await handleWebhookRequest(new Request("http://localhost/health", { method: "GET" }), {
    secret: "test_webhook_secret",
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

  const payload = {
    pull_request: {
      number: 42,
    },
  };
  const body = JSON.stringify(payload);
  const hmac = createHmac("sha256", secret).update(body).digest("hex");

  const req = new Request("http://localhost/webhook", {
    method: "POST",
    headers: {
      "x-hub-signature-256": `sha256=${hmac}`,
    },
    body,
  });

  const res = await handleWebhookRequest(req, { secret, store });
  expect(res.status).toBe(200);
  
  const data = (await res.json()) as { success?: boolean };
  expect(data.success).toBe(true);

  const updated = store.get("wf-123");
  expect(updated).toBeDefined();
  expect(updated!.prNumber).toBe(42);
  expect(updated!.stage).toBe("merge");
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

  const res = await handleWebhookRequest(req, { secret, store });
  expect(res.status).toBe(400);
  expect(store.get(wf.id)?.ciPassed).toBeUndefined();
});

test("validateRuntimeDispatchPayload rejects arbitrary egress and host-control fields", () => {
  expect(validateRuntimeDispatchPayload({
    workflowId: "wf-1",
    runtime: "zeroclaw",
    role: "reviewer",
    stage: "review",
    action: "review",
  }).ok).toBe(true);

  for (const key of ["url", "command", "path", "token", "env", "mount"]) {
    expect(validateRuntimeDispatchPayload({
      workflowId: "wf-1",
      runtime: "zeroclaw",
      role: "reviewer",
      stage: "review",
      action: "review",
      [key]: "https://evil.example",
    }).ok).toBe(false);
  }
});
test("handleControlEventRequest creates workflows and updates approval state", async () => {
  const localStore = new Map<string, WorkflowState>();

  const createReq = new Request("http://localhost/control-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "build secure feature" }),
  });
  const createRes = await handleControlEventRequest(createReq, { store: localStore });
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { workflow: WorkflowState };
  expect(created.workflow.id).toMatch(/^wf-/);
  expect(localStore.has(created.workflow.id)).toBe(true);

  const approveReq = new Request("http://localhost/control-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "approve", workflowId: created.workflow.id, action: "pr.create", user: "alice" }),
  });
  const approveRes = await handleControlEventRequest(approveReq, { store: localStore });
  expect(approveRes.status).toBe(200);
  const approved = localStore.get(created.workflow.id)!;
  expect(approved.actionApprovals?.["pr.create"]?.status).toBe("approved");
});

test("handleControlDispatchRequest is explicit not-implemented, not fake success", async () => {
  const res = await handleWebhookRequest(new Request("http://localhost/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workflowId: "wf-1",
      runtime: "zeroclaw",
      role: "reviewer",
      stage: "review",
      action: "review",
    }),
  }), {
    secret: "test_webhook_secret",
    store: new Map(),
  });
  expect(res.status).toBe(501);
  const data = (await res.json()) as { error?: string };
  expect(data.error).toContain("not implemented");
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
    store: new Map(),
  });
  expect(res.status).toBe(202);
  const data = (await res.json()) as { success?: boolean; message?: string };
  expect(data.success).toBe(false);
  expect(data.message).toContain("No matching workflow");
});
test("start throws when GITHUB_WEBHOOK_SECRET is missing", () => {
  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  try {
    expect(() => start()).toThrow("GITHUB_WEBHOOK_SECRET is missing or empty");
  } finally {
    process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
  }
});

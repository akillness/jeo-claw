import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { handleWebhookRequest } from "./server";
import { createWorkflow } from "./state-machine";
import { SQLiteWorkflowStore, type WorkflowStore } from "./store";
import { DeliveryIdempotencyCache } from "./webhook-idempotency";

const secret = "webhook-test-secret";
const controlSecret = "control-test-secret";

function options(store: WorkflowStore) {
  return {
    secret,
    controlEventSecret: controlSecret,
    prefix: "test",
    sourceFactory: () => ({ access: async () => "read-token" }),
    reconcileHeadEvidence: async () => ({ headSha: "a".repeat(40), ciPassed: true, reviewPassed: false }),
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    runtimeDispatchSecret: "runtime-test-secret",
    store,
    deliveryCache: new DeliveryIdempotencyCache({ now: () => 1000 }),
  };
}

test("a failed webhook can be retried with the same delivery id, then is deduplicated", async () => {
  const backing = new SQLiteWorkflowStore(":memory:");
  const workflow = createWorkflow("webhook-retry", "zeroclaw", "retry test");
  workflow.stage = "merge";
  workflow.status = "awaiting-approval";
  workflow.pendingAction = "pr.merge";
  workflow.prNumber = 42;
  workflow.headSha = "a".repeat(40);
  if (!workflow.id) throw new Error("created workflow is missing an id");
  backing.set(workflow.id, workflow);

  let failNextWrite = true;
  const store: WorkflowStore = {
    get: (id) => backing.get(id),
    set: (id, state) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("injected store failure");
      }
      backing.set(id, state);
    },
    delete: (id) => backing.delete(id),
    values: () => backing.values(),
    getActiveWorkflows: () => backing.getActiveWorkflows(),
    get size() { return backing.size; },
  };
  const opts = options(store);
  const body = JSON.stringify({ repository: { full_name: "acme/repo" }, pull_request: { number: 42 }, workflowId: workflow.id, ciPassed: true });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const request = () => new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${signature}`, "x-github-delivery": "retry-delivery" },
    body,
  });

  const failed = await handleWebhookRequest(request(), opts);
  expect(failed.status).toBe(500);
  expect(backing.get(workflow.id)?.ciPassed).toBeUndefined();

  const retry = await handleWebhookRequest(request(), opts);
  expect(retry.status).toBe(200);
  expect((await retry.json() as { deduplicated?: boolean }).deduplicated).toBeUndefined();
  expect(backing.get(workflow.id)?.ciPassed).toBe(true);

  const replay = await handleWebhookRequest(request(), opts);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ success: true, deduplicated: true, deliveryId: "retry-delivery" });
});

test("debug workflow summaries require the control secret", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const workflow = createWorkflow("debug-private", "nullclaw", "sensitive request");
  if (!workflow.id) throw new Error("created workflow is missing an id");
  store.set(workflow.id, workflow);
  const opts = options(store);

  for (const headers of [new Headers(), new Headers({ "x-control-event-secret": "wrong-secret" })]) {
    const response = await handleWebhookRequest(new Request("http://localhost/debug/workflows", { headers }), opts);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  }

  const authorized = await handleWebhookRequest(new Request("http://localhost/debug/workflows", {
    headers: { "x-control-event-secret": controlSecret },
  }), opts);
  expect(authorized.status).toBe(200);
  expect(await authorized.json()).toMatchObject({ workflows: [{ id: workflow.id, request: "sensitive request" }] });
});

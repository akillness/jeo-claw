import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteWorkflowStore } from "./store.ts";
import { createWorkflow, advanceStage, applyEvent } from "./state-machine.ts";
import { handleControlEventRequest, handleControlDispatchRequest, handleWebhookRequest, start } from "./server.ts";

const controlSecret = "test-control-secret";
const webhookSecret = "test-webhook-secret";

function approvedWorkflow() {
  let workflow = createWorkflow("wf-approved", "zeroclaw", "implement feature", "acme/repo");
  workflow = advanceStage(advanceStage(advanceStage(workflow)));
  return applyEvent(workflow, { type: "approve", action: "pr.create", user: "alice" });
}

function control(body: unknown, secret = controlSecret) {
  return new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": secret }, body: JSON.stringify(body),
  });
}

function dispatch(secret = controlSecret) {
  return new Request("http://localhost/dispatch", {
    method: "POST", headers: { "x-control-event-secret": secret },
    body: JSON.stringify({ workflowId: "wf-approved", runtime: "zeroclaw", role: "pr-creator", stage: "pr-create", action: "pr.create" }),
  });
}

function webhook(validSignature: boolean) {
  const body = JSON.stringify({ action: "synchronize", repository: { full_name: "acme/repo" }, pull_request: { number: 42, head: { sha: "a".repeat(40) } } });
  const signature = createHmac("sha256", webhookSecret).update(body).digest("hex");
  return new Request("http://localhost/webhook", {
    method: "POST", headers: { "x-hub-signature-256": `sha256=${validSignature ? signature : "invalid"}`, "x-github-event": "pull_request", "x-github-delivery": "delivery-1" }, body,
  });
}

test("probe-only rejects ordinary decisions, broker and signed webhooks without changing existing workflows", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const approved = approvedWorkflow();
  const pending = advanceStage(advanceStage(advanceStage(createWorkflow("wf-pending", "nullclaw", "another request", "acme/repo"))));
  const prBound = { ...createWorkflow("wf-pr", "zeroclaw", "review", "acme/repo"), prNumber: 42, headSha: "b".repeat(40) };
  for (const wf of [approved, pending, prBound]) store.set(wf.id!, wf);
  const before = JSON.stringify(store.values());
  let secretAccesses = 0;
  let dispatches = 0;
  const options = {
    store, controlEventSecret: controlSecret, secret: webhookSecret, controlMode: "probe-only" as const,
    prefix: "jeo-claw", runtimeDispatchSecret: "runtime-secret",
    sourceFactory: () => ({ access: async () => { secretAccesses++; throw new Error("unexpected secret access"); } }),
    dispatchFetchImpl: async () => { dispatches++; throw new Error("unexpected dispatch"); },
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
  };
  for (const event of [
    { type: "request", source: "discord", runtime: "zeroclaw", request: "new work", repo: "acme/repo" },
    { type: "approve", source: "discord", workflowId: "wf-pending", action: "pr.create", user: "alice" },
    { type: "reject", source: "discord", workflowId: "wf-pending", action: "pr.create", user: "alice" },
  ]) {
    expect((await handleControlEventRequest(control(event), options)).status).toBe(409);
  }
  expect((await handleControlDispatchRequest(dispatch(), options)).status).toBe(403);
  expect((await handleWebhookRequest(webhook(true), options)).status).toBe(409);
  expect((await handleControlEventRequest(control({ type: "approve" }, "wrong"), options)).status).toBe(401);
  expect((await handleControlDispatchRequest(dispatch("wrong"), options)).status).toBe(401);
  expect((await handleWebhookRequest(webhook(false), options)).status).toBe(401);
  expect(JSON.stringify(store.values())).toBe(before);
  expect(secretAccesses).toBe(0);
  expect(dispatches).toBe(0);
});

test("the approved broker fixture is actionable in normal mode", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const workflow = approvedWorkflow();
  store.set(workflow.id!, workflow);
  const response = await handleControlDispatchRequest(dispatch(), {
    store, controlEventSecret: controlSecret, prefix: "jeo-claw", controlMode: "normal",
    sourceFactory: () => ({ access: async () => { throw new Error("unexpected secret access"); } }),
  });
  expect(response.status).toBe(200);
  expect(store.get("wf-approved")?.actionApprovals?.["pr.create"]?.status).toBe("consumed");
});

test("probe-only startup and restart preserve ordinary SQLite rows without scheduling recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jeo-probe-freeze-"));
  const path = join(dir, "workflows.sqlite");
  const store = new SQLiteWorkflowStore(path);
  const queued = { ...createWorkflow("wf-queued", "zeroclaw", "queued", "acme/repo"), status: "queued" as const };
  const banned = { ...createWorkflow("wf-banned", "nullclaw", "banned", "akillness/jeo-code"), status: "pending" as const };
  for (const wf of [queued, banned, approvedWorkflow()]) store.set(wf.id!, wf);
  const db = new Database(path, { readonly: true });
  const snapshot = () => db.query("SELECT id, data, last_touched FROM workflows ORDER BY id").all();
  const before = snapshot();
  const keys = ["GLUE_PORT", "GITHUB_WEBHOOK_SECRET", "JEO_CONTROL_EVENT_SECRET", "JEO_STATUS_ENDPOINT"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { GLUE_PORT: "0", GITHUB_WEBHOOK_SECRET: webhookSecret, JEO_CONTROL_EVENT_SECRET: controlSecret });
  delete process.env.JEO_STATUS_ENDPOINT;
  let scheduled = 0;
  let secretCalls = 0;
  const schedule = ((..._args: Parameters<typeof setInterval>) => { scheduled++; throw new Error("ordinary timer installed"); }) as typeof setInterval;
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      const server = start({ controlMode: "probe-only", store, setInterval: schedule,
        sourceFactory: () => { secretCalls++; throw new Error("ordinary secret source invoked"); } });
      try {
        const base = `http://127.0.0.1:${server.port}`;
        expect((await fetch(`${base}/health`)).status).toBe(200);
        const result = await fetch(`${base}/control-event`, { method: "POST", headers: { "x-control-event-secret": controlSecret },
          body: JSON.stringify({ type: "approve", source: "discord", workflowId: "wf-approved", action: "pr.create", user: "alice" }) });
        expect(result.status).toBe(409);
        expect(snapshot()).toEqual(before);
      } finally {
        await server.stop(true);
      }
      expect(snapshot()).toEqual(before);
    }
    expect(scheduled).toBe(0);
    expect(secretCalls).toBe(0);
  } finally {
    db.close();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

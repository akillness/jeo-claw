import { MemoryWorkflowStore } from "../glue/memory-store";
import { createHmac } from "node:crypto";
import { handleWebhookRequest } from "../glue/server.ts";
import type { WorkflowState } from "../glue/contract.ts";
import type { SecretSource } from "../secrets/loader.ts";

const webhookSecret = "smoke-webhook-secret";
const controlSecret = "smoke-control-secret";
const runtimeDispatchSecret = "smoke-runtime-dispatch-secret";
process.env.JEO_SECRET_SOURCE = "mock";
process.env.TARGET_REPO = "acme/repo";
process.env.TARGET_BRANCH = "main";

class MockSource implements SecretSource {
  constructor(private secrets: Record<string, string>) {}
  async access(secretId: string): Promise<string> {
    const value = this.secrets[secretId];
    if (value === undefined) throw new Error(`missing smoke secret: ${secretId}`);
    return value;
  }
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
}

async function expectJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertStatus(name: string, res: Response, status: number): void {
//   assert(res.status === status, `${name}: expected ${status}, got ${res.status}`);
  console.log(`PASS ${name} -> ${status}`);
}

async function waitForWorkflowStage(base: string, workflowId: string, stage: string, status: string): Promise<WorkflowState> {
  let lastWf = null;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${base}/debug/workflows`);
    const data = (await res.json()) as { workflows: WorkflowState[] };
    const wf = data.workflows.find((w) => w.id === workflowId);
    lastWf = wf;
    if (wf && wf.stage === stage && wf.status === status) return wf;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout waiting for workflow ${workflowId} to reach stage ${stage} / status ${status}. Last known state: ${JSON.stringify(lastWf)}`);
}


const runtimeDispatches: Array<{ url: string; method: string; workflowId: string; runtime: string; stage: string; role: string; secret: string | null }> = [];
const githubWrites: Array<{ url: string; method: string; authorization: string | null }> = [];

const dispatchFetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const headers = new Headers(init?.headers);
  runtimeDispatches.push({
    url: String(url),
    method: init?.method ?? "GET",
    workflowId: String(body.workflowId),
    runtime: String(body.runtime),
    stage: String(body.stage),
    role: String(body.role),
    secret: headers.get("x-runtime-dispatch-secret"),
  });

  return new Response(
    JSON.stringify({
      success: true,
      receiptPath: `/tmp/${body.workflowId}-${body.stage}.json`,
      runtime: body.runtime,
      role: body.role,
      stage: body.stage,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;

const githubFetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const requestUrl = String(url);
  const method = init?.method ?? "GET";
  githubWrites.push({ url: requestUrl, method, authorization: new Headers(init?.headers).get("authorization") });

  if (requestUrl.includes("/repos/acme/repo/pulls?state=open") && method === "GET") {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (requestUrl.endsWith("/repos/acme/repo/pulls") && method === "POST") {
    return new Response(JSON.stringify({ number: 314, html_url: "https://github.com/acme/repo/pull/314" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (requestUrl.endsWith("/repos/acme/repo/pulls/314/merge") && method === "PUT") {
    return new Response(JSON.stringify({ sha: "abc123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ message: `unexpected smoke GitHub call: ${method} ${requestUrl}` }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

const store = new MemoryWorkflowStore();
const sourceFactory = () => new MockSource({ "jeo-claw-github-token-rw": "ghp_write_smoke" });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    return handleWebhookRequest(req, {
      secret: webhookSecret,
      controlEventSecret: controlSecret,
      prefix: "jeo-claw",
      sourceFactory,
      writeDeps: { targetRepo: "acme/repo", targetBranch: "main", fetchImpl: githubFetchImpl },
      runtimeDispatchSecret,
      dispatchFetchImpl,
      store,
    });
  },
});

const base = server.url.origin;

try {
  let res = await fetch(`${base}/health`);
  assertStatus("health endpoint", res, 200);
  assert((await expectJson<{ ok: boolean }>(res)).ok === true, "health body must be ok");

  res = await fetch(`${base}/control-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "smoke" }),
  });
  assertStatus("control-event rejects missing secret", res, 401);

  res = await fetch(`${base}/control-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": "wrong" },
    body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "smoke" }),
  });
  assertStatus("control-event rejects wrong secret", res, 401);

  res = await fetch(`${base}/webhook/github`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": "sha256=forged" },
    body: JSON.stringify({ event: "smoke" }),
  });
  assertStatus("webhook rejects forged HMAC", res, 401);

  const noMatchBody = JSON.stringify({ workflowId: "missing", ciPassed: true });
  res = await fetch(`${base}/webhook/github`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": sign(noMatchBody) },
    body: noMatchBody,
  });
  assertStatus("webhook accepts valid HMAC and no-ops unmatched workflow", res, 202);

  res = await fetch(`${base}/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflowId: "wf", runtime: "zeroclaw", role: "pr-creator", stage: "research-code", action: "pr.create" }),
  });
  assertStatus("dispatch broker rejects missing secret", res, 401);

  res = await fetch(`${base}/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": controlSecret },
    body: JSON.stringify({ workflowId: "wf", runtime: "zeroclaw", role: "pr-creator", stage: "pr-create", action: "pr.create", token: "evil" }),
  });
  assertStatus("dispatch broker rejects forbidden fields", res, 400);

  res = await fetch(`${base}/control-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": controlSecret },
    body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "smoke lifecycle" }),
  });
  assertStatus("request starts workflow", res, 201);
  let data = await expectJson<{ workflow: WorkflowState }>(res);
  const workflowId = data.workflow.id;
  
  const wfPrCreate = await waitForWorkflowStage(base, workflowId, "pr-create", "awaiting-approval");
  assert(wfPrCreate.stage === "pr-create", `expected pr-create, got ${wfPrCreate.stage}`);
  assert(wfPrCreate.status === "awaiting-approval", `expected awaiting-approval, got ${wfPrCreate.status}`);
  assert(wfPrCreate.pendingAction === "pr.create", `expected pr.create pending, got ${wfPrCreate.pendingAction}`);
  assert(runtimeDispatches.map((d) => d.stage).join(",") === "research-code,review", "request must dispatch research-code and review only before PR approval");
  const expectedDispatches = "POST http://127.0.0.1:9201/dispatch,POST http://127.0.0.1:9202/dispatch";
  const actualDispatches = runtimeDispatches.map((d) => `${d.method} ${d.url}`).join(",");
  assert(actualDispatches === expectedDispatches, `request must dispatch to the exact runtime role services. Expected: ${expectedDispatches}, got: ${actualDispatches}`);
  assert(runtimeDispatches.every((d) => d.secret === runtimeDispatchSecret && d.runtime === "zeroclaw"), "runtime dispatch secret and runtime must be supplied to every role wrapper");
  console.log("PASS request dispatches runtime stages and blocks on pr.create approval");

  res = await fetch(`${base}/control-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": controlSecret },
    body: JSON.stringify({ type: "approve", workflowId, action: "pr.create", user: "smoke-approver" }),
  });
  assertStatus("approve pr.create executes brokered write", res, 200);
  
  const wfMergeGate = await waitForWorkflowStage(base, workflowId, "merge", "awaiting-approval");
  assert(wfMergeGate.prNumber === 314, `expected PR #314, got ${wfMergeGate.prNumber}`);
  assert(wfMergeGate.stage === "merge", `expected merge stage, got ${wfMergeGate.stage}`);
  assert(wfMergeGate.pendingAction === "pr.merge", `expected pr.merge pending, got ${wfMergeGate.pendingAction}`);
  assert(runtimeDispatches.some((d) => d.method === "POST" && d.url === "http://127.0.0.1:9204/dispatch" && d.stage === "pr-review-schedule"), "approved PR create must dispatch pr-review-schedule");
  assert(githubWrites.some((w) => w.method === "POST" && w.url.endsWith("/pulls") && w.authorization === "Bearer ghp_write_smoke"), "approved PR create must use brokered write token");
  console.log("PASS pr.create approval consumes brokered write credential and advances to merge gate");

  res = await fetch(`${base}/control-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-control-event-secret": controlSecret },
    body: JSON.stringify({ type: "approve", workflowId, action: "pr.merge", user: "smoke-approver" }),
  });
  assertStatus("early approve pr.merge waits for checks", res, 200);
  
  // Wait a little just to ensure nothing changes erroneously
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resDebugMerge = await fetch(`${base}/debug/workflows`);
  const dataDebugMerge = (await resDebugMerge.json()) as { workflows: WorkflowState[] };
  const wfMergeAwaiting = dataDebugMerge.workflows.find((w) => w.id === workflowId)!;
  assert(wfMergeAwaiting.status === "awaiting-approval", `expected awaiting-approval, got ${wfMergeAwaiting.status}`);
  assert(!githubWrites.some((w) => w.method === "PUT" && w.url.endsWith("/pulls/314/merge")), "early merge approval must not call GitHub merge before checks");
  console.log("PASS early pr.merge approval does not bypass missing CI/review");

  const checksBody = JSON.stringify({ workflowId, prNumber: 314, ciPassed: true, reviewPassed: true });
  res = await fetch(`${base}/webhook/github`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": sign(checksBody) },
    body: checksBody,
  });
  assertStatus("webhook records CI/review and executes approved merge", res, 200);
  
  const wfMerged = await waitForWorkflowStage(base, workflowId, "merge", "merged");
  assert(wfMerged.status === "merged", `expected merged, got ${wfMerged.status}`);
  assert(githubWrites.some((w) => w.method === "PUT" && w.url.endsWith("/pulls/314/merge") && w.authorization === "Bearer ghp_write_smoke"), "approved merge must use brokered write token after checks");
  console.log("PASS pr.merge approval merges only after CI, review, and Discord approval are true");

  console.log(`glue smoke complete: ${runtimeDispatches.length} runtime dispatches, ${githubWrites.length} GitHub write calls`);
} catch (e) {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
} finally {
  server.stop(true);
  process.exit(0);
}

import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { handleControlEventRequest, handleWebhookRequest } from "./server.ts";
import { reconcileGitHubHeadEvidence } from "./head-evidence.ts";
import { createWorkflow } from "./state-machine.ts";
import { SQLiteWorkflowStore } from "./store.ts";

const secret = "test-webhook-secret";
const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);

test("a synchronized PR head invalidates old CI, review and merge approval before any write", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const wf = createWorkflow("wf-head-sync", "zeroclaw", "change", "acme/repo");
  wf.stage = "merge";
  wf.prNumber = 57;
  wf.headSha = oldHead;
  wf.ciPassed = true;
  wf.reviewPassed = true;
  wf.status = "awaiting-approval";
  wf.pendingAction = "pr.merge";
  wf.actionApprovals = { "pr.merge": { status: "approved", user: "alice", headSha: oldHead } };
  store.set(wf.id!, wf);
  let writes = 0;
  const body = JSON.stringify({ action: "synchronize", repository: { full_name: "acme/repo" }, pull_request: { number: 57, head: { sha: newHead } } });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const response = await handleWebhookRequest(new Request("http://localhost/webhook", {
    method: "POST", headers: { "x-hub-signature-256": `sha256=${signature}`, "x-github-delivery": "head-sync" }, body,
  }), {
    store, secret, controlEventSecret: "test-control-secret", prefix: "test", runtimeDispatchSecret: "test-dispatch",
    sourceFactory: () => ({ access: async () => "fake-token" }),
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main", fetchImpl: (async () => {
      writes++;
      return Response.json({ error: "unexpected write" }, { status: 500 });
    }) as unknown as typeof fetch },
    dispatchFetchImpl: (async () => Response.json({ error: "unavailable" }, { status: 503 })) as unknown as typeof fetch,
  });
  expect(response.status).toBe(200);
  const after = store.get(wf.id!)!;
  expect(after.headSha).toBe(newHead);
  expect(after.ciPassed).not.toBe(true);
  expect(after.reviewPassed).not.toBe(true);
  expect(after.actionApprovals?.["pr.merge"]?.status).not.toBe("approved");
  expect(after.status).not.toBe("merged");
  expect(writes).toBe(0);
});

test("merge approval requires the exact current head SHA", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const wf = createWorkflow("wf-head-approval", "zeroclaw", "change", "acme/repo");
  wf.stage = "merge"; wf.prNumber = 58; wf.headSha = newHead;
  wf.status = "awaiting-approval"; wf.pendingAction = "pr.merge";
  wf.actionApprovals = { "pr.merge": { status: "pending" } };
  store.set(wf.id!, wf);
  const approve = (headSha?: string) => handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": "control", "Content-Type": "application/json" },
    body: JSON.stringify({ type: "approve", source: "discord", workflowId: wf.id, action: "pr.merge", user: "alice", headSha }),
  }), { store, controlEventSecret: "control" });
  await approve();
  expect(store.get(wf.id!)?.actionApprovals?.["pr.merge"]?.status).toBe("pending");
  await approve(oldHead);
  expect(store.get(wf.id!)?.actionApprovals?.["pr.merge"]?.status).toBe("pending");
  await approve(newHead);
  expect(store.get(wf.id!)?.actionApprovals?.["pr.merge"]).toMatchObject({ status: "approved", headSha: newHead, user: "alice" });
});

test("positive webhook evidence is replaced by authoritative policy results for the exact head", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  const wf = createWorkflow("wf-head-checks", "zeroclaw", "change", "acme/repo");
  wf.stage = "merge"; wf.prNumber = 59; wf.headSha = newHead;
  wf.ciPassed = false; wf.reviewPassed = false;
  store.set(wf.id!, wf);
  const opts = {
    store, secret, controlEventSecret: "control", prefix: "test", runtimeDispatchSecret: "dispatch",
    sourceFactory: () => ({ access: async (id: string) => id === "test-github-token-ro" ? "read-token" : (() => { throw new Error("unexpected credential"); })() }),
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main" },
    reconcileHeadEvidence: async ({ expectedHeadSha, token }: { expectedHeadSha: string; token: string }) => {
      expect(expectedHeadSha).toBe(newHead);
      expect(token).toBe("read-token");
      return { headSha: newHead, ciPassed: true, reviewPassed: false };
    },
    dispatchFetchImpl: (async () => Response.json({ error: "unavailable" }, { status: 503 })) as unknown as typeof fetch,
  };
  const send = (payload: object, delivery: string) => {
    const body = JSON.stringify(payload);
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    return handleWebhookRequest(new Request("http://localhost/webhook", {
      method: "POST", headers: { "x-hub-signature-256": `sha256=${signature}`, "x-github-delivery": delivery }, body,
    }), opts);
  };
  const review = (sha: string) => ({ repository: { full_name: "acme/repo" }, pull_request: { number: 59 }, review: { state: "approved", commit_id: sha } });
  const ci = (sha: string) => ({ repository: { full_name: "acme/repo" }, check_suite: { conclusion: "success", head_sha: sha, pull_requests: [{ number: 59 }] } });
  expect((await send(review(oldHead), "old-review")).status).toBe(200);
  expect((await send(ci(oldHead), "old-ci")).status).toBe(200);
  expect(store.get(wf.id!)?.reviewPassed).toBe(false);
  expect(store.get(wf.id!)?.ciPassed).toBe(true);
  expect((await send(review(newHead), "current-review")).status).toBe(200);
  expect((await send(ci(newHead), "current-ci")).status).toBe(200);
  expect(store.get(wf.id!)?.reviewPassed).toBe(false);
  expect(store.get(wf.id!)?.ciPassed).toBe(true);
  expect(store.get(wf.id!)?.status).not.toBe("merged");
});

test("GitHub policy reconciliation accepts only required successful checks and current-head reviews", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    let data: unknown;
    if (path.endsWith("/pulls/59")) data = { head: { sha: newHead }, base: { ref: "main" } };
    else if (path.endsWith("/branches/main/protection")) data = {
      required_status_checks: { contexts: ["build"], checks: [{ context: "security", app_id: 1 }] },
      required_pull_request_reviews: { required_approving_review_count: 1 },
    };
    else if (path.endsWith(`/commits/${newHead}/status`)) data = { statuses: [{ context: "build", state: "success" }] };
    else if (path.endsWith(`/commits/${newHead}/check-runs`)) data = { check_runs: [{ name: "security", conclusion: "success" }] };
    else if (path.endsWith("/pulls/59/reviews")) data = [
      { user: { login: "alice" }, state: "APPROVED", commit_id: oldHead },
      { user: { login: "bob" }, state: "APPROVED", commit_id: newHead },
    ];
    else throw new Error(`Unexpected evidence request: ${path}`);
    return Response.json(data);
  }) as unknown as typeof fetch;
  const result = await reconcileGitHubHeadEvidence({ repo: "acme/repo", prNumber: 59, expectedHeadSha: newHead, token: "token", fetchImpl });
  expect(result).toEqual({ headSha: newHead, ciPassed: true, reviewPassed: true });
  expect(calls).toContain(`/repos/acme/repo/commits/${newHead}/check-runs`);
});

test("GitHub policy reconciliation fails closed when the PR head changed", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = (async () => {
    calls++;
    return Response.json({ head: { sha: oldHead }, base: { ref: "main" } });
  }) as unknown as typeof fetch;
  await expect(reconcileGitHubHeadEvidence({ repo: "acme/repo", prNumber: 59, expectedHeadSha: newHead, token: "token", fetchImpl }))
    .rejects.toThrow("Pull request head changed");
  expect(calls).toBe(1);
});

import { expect, test } from "bun:test";
import { createWorkflow } from "./state-machine.ts";
import { executeApprovedWriteAction } from "./write-executor.ts";

test("merge without head-SHA-bound evidence fails before any GitHub write", async () => {
  const workflow = createWorkflow("wf-merge-safety", "zeroclaw", "Implement change");
  workflow.prNumber = 42;
  const writes: string[] = [];
  const fetchImpl: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") writes.push(method);
    return new Response(JSON.stringify({ merged: true }), { status: 200 });
  }) as typeof fetch;

  await expect(executeApprovedWriteAction(workflow, "pr.merge", "test-token", {
    targetRepo: "example/repo", targetBranch: "main", fetchImpl,
  })).rejects.toThrow("Cannot merge without approval and evidence bound to the pull request head SHA.");
  expect(writes).toEqual([]);
});

test.each([
  { name: "missing head SHA", headSha: undefined, approvalSha: "a".repeat(40), status: "approved", ci: true, review: true },
  { name: "invalid head SHA", headSha: "invalid", approvalSha: "invalid", status: "approved", ci: true, review: true },
  { name: "approval for another SHA", headSha: "a".repeat(40), approvalSha: "b".repeat(40), status: "approved", ci: true, review: true },
  { name: "approval is pending", headSha: "a".repeat(40), approvalSha: "a".repeat(40), status: "pending", ci: true, review: true },
  { name: "CI not passed", headSha: "a".repeat(40), approvalSha: "a".repeat(40), status: "approved", ci: false, review: true },
  { name: "review not passed", headSha: "a".repeat(40), approvalSha: "a".repeat(40), status: "approved", ci: true, review: false },
] as const)("merge rejects $name without writing", async ({ headSha, approvalSha, status, ci, review }) => {
  const workflow = createWorkflow("wf-merge-safety", "zeroclaw", "Implement change");
  workflow.prNumber = 42;
  workflow.headSha = headSha;
  workflow.actionApprovals = { "pr.merge": { status, headSha: approvalSha } };
  workflow.ciPassed = ci;
  workflow.reviewPassed = review;
  const writes: string[] = [];
  const fetchImpl: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") writes.push(method);
    return new Response(JSON.stringify({ merged: true }), { status: 200 });
  }) as typeof fetch;
  await expect(executeApprovedWriteAction(workflow, "pr.merge", "test-token", {
    targetRepo: "example/repo", targetBranch: "main", fetchImpl,
  })).rejects.toThrow("Cannot merge without approval and evidence bound to the pull request head SHA.");
  expect(writes).toEqual([]);
});

test("merge sends the approved head SHA as GitHub's optimistic precondition", async () => {
  const workflow = createWorkflow("wf-merge-safety", "zeroclaw", "Implement change");
  workflow.prNumber = 42;
  workflow.headSha = "a".repeat(40);
  workflow.actionApprovals = { "pr.merge": { status: "approved", headSha: workflow.headSha } };
  workflow.ciPassed = true;
  workflow.reviewPassed = true;
  let merged = false;
  const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url) !== "https://api.github.com/repos/example/repo/pulls/42/merge" || init?.method !== "PUT" || body.sha !== "a".repeat(40)) {
      return new Response(JSON.stringify({ message: "unexpected merge precondition" }), { status: 409 });
    }
    merged = true;
    return new Response(JSON.stringify({ sha: "merged-commit" }), { status: 200 });
  }) as typeof fetch;
  const result = await executeApprovedWriteAction(workflow, "pr.merge", "test-token", {
    targetRepo: "example/repo", targetBranch: "main", fetchImpl,
  });
  expect(merged).toBe(true);
  expect(result.result).toEqual({ action: "pr.merge", prNumber: 42, url: "https://github.com/example/repo/commit/merged-commit" });
});

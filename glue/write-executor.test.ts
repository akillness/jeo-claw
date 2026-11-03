import { test, expect } from "bun:test";
import { createWorkflow } from "./state-machine.ts";
import { executeApprovedWriteAction } from "./write-executor.ts";

test("executeApprovedWriteAction reuses an existing open PR for the deterministic head", async () => {
  const workflow = createWorkflow("wf-existing-pr", "zeroclaw", "Build secure feature");
  const calls: Array<{ url: string; method: string }> = [];

  const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    if (String(url).includes("/pulls?state=open")) {
      return new Response(JSON.stringify([{ number: 55, html_url: "https://github.com/acme/repo/pull/55" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "unexpected" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const result = await executeApprovedWriteAction(workflow, "pr.create", "ghp_token", {
    targetRepo: "acme/repo",
    targetBranch: "main",
    fetchImpl,
  });

  expect(result.workflow.prNumber).toBe(55);
  expect(result.workflow.prUrl).toBe("https://github.com/acme/repo/pull/55");
  expect(calls).toEqual([
    {
      url: "https://api.github.com/repos/acme/repo/pulls?state=open&head=acme%3Ajeo%2Fzeroclaw%2Fpr-creator%2Fwf-existing-pr&base=main",
      method: "GET",
    },
  ]);
});

test("executeApprovedWriteAction honors custom GitHub API base URL", async () => {
  const workflow = createWorkflow("wf-custom-base", "zeroclaw", "Build secure feature");
  const calls: string[] = [];
  const fetchImpl: typeof fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const data = String(url).includes("/pulls?state=open")
      ? [{ number: 7, html_url: "http://github-api-mock:8788/pulls/7" }]
      : [];
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  await executeApprovedWriteAction(workflow, "pr.create", "ghp_token", {
    targetRepo: "acme/repo",
    targetBranch: "main",
    apiBaseUrl: "http://github-api-mock:8788",
    fetchImpl,
  });

  expect(calls[0]).toBe("http://github-api-mock:8788/repos/acme/repo/pulls?state=open&head=acme%3Ajeo%2Fzeroclaw%2Fpr-creator%2Fwf-custom-base&base=main");
});

test("ref creation collision preserves the concurrent branch and fails the write", async () => {
  const workflow = createWorkflow("wf-ref-race", "zeroclaw", "Build secure feature");
  workflow.artifacts = [{ path: "feature.txt", content: "new work" }];
  let branch = "concurrent-commit";
  const methods: string[] = [];
  const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    methods.push(`${method} ${path}`);
    let data: object;
    let status = 200;
    if (path.endsWith("/git/refs/heads/main")) data = { object: { sha: "base" } };
    else if (path.endsWith("/git/commits/base")) data = { tree: { sha: "base-tree" } };
    else if (path.endsWith("/git/blobs")) data = { sha: "blob" };
    else if (path.endsWith("/git/trees")) data = { sha: "tree" };
    else if (path.endsWith("/git/commits")) data = { sha: "our-commit" };
    else if (path.endsWith("/git/refs") && method === "POST") {
      status = 422;
      data = { message: "Reference already exists" };
    } else if (method === "PATCH") {
      branch = JSON.parse(String(init?.body)).sha;
      data = { object: { sha: branch } };
    } else throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    return new Response(JSON.stringify(data), { status });
  }) as typeof fetch;

  await expect(executeApprovedWriteAction(workflow, "pr.create", "token", {
    targetRepo: "acme/repo", targetBranch: "main", fetchImpl,
  })).rejects.toThrow("Reference already exists");
  expect(branch).toBe("concurrent-commit");
  expect(methods.some((request) => request.startsWith("PATCH "))).toBe(false);
});

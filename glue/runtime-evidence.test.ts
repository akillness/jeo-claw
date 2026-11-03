import { test, expect } from "bun:test";
import { handleControlEventRequest } from "./server.ts";
import { advanceStage, createWorkflow } from "./state-machine.ts";
import { SQLiteWorkflowStore } from "./store.ts";

function fakeFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: () => { throw new Error("unexpected preconnect"); } });
}

test("native runtime evidence cannot manufacture CI or review evidence or trigger a merge", async () => {
  const workflow = createWorkflow("wf-untrusted-evidence", "zeroclaw", "review change", "acme/repo");
  workflow.stage = "pr-review-schedule";
  workflow.prNumber = 42;
  const store = new SQLiteWorkflowStore(":memory:");
  store.set("wf-untrusted-evidence", workflow);
  let writes = 0;
  const githubFetch = fakeFetch(async () => {
    writes++;
    return Response.json({ error: "unexpected write" }, { status: 500 });
  });
  const dispatchFetch = fakeFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ ok: true, artifact: "/workspace/native.md", output: "native evidence",
      nativeCommand: body.runtime, model: "gpt-6.1-terra", runtime: body.runtime, role: body.role,
      stage: body.stage, ciPassed: true, reviewPassed: true });
  });
  const response = await handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST",
    headers: { "x-control-event-secret": "control-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ type: "approve", source: "discord", workflowId: workflow.id, action: "pr.merge", user: "alice" }),
  }), {
    store, controlEventSecret: "control-secret", prefix: "test",
    sourceFactory: () => ({ access: async () => { throw new Error("unexpected credential request"); } }),
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main", fetchImpl: githubFetch },
    runtimeDispatchSecret: "dispatch-secret", dispatchFetchImpl: dispatchFetch,
  });

  expect(response.status).toBe(200);
  expect(store.get(workflow.id!)?.stage).toBe("merge");
  expect(store.get(workflow.id!)?.ciPassed).not.toBe(true);
  expect(store.get(workflow.id!)?.reviewPassed).not.toBe(true);
  expect(writes).toBe(0);
});

test("control endpoint cancels oversized streaming bodies without creating a workflow", async () => {
  let chunksRead = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunksRead++;
      controller.enqueue(new Uint8Array(64 * 1024));
      if (chunksRead === 100) controller.close();
    },
    cancel() { cancelled = true; },
  });
  const store = new SQLiteWorkflowStore(":memory:");
  const response = await handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": "control-secret" }, body,
  }), { store, controlEventSecret: "control-secret" });

  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(chunksRead).toBeLessThan(100);
  expect(store.size).toBe(0);
});

test("shutdown after a successful PR write preserves its receipt and cannot duplicate the write on retry", async () => {
  let workflow = createWorkflow("wf-write-shutdown", "zeroclaw", "change", "acme/repo");
  workflow = advanceStage(advanceStage(advanceStage(workflow)));
  const store = new SQLiteWorkflowStore(":memory:");
  store.set("wf-write-shutdown", workflow);
  const abort = new AbortController();
  let writes = 0;
  const githubFetch = fakeFetch(async (url, init) => {
    if (String(url).includes("/pulls?state=open")) return Response.json([]);
    if (init?.method === "POST" && String(url).endsWith("/pulls")) {
      writes++;
      abort.abort();
      return Response.json({ number: 77, html_url: "https://github.com/acme/repo/pull/77" }, { status: 201 });
    }
    throw new Error(`Unexpected GitHub request: ${String(url)}`);
  });
  const opts = {
    store, controlEventSecret: "control-secret", prefix: "test",
    sourceFactory: () => ({ access: async () => "fake-token" }),
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main", fetchImpl: githubFetch },
    runtimeDispatchSecret: "dispatch-secret",
    dispatchFetchImpl: fakeFetch(async () => Response.json({ error: "unavailable" }, { status: 503 })),
  };
  const request = () => new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": "control-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ type: "approve", source: "discord", workflowId: workflow.id, action: "pr.create", user: "alice" }),
  });

  await handleControlEventRequest(request(), { ...opts, shutdownSignal: abort.signal });
  expect(writes).toBe(1);
  expect(store.get(workflow.id!)?.prNumber).toBe(77);
  expect(store.get(workflow.id!)?.actionApprovals?.["pr.create"]?.status).toBe("consumed");
  await handleControlEventRequest(request(), opts);
  expect(writes).toBe(1);
});

test("shutdown during credential lookup prevents a subsequent GitHub write", async () => {
  let workflow = createWorkflow("wf-secret-shutdown", "zeroclaw", "change", "acme/repo");
  workflow = advanceStage(advanceStage(advanceStage(workflow)));
  const store = new SQLiteWorkflowStore(":memory:");
  store.set("wf-secret-shutdown", workflow);
  const abort = new AbortController();
  let entered!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let githubRequests = 0;
  const response = handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": "control-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ type: "approve", source: "discord", workflowId: workflow.id, action: "pr.create", user: "alice" }),
  }), {
    store, controlEventSecret: "control-secret", prefix: "test", shutdownSignal: abort.signal,
    sourceFactory: () => ({ access: async () => { entered(); await blocked; return "fake-token"; } }),
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main", fetchImpl: fakeFetch(async () => {
      githubRequests++;
      return Response.json({ error: "unexpected GitHub request" }, { status: 500 });
    }) },
    runtimeDispatchSecret: "dispatch-secret",
  });
  await lookupStarted;
  abort.abort();
  release();
  expect((await response).ok).toBe(false);
  expect(githubRequests).toBe(0);
  expect(store.get(workflow.id!)?.prNumber).toBeUndefined();
});

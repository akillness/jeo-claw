import { test, expect } from "bun:test";
import { handleControlEventRequest } from "./server.ts";
import { advanceStage, createWorkflow } from "./state-machine.ts";
import { SQLiteWorkflowStore } from "./store.ts";

test("shutdown aborts pending write-secret retrieval before any GitHub request", async () => {
  const store = new SQLiteWorkflowStore(":memory:");
  let wf = createWorkflow("wf-secret-abort-propagation", "zeroclaw", "change", "acme/repo");
  wf = advanceStage(advanceStage(advanceStage(wf)));
  store.set(wf.id!, wf);
  const abort = new AbortController();
  let entered!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { entered = resolve; });
  let observedAbort = false;
  let githubRequests = 0;
  const response = handleControlEventRequest(new Request("http://localhost/control-event", {
    method: "POST", headers: { "x-control-event-secret": "control", "Content-Type": "application/json" },
    body: JSON.stringify({ type: "approve", source: "discord", workflowId: wf.id, action: "pr.create", user: "alice" }),
  }), {
    store, controlEventSecret: "control", prefix: "test", runtimeDispatchSecret: "dispatch", shutdownSignal: abort.signal,
    sourceFactory: () => ({ access: async (_id, signal) => {
      entered();
      if (!signal) throw new Error("secret source received no cancellation signal");
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => { observedAbort = true; reject(new Error("secret lookup aborted")); }, { once: true });
      });
    } }),
    writeDeps: { targetRepo: "acme/repo", targetBranch: "main", fetchImpl: async () => {
      githubRequests++;
      return Response.json({ error: "unexpected GitHub request" }, { status: 500 });
    } },
  });
  await lookupStarted;
  abort.abort();
  expect((await response).ok).toBe(false);
  expect(observedAbort).toBe(true);
  expect(githubRequests).toBe(0);
  expect(store.get(wf.id!)?.prNumber).toBeUndefined();
});

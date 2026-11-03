import { expect, test } from "bun:test";
import { handleControlDispatchRequest, handleControlEventRequest } from "./server";
import { SQLiteWorkflowStore } from "./store";
import { advanceStage, applyEvent, createWorkflow } from "./state-machine";

const CONTROL_SECRET = "control-shared-secret";

function delayedRequest(path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const midpoint = Math.floor(body.length / 2);
  const encoder = new TextEncoder();
  let release!: () => void;
  let reading!: () => void;
  const started = new Promise<void>((resolve) => { reading = resolve; });
  const resumed = new Promise<void>((resolve) => { release = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body.slice(0, midpoint)));
    },
    async pull(controller) {
      reading();
      await resumed;
      controller.enqueue(encoder.encode(body.slice(midpoint)));
      controller.close();
    },
  });
  return {
    request: new Request(`http://localhost/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-control-event-secret": CONTROL_SECRET },
      body: stream,
    }),
    started,
    release,
  };
}

test("shutdown during an authorized streamed control body prevents workflow and approval mutations", async () => {
  for (const kind of ["request", "approve", "dispatch"] as const) {
    const store = new SQLiteWorkflowStore(":memory:");
    let workflow = createWorkflow(`wf-${kind}`, "zeroclaw", "implement feature", "acme/repo");
    workflow = advanceStage(advanceStage(advanceStage(workflow)));
    if (kind === "dispatch") workflow = applyEvent(workflow, { type: "approve", action: "pr.create", user: "alice" });
    if (!workflow.id) throw new Error("created workflow is missing an id");
    store.set(workflow.id, workflow);
    const before = store.values();
    const payload = kind === "request"
      ? { type: "request", runtime: "zeroclaw", request: "another feature", repo: "acme/repo" }
      : kind === "approve"
        ? { type: "approve", source: "discord", workflowId: workflow.id, action: "pr.create", user: "alice" }
        : { workflowId: workflow.id, runtime: "zeroclaw", role: "pr-creator", stage: "pr-create", action: "pr.create" };
    const delayed = delayedRequest(kind === "dispatch" ? "dispatch" : "control-event", payload);
    const shutdown = new AbortController();
    const opts = { store, controlEventSecret: CONTROL_SECRET, shutdownSignal: shutdown.signal };
    const response = kind === "dispatch"
      ? handleControlDispatchRequest(delayed.request, {
          ...opts,
          prefix: "jeo-claw",
          sourceFactory: () => ({ access: async () => "unused" }),
        })
      : handleControlEventRequest(delayed.request, opts);
    await delayed.started;
    shutdown.abort();
    delayed.release();
    expect((await response).status).toBe(503);
    expect(store.values()).toEqual(before);
  }
});

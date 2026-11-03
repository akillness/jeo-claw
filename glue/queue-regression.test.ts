import { test, expect } from "bun:test";
import { SQLiteWorkflowStore } from "./store";
import { createWorkflow } from "./state-machine";
import { pendingQueue, pruneWorkflowStore } from "./server";

test("size pruning preserves active workflows and their queued work, even above capacity", () => {
  const localStore = new SQLiteWorkflowStore(":memory:");
  const queued = createWorkflow("prune-queued", "zeroclaw", "queued work");
  queued.status = "queued";
  queued.history = [{ stage: queued.stage, at: "2020-01-01T00:00:00.000Z", status: "running" }];
  const running = createWorkflow("prune-running", "zeroclaw", "running work");
  running.history = [{ stage: running.stage, at: "2020-01-02T00:00:00.000Z", status: "running" }];
  const terminal = createWorkflow("prune-terminal", "zeroclaw", "finished work");
  terminal.status = "merged";
  terminal.history = [{ stage: terminal.stage, at: "2020-01-03T00:00:00.000Z", status: "merged" }];
  terminal.mergedAt = "2020-01-03T00:00:00.000Z";
  if (!queued.id || !running.id || !terminal.id) throw new Error("created workflow is missing an id");
  localStore.set(queued.id, queued);
  localStore.set(running.id, running);
  localStore.set(terminal.id, terminal);
  pendingQueue.add(queued.id);
  try {
    pruneWorkflowStore(localStore, {
      maxWorkflows: 1,
      terminalRetentionMs: 100 * 365 * 24 * 60 * 60 * 1000,
      now: () => Date.parse("2020-01-04T00:00:00.000Z"),
    });
    expect(localStore.get(terminal.id)).toBeUndefined();
    expect(localStore.get(queued.id)?.status).toBe("queued");
    expect(localStore.get(running.id)?.status).toBe("running");
    expect(pendingQueue.has(queued.id)).toBe(true);
  } finally {
    pendingQueue.delete(queued.id);
  }
});

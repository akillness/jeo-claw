import { test, expect } from "bun:test";
import { dispatchStageWork } from "./runtime-dispatch.ts";
import { createWorkflow } from "./state-machine.ts";

test("dispatchStageWork reports contextual error for non-JSON runtime failures", async () => {
  const workflow = createWorkflow("wf-dispatch-fail", "zeroclaw", "review failure path");
  workflow.stage = "review";

  const fetchImpl = (async () => new Response("upstream proxy exploded", { status: 502 })) as unknown as typeof fetch;

  await expect(
    dispatchStageWork(workflow, {
      runtimeDispatchSecret: "runtime-dispatch-secret",
      fetchImpl,
    }),
  ).rejects.toThrow("Runtime dispatch failed for zeroclaw/reviewer/review (502): upstream proxy exploded");
});

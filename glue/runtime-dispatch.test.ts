import { test, expect } from "bun:test";
import { dispatchServiceName, dispatchStageWork } from "./runtime-dispatch.ts";
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

test("dispatchStageWork rejects invalid native runtime responses", async () => {
  const workflow = createWorkflow("wf-invalid-result", "zeroclaw", "review changes");
  workflow.stage = "review";

  const invalidResponses = [
    "not json",
    "null",
    "{}",
    JSON.stringify({ ok: false, artifact: "/workspace/a", output: "done", nativeCommand: "zeroclaw", model: "gpt-6.1-terra", runtime: "zeroclaw", role: "reviewer", stage: "review" }),
    JSON.stringify({ ok: true, artifact: "", output: "done", nativeCommand: "zeroclaw", model: "gpt-6.1-terra", runtime: "zeroclaw", role: "reviewer", stage: "review" }),
    JSON.stringify({ ok: true, artifact: "/workspace/a", output: "", nativeCommand: "zeroclaw", model: "gpt-6.1-terra", runtime: "zeroclaw", role: "reviewer", stage: "review" }),
    JSON.stringify({ ok: true, artifact: "/workspace/a", output: "done", nativeCommand: "zeroclaw", model: "gpt-6.1-terra", runtime: "nullclaw", role: "reviewer", stage: "review" }),
    JSON.stringify({ ok: true, artifact: "/workspace/a", output: "done", nativeCommand: "zeroclaw", model: "gpt-6.1-terra", runtime: "zeroclaw", role: "merger", stage: "review" }),
    JSON.stringify({ ok: true, artifact: "/workspace/a", output: "done", nativeCommand: "zeroclaw", model: "gpt-6.1-terra", runtime: "zeroclaw", role: "reviewer", stage: "research-code" }),
  ];

  for (const body of invalidResponses) {
    const fetchImpl = async () => new Response(body, { status: 200 });
    await expect(dispatchStageWork(workflow, { runtimeDispatchSecret: "test-secret", fetchImpl })).rejects.toThrow();
  }
});

test("dispatchStageWork accepts matching native evidence without trusting policy fields", async () => {
  const workflow = createWorkflow("wf-valid-result", "nullclaw", "review changes");
  workflow.stage = "review";
  const fetchImpl = async () => Response.json({
    ok: true, artifact: "/workspace/.jeo-runtime-work/wf-valid-result-review.md",
    output: "native review evidence", nativeCommand: "nullclaw", model: "gpt-6.1-terra",
    runtime: "nullclaw", role: "reviewer", stage: "review",
    ciPassed: true, reviewPassed: true,
  });
  expect(await dispatchStageWork(workflow, { runtimeDispatchSecret: "test-secret", fetchImpl })).toMatchObject({
    ok: true, runtime: "nullclaw", role: "reviewer", stage: "review", output: "native review evidence",
  });
});

test("dispatchServiceName addresses the isolated Compose runtime service", () => {
  expect(dispatchServiceName("zeroclaw", "researcher-coder")).toBe("zeroclaw-researcher-coder");
  expect(dispatchServiceName("nullclaw", "pr-review-scheduler")).toBe("nullclaw-pr-review-scheduler");
});

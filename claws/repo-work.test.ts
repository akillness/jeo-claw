import { test, expect } from "bun:test";
import { evaluateAgentRun, AGENT_FAILURE_MARKERS, reviewArtifacts } from "./repo-work.ts";

// 1. FALSE-SUCCESS GUARD: agent-run health evaluation
test("healthy run requires exit code 0 and no failure marker", () => {
  const r = evaluateAgentRun(0, "Applied 3 edits to src/app.ts. Done.");
  expect(r.healthy).toBe(true);
  expect(r.marker).toBeNull();
});

test("exit code 0 but 404 in output is NOT healthy (false-success bug)", () => {
  const r = evaluateAgentRun(0, "Provider returned HTTP 404 not found for model");
  expect(r.healthy).toBe(false);
  expect(r.marker).not.toBeNull();
});

test("exit code 0 but 429 rate-limit in output is NOT healthy", () => {
  const r = evaluateAgentRun(0, "Rate limited (429): retry after 60s");
  expect(r.healthy).toBe(false);
  expect(r.marker).toBe("Rate limited");
});

test("provider/model resolution rejection is NOT healthy", () => {
  const r = evaluateAgentRun(
    0,
    "selected model gemini-3.1-pro resolves to gemini, not requested provider antigravity"
  );
  expect(r.healthy).toBe(false);
  expect(r.marker).toBe("resolves to");
});

test("auth failure (401) is NOT healthy even on exit 0", () => {
  const r = evaluateAgentRun(0, "401 Unauthorized: invalid token");
  expect(r.healthy).toBe(false);
  expect(r.marker).not.toBeNull();
});

test("non-zero exit code is never healthy even without markers", () => {
  const r = evaluateAgentRun(1, "agent crashed unexpectedly");
  expect(r.healthy).toBe(false);
  expect(r.marker).toBeNull();
});

test("failure markers cover the documented 429 and 404 cases", () => {
  expect(AGENT_FAILURE_MARKERS).toContain("429");
  expect(AGENT_FAILURE_MARKERS).toContain("404");
});

// 2. ARTIFACT REVIEW still rejects empty result sets
test("reviewArtifacts fails on empty artifact list", () => {
  const r = reviewArtifacts([]);
  expect(r.reviewPassed).toBe(false);
});

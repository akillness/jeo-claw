import { test, expect } from "bun:test";
import {
  AGENT_MODEL_POOL,
  classifyAgentRun,
  reviewArtifacts,
} from "./repo-work.ts";

// 1. MODEL POOL FAIRNESS / VALIDITY
// The Discord code-work failures traced to a misconfigured model id
// (`antigravity:gemini-3.1-pro`) that mis-routed to the public Gemini provider.
// These invariants pin the pool so the regression cannot return.

test("model pool is non-empty and ordered with a primary Claude entry first", () => {
  expect(AGENT_MODEL_POOL.length).toBeGreaterThanOrEqual(2);
  expect(AGENT_MODEL_POOL[0]).toEqual({ provider: "antigravity", model: "claude-sonnet-4-6" });
});

test("antigravity Gemini fallbacks carry the antigravity/ prefix so they do not mis-route", () => {
  const gemini = AGENT_MODEL_POOL.filter(
    (s) => s.provider === "antigravity" && s.model.includes("gemini"),
  );
  expect(gemini.length).toBeGreaterThanOrEqual(1);
  for (const spec of gemini) {
    // Bare `gemini-*` ids resolve to the public "gemini" provider by heuristic;
    // only the `antigravity/`-prefixed form routes back to Antigravity.
    expect(spec.model.startsWith("antigravity/")).toBe(true);
  }
});

test("no pool entry uses the broken bare gemini-3.1-pro spec", () => {
  for (const spec of AGENT_MODEL_POOL) {
    expect(spec.model).not.toBe("gemini-3.1-pro");
  }
});

test("a non-antigravity credential fallback exists for the daily-429 window", () => {
  const hasFallbackProvider = AGENT_MODEL_POOL.some((s) => s.provider !== "antigravity");
  expect(hasFallbackProvider).toBe(true);
});

// 2. AGENT RUN CLASSIFICATION
// The agent prints config errors but still exits 0, so exit code alone lies.

test("classifyAgentRun: clean exit 0 with no error signature is success", () => {
  expect(classifyAgentRun(0, "Done. Wrote 3 files.")).toEqual({ ok: true });
});

test("classifyAgentRun: rate-limit output is a transient failure even on exit 0", () => {
  const out = "Rate limited by Antigravity (HTTP 429). retry after ~36h";
  const res = classifyAgentRun(0, out);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.transient).toBe(true);
    expect(res.reason).toContain("429");
  }
});

test("classifyAgentRun: bare 429 token also classifies as rate-limited", () => {
  const res = classifyAgentRun(1, "request failed with status 429");
  expect(res).toEqual({ ok: false, transient: true, reason: "rate-limited (HTTP 429)" });
});

test("classifyAgentRun: provider/model mismatch is a permanent (non-transient) failure", () => {
  const out = "error: selected model 'gemini-3.1-pro' resolves to gemini, not requested provider antigravity.";
  const res = classifyAgentRun(0, out);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.transient).toBe(false);
    expect(res.reason).toContain("mismatch");
  }
});

test("classifyAgentRun: missing OAuth credentials is a permanent failure", () => {
  const out = "Antigravity provider requires Google/Gemini CLI OAuth credentials. Run `jeo auth login gemini`.";
  const res = classifyAgentRun(0, out);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.transient).toBe(false);
});

test("classifyAgentRun: non-zero exit with no known signature is a transient crash", () => {
  const res = classifyAgentRun(137, "killed");
  expect(res).toEqual({ ok: false, transient: true, reason: "agent exited with code 137" });
});

test("classifyAgentRun: rate-limit signature wins over a non-zero exit code", () => {
  const res = classifyAgentRun(1, "Rate limited by Antigravity (HTTP 429).");
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.transient).toBe(true);
});

// 3. REVIEW GUARD REGRESSION (unchanged behavior, kept green)

test("reviewArtifacts: empty artifact set fails closed", () => {
  expect(reviewArtifacts([]).reviewPassed).toBe(false);
});

test("reviewArtifacts: valid small artifact passes", () => {
  const res = reviewArtifacts([{ path: "src/app.ts", content: "export const x = 1;\n" }]);
  expect(res.reviewPassed).toBe(true);
});

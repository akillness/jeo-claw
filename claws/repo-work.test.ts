import { test, expect } from "bun:test";
import {
  FATAL_OUTPUT_MARKERS,
  hasFatalOutputMarker,
  isAgentAttemptSuccessful,
  buildModelPool,
  reviewArtifacts,
} from "./repo-work.ts";

// 1. FATAL OUTPUT MARKER DETECTION
// The Discord code-work failure was caused by the agent CLI exiting 0 while printing
// `error: selected model 'gemini-3.1-pro' resolves to gemini, not requested provider
// antigravity.` and a soft 429 notice. These must be recognized as no-op failures.

test("hasFatalOutputMarker detects provider/model mismatch output (the real failure)", () => {
  const out = "error: selected model 'gemini-3.1-pro' resolves to gemini, not requested provider antigravity.";
  expect(hasFatalOutputMarker(out)).toBe(true);
});

test("hasFatalOutputMarker detects antigravity rate-limit notice", () => {
  const out = "Error: Rate limited by Antigravity (HTTP 429). Server requested retry after ~36h 23m.";
  expect(hasFatalOutputMarker(out)).toBe(true);
});

test("hasFatalOutputMarker detects credential/auth failures", () => {
  expect(hasFatalOutputMarker("No credentials found for provider")).toBe(true);
  expect(hasFatalOutputMarker("Invalid API key supplied")).toBe(true);
  expect(hasFatalOutputMarker("authentication failed for anthropic")).toBe(true);
});

test("hasFatalOutputMarker returns false for clean agent output", () => {
  const out = "Wrote src/app.ts\nApplied 3 edits.\nDone.";
  expect(hasFatalOutputMarker(out)).toBe(false);
});

test("FATAL_OUTPUT_MARKERS covers both mismatch phrasings", () => {
  expect(FATAL_OUTPUT_MARKERS).toContain("resolves to");
  expect(FATAL_OUTPUT_MARKERS).toContain("not requested provider");
  expect(FATAL_OUTPUT_MARKERS).toContain("429");
});

// 2. ATTEMPT SUCCESS CLASSIFICATION
// Root cause: exit-code 0 alone was treated as success, so a mismatch no-op short-
// circuited the loop before the working anthropic fallback ever ran. Success now
// requires exit 0 AND a dirty tree AND no fatal markers.

test("isAgentAttemptSuccessful rejects exit-0 provider mismatch with clean tree", () => {
  const out = "error: selected model 'gemini-3.1-pro' resolves to gemini, not requested provider antigravity.";
  expect(isAgentAttemptSuccessful(0, out, false)).toBe(false);
});

test("isAgentAttemptSuccessful rejects exit-0 success text when tree is not dirty", () => {
  // Agent claims success but produced zero file changes — not a real success.
  expect(isAgentAttemptSuccessful(0, "All done, no changes needed.", false)).toBe(false);
});

test("isAgentAttemptSuccessful rejects rate-limited output even if tree somehow dirty", () => {
  expect(isAgentAttemptSuccessful(0, "Rate limited by Antigravity (HTTP 429)", true)).toBe(false);
});

test("isAgentAttemptSuccessful rejects non-zero exit code", () => {
  expect(isAgentAttemptSuccessful(1, "Wrote file", true)).toBe(false);
});

test("isAgentAttemptSuccessful accepts clean exit + dirty tree + no fatal markers", () => {
  expect(isAgentAttemptSuccessful(0, "Edited src/app.ts successfully", true)).toBe(true);
});

// 3. MODEL POOL CONSTRUCTION
// The Antigravity gemini variant MUST be provider-qualified; a bare `gemini-3.1-pro`
// routes to the public gemini provider and triggers the mismatch no-op.

test("buildModelPool puts operator LLM_PROVIDER/LLM_MODEL first", () => {
  const pool = buildModelPool({ provider: "antigravity", model: "antigravity/gemini-3.1-pro-low" });
  expect(pool[0]).toBe("antigravity:antigravity/gemini-3.1-pro-low");
});

test("buildModelPool always includes a non-antigravity fallback", () => {
  const pool = buildModelPool({ provider: "antigravity", model: "antigravity/gemini-3.1-pro-low" });
  expect(pool).toContain("anthropic:claude-3-5-sonnet-20241022");
  // Fallback must survive an antigravity-wide 429 by routing to a different provider.
  expect(pool.some((m) => m.startsWith("anthropic:"))).toBe(true);
});

test("buildModelPool never emits the broken bare antigravity:gemini-3.1-pro pair", () => {
  const pool = buildModelPool({ provider: "antigravity", model: "antigravity/gemini-3.1-pro-low" });
  expect(pool).not.toContain("antigravity:gemini-3.1-pro");
});

test("buildModelPool falls back to defaults when env is empty", () => {
  const pool = buildModelPool({});
  expect(pool.length).toBeGreaterThanOrEqual(2);
  expect(pool[0]).toBe("anthropic:claude-3-5-sonnet-20241022");
});

test("buildModelPool deduplicates when env matches a default", () => {
  const pool = buildModelPool({ provider: "anthropic", model: "claude-3-5-sonnet-20241022" });
  const occurrences = pool.filter((m) => m === "anthropic:claude-3-5-sonnet-20241022").length;
  expect(occurrences).toBe(1);
});

test("buildModelPool ignores partial env (provider without model)", () => {
  const pool = buildModelPool({ provider: "antigravity" });
  expect(pool[0]).toBe("anthropic:claude-3-5-sonnet-20241022");
});

// 4. REGRESSION GUARD: reviewArtifacts still rejects empty artifact sets
test("reviewArtifacts fails closed on empty artifacts", () => {
  const res = reviewArtifacts([]);
  expect(res.reviewPassed).toBe(false);
});

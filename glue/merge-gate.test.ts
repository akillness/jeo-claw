import { test, expect } from "bun:test";
import { evaluateMergeGate } from "./merge-gate";

test("merge gate allows when all true", () => {
  const result = evaluateMergeGate({
    ciPassed: true,
    reviewPassed: true,
    discordApproved: true,
  });
  expect(result.allowed).toBe(true);
  expect(result.reasons).toEqual([]);
});

test("merge gate blocks when each single condition is false", () => {
  // CI false
  const r1 = evaluateMergeGate({
    ciPassed: false,
    reviewPassed: true,
    discordApproved: true,
  });
  expect(r1.allowed).toBe(false);
  expect(r1.reasons).toContain("CI not passed");

  // review false
  const r2 = evaluateMergeGate({
    ciPassed: true,
    reviewPassed: false,
    discordApproved: true,
  });
  expect(r2.allowed).toBe(false);
  expect(r2.reasons).toContain("review not passed");

  // discordApproved false
  const r3 = evaluateMergeGate({
    ciPassed: true,
    reviewPassed: true,
    discordApproved: false,
  });
  expect(r3.allowed).toBe(false);
  expect(r3.reasons).toContain("Discord approval missing");

  // all false
  const r4 = evaluateMergeGate({
    ciPassed: false,
    reviewPassed: false,
    discordApproved: false,
  });
  expect(r4.allowed).toBe(false);
  expect(r4.reasons).toEqual([
    "CI not passed",
    "review not passed",
    "Discord approval missing",
  ]);
});

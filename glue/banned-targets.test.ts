import { test, expect } from "bun:test";
import { isBannedTarget, normalizeRepo, BANNED_TARGET_REPOS } from "./banned-targets.ts";

// 1. CANONICAL BAN
test("the canonical jeo-code slug is banned", () => {
  expect(isBannedTarget("akillness/jeo-code")).toBe(true);
});

test("ban list contains exactly the jeo-code target", () => {
  expect([...BANNED_TARGET_REPOS]).toEqual(["akillness/jeo-code"]);
});

// 2. NORMALIZATION VARIANTS all resolve to the banned target
test("URL / SSH / .git / case / trailing-slash variants are all blocked", () => {
  const variants = [
    "AKILLNESS/JEO-CODE",
    " akillness/jeo-code ",
    "akillness/jeo-code/",
    "akillness/jeo-code.git",
    "https://github.com/akillness/jeo-code",
    "https://github.com/akillness/jeo-code.git",
    "github.com/akillness/jeo-code",
    "git@github.com:akillness/jeo-code.git",
  ];
  for (const v of variants) {
    expect(isBannedTarget(v)).toBe(true);
  }
});

test("normalizeRepo strips host/protocol/.git/trailing slash to owner/name", () => {
  expect(normalizeRepo("https://github.com/Akillness/Jeo-Code.git/")).toBe("akillness/jeo-code");
  expect(normalizeRepo("git@github.com:akillness/jeo-code.git")).toBe("akillness/jeo-code");
});

// 3. ALLOWED TARGETS are not blocked
test("the orchestrator's own repo and other targets are NOT banned", () => {
  expect(isBannedTarget("akillness/jeo-claw")).toBe(false);
  expect(isBannedTarget("akillness/jeo-code-extras")).toBe(false);
  expect(isBannedTarget("someone/jeo-code")).toBe(false);
  expect(isBannedTarget("https://github.com/akillness/jeo-claw.git")).toBe(false);
});

// 4. EMPTY / MISSING input is not banned (default target falls back elsewhere)
test("undefined, null and empty repo are not banned", () => {
  expect(isBannedTarget(undefined)).toBe(false);
  expect(isBannedTarget(null)).toBe(false);
  expect(isBannedTarget("")).toBe(false);
  expect(isBannedTarget("   ")).toBe(false);
});

import { test, expect } from "bun:test";
import { validateConfigs, loadZeroclaw, loadNullclaw, rolesOf } from "./validate.ts";

test("both runtime configs pass every validation check", () => {
  const checks = validateConfigs();
  const failures = checks.filter((c) => !c.ok).map((f) => `${f.name} (${f.detail})`);
  expect(failures).toEqual([]);
});

test("A/B fairness: identical model id", () => {
  expect(loadZeroclaw().providers.models["openai-codex"].coding.model).toBe(loadNullclaw().provider.model);
});

test("runtime configs keep only env-referenced provider secrets and no embedded Discord control block", () => {
  const zc = loadZeroclaw();
  const nc = loadNullclaw();
  expect(zc.providers.models["openai-codex"].coding.api_key).toBeUndefined();
  expect(nc.provider.api_key).toBeUndefined();
  expect(zc.channels?.discord).toBeUndefined();
  expect(nc.channels?.discord).toBeUndefined();
});

test("exactly 5 roles in each runtime", () => {
  expect(new Set(rolesOf(loadZeroclaw())).size).toBe(5);
  expect(new Set(rolesOf(loadNullclaw())).size).toBe(5);
});

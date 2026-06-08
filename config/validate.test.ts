import { test, expect } from "bun:test";
import { validateConfigs, loadZeroclaw, loadNullclaw, rolesOf } from "./validate.ts";

test("both runtime configs pass every validation check", () => {
  const checks = validateConfigs();
  const failures = checks.filter((c) => !c.ok).map((f) => `${f.name} (${f.detail})`);
  expect(failures).toEqual([]);
});

test("A/B fairness: identical model id", () => {
  expect(loadZeroclaw().providers.models.openai.coding.model).toBe(loadNullclaw().provider.model);
});

test("no plaintext secrets — api keys/tokens are env refs", () => {
  const zc = loadZeroclaw();
  const nc = loadNullclaw();
  expect(zc.providers.models.openai.coding.api_key).toMatch(/^\$\{[A-Z_]+\}$/);
  expect(nc.provider.api_key).toMatch(/^\$\{[A-Z_]+\}$/);
  expect(zc.channels.discord.ops.token).toMatch(/^\$\{[A-Z_]+\}$/);
});

test("exactly 5 roles in each runtime", () => {
  expect(new Set(rolesOf(loadZeroclaw())).size).toBe(5);
  expect(new Set(rolesOf(loadNullclaw())).size).toBe(5);
});

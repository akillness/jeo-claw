import { test, expect } from "bun:test";
import { parseCommand, validateConfigValue } from "./commands.ts";

test("parseCommand: request command", () => {
  const res1 = parseCommand("request zeroclaw build a secure router", "alice");
  expect(res1).toEqual({
    type: "request",
    runtime: "zeroclaw",
    request: "build a secure router",
  });

  const res2 = parseCommand("/request nullclaw write some tests", "bob");
  expect(res2).toEqual({
    type: "request",
    runtime: "nullclaw",
    request: "write some tests",
  });

  const res3 = parseCommand("request badclaw build a secure router", "alice");
  expect(res3).toEqual({
    type: "unknown",
    raw: "request badclaw build a secure router",
  });

  const res4 = parseCommand("  request    zeroclaw    do   some   work  ", "charlie");
  expect(res4).toEqual({
    type: "request",
    runtime: "zeroclaw",
    request: "do   some   work",
  });
});

test("parseCommand: approve command requires workflow id and action", () => {
  const res1 = parseCommand("approve wf-999 pr.create", "alice");
  expect(res1).toEqual({
    type: "approve",
    workflowId: "wf-999",
    action: "pr.create",
    user: "alice",
  });

  const res2 = parseCommand("/approve wf-1000 pr.merge", "bob");
  expect(res2).toEqual({
    type: "approve",
    workflowId: "wf-1000",
    action: "pr.merge",
    user: "bob",
  });

  const res3 = parseCommand("approve wf-999");
  expect(res3).toEqual({
    type: "unknown",
    raw: "approve wf-999",
  });

  expect(parseCommand("approve wf-999", "alice")).toEqual({ type: "unknown", raw: "approve wf-999" });
  expect(parseCommand("approve wf-999 read.only", "alice")).toEqual({ type: "unknown", raw: "approve wf-999 read.only" });
});

test("parseCommand: reject command requires workflow id and action", () => {
  const res1 = parseCommand("reject wf-999 pr.create", "alice");
  expect(res1).toEqual({
    type: "reject",
    workflowId: "wf-999",
    action: "pr.create",
    user: "alice",
  });

  const res2 = parseCommand("/reject wf-1000 pr.merge", "bob");
  expect(res2).toEqual({
    type: "reject",
    workflowId: "wf-1000",
    action: "pr.merge",
    user: "bob",
  });

  const res3 = parseCommand("reject wf-999");
  expect(res3).toEqual({
    type: "unknown",
    raw: "reject wf-999",
  });

  expect(parseCommand("reject wf-999", "alice")).toEqual({ type: "unknown", raw: "reject wf-999" });
});

test("parseCommand: config set command", () => {
  const keys = ["provider", "model", "autonomy", "scaleout"] as const;
  for (const key of keys) {
    const res = parseCommand(`config set ${key} some-value`, "alice");
    expect(res).toEqual({
      type: "config-set",
      key,
      value: "some-value",
    });
  }

  const resSlash = parseCommand("/config set model gpt-5", "bob");
  expect(resSlash).toEqual({
    type: "config-set",
    key: "model",
    value: "gpt-5",
  });

  const resBad = parseCommand("config set invalid_key value", "alice");
  expect(resBad).toEqual({
    type: "unknown",
    raw: "config set invalid_key value",
  });

  const resMissingSet = parseCommand("config provider openai", "alice");
  expect(resMissingSet).toEqual({
    type: "unknown",
    raw: "config provider openai",
  });
});

test("parseCommand: unknown commands", () => {
  const badInputs = [
    "hello",
    "request",
    "approve",
    "approve wf-1",
    "reject",
    "reject wf-1",
    "config set provider",
    "config set",
    "",
    "   ",
  ];
  for (const input of badInputs) {
    const res = parseCommand(input, "alice");
    expect(res).toEqual({
      type: "unknown",
      raw: input,
    });
  }
});

test("validateConfigValue validations", () => {
  expect(validateConfigValue("autonomy", "supervised")).toEqual({ ok: true });
  expect(validateConfigValue("autonomy", "yolo").ok).toBe(false);
  expect(validateConfigValue("autonomy", "yolo").reason).toContain("Only 'supervised' is allowed");

  expect(validateConfigValue("scaleout", "1")).toEqual({ ok: true });
  expect(validateConfigValue("scaleout", "2")).toEqual({ ok: true });
  expect(validateConfigValue("scaleout", "3")).toEqual({ ok: true });
  expect(validateConfigValue("scaleout", "0").ok).toBe(false);
  expect(validateConfigValue("scaleout", "4").ok).toBe(false);
  expect(validateConfigValue("scaleout", "abc").ok).toBe(false);
  expect(validateConfigValue("scaleout", "1.5").ok).toBe(false);

  expect(validateConfigValue("provider", "openai")).toEqual({ ok: true });
  expect(validateConfigValue("provider", "")).toEqual({ ok: false, reason: "Value for provider cannot be empty." });
  expect(validateConfigValue("model", "gpt-5")).toEqual({ ok: true });
  expect(validateConfigValue("model", "   ")).toEqual({ ok: false, reason: "Value for model cannot be empty." });
});

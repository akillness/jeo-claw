import { test, expect } from "bun:test";
import { evaluateMergeGate } from "../glue/merge-gate";
import { verifySignature } from "../glue/github-webhook";
import { loadSecretsForRole, loadWriteSecretsForRole, MissingSecretError, redact, ROLE_SECRETS, type Role, type SecretSource } from "../secrets/loader";
import { ApprovalRegistry, guardHighRisk } from "../discord/approval";
import { parseCommand } from "../discord/commands";
import { buildHandlers } from "../discord/bot";
import { handleControlEventRequest, handleControlDispatchRequest } from "../glue/server";
import { createWorkflow, applyEvent, advanceStage } from "../glue/state-machine";
import { summarize } from "../compare/metrics";
import type { MetricSample, WorkflowState, ControlEvent } from "../glue/contract";


function pendingPrCreateWorkflow(id: string): WorkflowState {
  let wf = createWorkflow(id, "zeroclaw", "build secure feature");
  wf = advanceStage(wf);
  wf = advanceStage(wf);
  return advanceStage(wf);
}

function pendingMergeWorkflow(id: string): WorkflowState {
  let wf = pendingPrCreateWorkflow(id);
  wf = applyEvent(wf, { type: "approve", action: "pr.create", user: "alice" });
  wf = advanceStage(wf);
  return advanceStage(wf);
}
// ==========================================
// 1. MERGE GATE BYPASS ATTEMPTS
// ==========================================
test("1.1 Merge gate - all 2-of-3 combinations must be blocked", () => {
  // ci+review true, no-approval
  const r1 = evaluateMergeGate({
    ciPassed: true,
    reviewPassed: true,
    discordApproved: false,
  });
  expect(r1.allowed).toBe(false);
  expect(r1.reasons).toContain("Discord approval missing");

  // ci+approval true, no-review
  const r2 = evaluateMergeGate({
    ciPassed: true,
    reviewPassed: false,
    discordApproved: true,
  });
  expect(r2.allowed).toBe(false);
  expect(r2.reasons).toContain("review not passed");

  // review+approval true, no-ci
  const r3 = evaluateMergeGate({
    ciPassed: false,
    reviewPassed: true,
    discordApproved: true,
  });
  expect(r3.allowed).toBe(false);
  expect(r3.reasons).toContain("CI not passed");
});

test("1.2 Merge gate - truthy-but-not-true values should be blocked", () => {
  // In Javascript/TypeScript, truthy values like string "yes", number 1, object {}
  // might bypass simple truthiness checks if not strictly checked against boolean true.
  // The contract says: "only all-3-true allowed".
  const rTruthy = evaluateMergeGate({
    ciPassed: "yes" as any,
    reviewPassed: 1 as any,
    discordApproved: {} as any,
  });
  
  // Adversarial assertion: truthy-but-not-true values MUST be blocked (allowed: false).
  // Note: if the production code uses simple `!input.ciPassed` checks, this assertion
  // might FAIL, which reveals a real defect in the code's strict verification.
  expect(rTruthy.allowed).toBe(false);
});

// ==========================================
// 2. WEBHOOK SIGNATURE FORGERY
// ==========================================
test("2.1 Webhook signature forgery - tampered body with valid old signature", () => {
  const secret = "my-webhook-secret";
  const body = JSON.stringify({ event: "pull_request", prNumber: 42 });
  
  // Generate correct signature for the original body
  const crypto = require("node:crypto");
  const validHmac = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const validHeader = `sha256=${validHmac}`;
  
  // Tamper the body while using the valid signature of the old body
  const tamperedBody = JSON.stringify({ event: "pull_request", prNumber: 999 });
  const verified = verifySignature(tamperedBody, validHeader, secret);
  expect(verified).toBe(false);
});

test("2.2 Webhook signature forgery - wrong secret", () => {
  const secret = "my-webhook-secret";
  const body = JSON.stringify({ event: "pull_request", prNumber: 42 });
  const crypto = require("node:crypto");
  const validHmac = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const validHeader = `sha256=${validHmac}`;
  
  const verified = verifySignature(body, validHeader, "wrong-secret");
  expect(verified).toBe(false);
});

test("2.3 Webhook signature forgery - malformed headers", () => {
  const secret = "my-webhook-secret";
  const body = JSON.stringify({ event: "pull_request", prNumber: 42 });
  
  // No sha256= prefix
  expect(verifySignature(body, "abcdef123456", secret)).toBe(false);
  
  // Empty header
  expect(verifySignature(body, "", secret)).toBe(false);
  
  // Wrong algorithm
  expect(verifySignature(body, "sha1=abcdef123456", secret)).toBe(false);
  
  // Length mismatch (e.g. signature is too short)
  // Ensure the constant-time verification path doesn't throw on length mismatch
  expect(() => verifySignature(body, "sha256=abc", secret)).not.toThrow();
  expect(verifySignature(body, "sha256=abc", secret)).toBe(false);
});

test("2.4 Webhook signature - correctly-signed body must be accepted", () => {
  const secret = "my-webhook-secret";
  const body = JSON.stringify({ event: "pull_request", prNumber: 42 });
  const crypto = require("node:crypto");
  const validHmac = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const validHeader = `sha256=${validHmac}`;
  
  expect(verifySignature(body, validHeader, secret)).toBe(true);
});

// ==========================================
// 3. SECRET LOADER ABUSE
// ==========================================
class SpySource implements SecretSource {
  accessed: string[] = [];
  constructor(private store: Record<string, string>) {}
  async access(secretId: string): Promise<string> {
    this.accessed.push(secretId);
    return this.store[secretId] ?? "";
  }
}

test("3.1 Secret loader - read-only roles must NEVER trigger access to the write token id", async () => {
  const store = {
    "jeo-claw-openai-codex-oauth": '{"tokens":{"access_token":"fake"}}',
    "jeo-claw-github-token-ro": "ghp_ro",
    "jeo-claw-github-token-rw": "ghp_rw",
    "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret-value",
  };
  
  const readOnlyRoles: Role[] = ["reviewer", "researcher-coder", "pr-review-scheduler"];
  for (const role of readOnlyRoles) {
    const spy = new SpySource(store);
    await loadSecretsForRole(role, spy, { prefix: "jeo-claw" });
    
    // The write token id "jeo-claw-github-token-rw" must never be accessed
    expect(spy.accessed).not.toContain("jeo-claw-github-token-rw");
  }
});
test("3.1b Secret loader - write roles use read-only startup env and require mediated write-secret release", async () => {
  const store = {
    "jeo-claw-openai-codex-oauth": '{"tokens":{"access_token":"fake"}}',
    "jeo-claw-github-token-ro": "ghp_ro",
    "jeo-claw-github-token-rw": "ghp_rw",
    "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret-value",
  };

  for (const role of ["pr-creator", "merger"] as Role[]) {
    const startupSpy = new SpySource(store);
    const startupEnv = await loadSecretsForRole(role, startupSpy, { prefix: "jeo-claw" });
    expect(startupEnv.GITHUB_TOKEN).toBe("ghp_ro");
    expect(startupSpy.accessed).not.toContain("jeo-claw-github-token-rw");

    const writeSpy = new SpySource(store);
    const writeEnv = await loadWriteSecretsForRole(role, writeSpy, { prefix: "jeo-claw" });
    expect(writeEnv.GITHUB_TOKEN).toBe("ghp_rw");
    expect(writeSpy.accessed).toEqual(["jeo-claw-github-token-rw"]);
  }
});

test("3.2 Secret loader - missing required secret and empty value throws MissingSecretError", async () => {
  const incompleteStore = {
    "jeo-claw-github-token-ro": "ghp_ro",
    "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret-value",
    // openai-codex-oauth is missing
  };
  
  const spy = new SpySource(incompleteStore);
  expect(loadSecretsForRole("reviewer", spy, { prefix: "jeo-claw" })).rejects.toThrow(MissingSecretError);
  
  const emptyValueStore = {
    "jeo-claw-openai-codex-oauth": "",
    "jeo-claw-github-token-ro": "ghp_ro",
    "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret-value",
  };
  const spyEmpty = new SpySource(emptyValueStore);
  expect(loadSecretsForRole("reviewer", spyEmpty, { prefix: "jeo-claw" })).rejects.toThrow(MissingSecretError);
});

test("3.3 Secret loader - redact() must mask values even when they contain regex-special chars", () => {
  const regexSpecialSecret = "$^*+?()[]{}|\\";
  const logString = `Initializing with API key: ${regexSpecialSecret}`;
  const redacted = redact(logString, [regexSpecialSecret]);
  
  expect(redacted).not.toContain(regexSpecialSecret);
  expect(redacted).toContain("***REDACTED***");
});

test("3.4 Secret loader - confirm no secret value appears in thrown error messages", async () => {
  const secretValue = '{"tokens":{"access_token":"sensitive-openai-key-999"}}';
  const failingSource: SecretSource = {
    async access(id: string): Promise<string> {
      if (id.endsWith("openai-codex-oauth")) {
        return secretValue;
      }
      throw new Error("Database timeout reading next secret");
    }
  };
  
  try {
    await loadSecretsForRole("researcher-coder", failingSource, { prefix: "jeo-claw" });
    expect.unreachable(); // Should have thrown
  } catch (e: any) {
    // Assert the sensitive key value does not leak in the thrown error message
    expect(e.message).not.toContain(secretValue);
  }
});
test("3.5 Control secret loader - control services receive only their own control-plane credentials", async () => {
  const store = {
    "jeo-claw-github-webhook-secret": "whsec_generated_secret_value",
    "jeo-claw-discord-bot-token": "xoxb_control",
    "jeo-claw-control-event-secret": "control-event-secret-value",
    "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret-value",
    "jeo-claw-openai-codex-oauth": '{"tokens":{"access_token":"fake"}}',
    "jeo-claw-github-token-ro": "ghp_ro",
    "jeo-claw-github-token-rw": "ghp_rw",
  };
  const { loadSecretsForControl } = await import("../secrets/loader.ts");

  const glueSpy = new SpySource(store);
  const glue = await loadSecretsForControl("glue-webhook", glueSpy, { prefix: "jeo-claw" });
  expect(glue.GITHUB_WEBHOOK_SECRET).toBe("whsec_generated_secret_value");
  expect(glue.JEO_CONTROL_EVENT_SECRET).toBe("control-event-secret-value");
  expect(glue.OPENAI_CODEX_AUTH).toBeUndefined();
  expect(glue.GITHUB_TOKEN).toBeUndefined();
  expect(glueSpy.accessed).toEqual(["jeo-claw-github-webhook-secret", "jeo-claw-control-event-secret", "jeo-claw-runtime-dispatch-secret"]);

  const discordSpy = new SpySource(store);
  const discord = await loadSecretsForControl("discord-bot", discordSpy, { prefix: "jeo-claw" });
  expect(discord.DISCORD_BOT_TOKEN).toBe("xoxb_control");
  expect(discord.JEO_CONTROL_EVENT_SECRET).toBe("control-event-secret-value");
  expect(discord.GITHUB_TOKEN).toBeUndefined();
  expect(discord.OPENAI_CODEX_AUTH).toBeUndefined();
  expect(discordSpy.accessed).toEqual(["jeo-claw-discord-bot-token", "jeo-claw-control-event-secret"]);
});

// ==========================================
// 4. HIGH-RISK GUARD
// ==========================================
test("4.1 High-risk guard - action-scoped approvals are consumed and cannot cross-authorize", () => {
  const registry = new ApprovalRegistry();
  const workflowId = "wf-123";
  registry.requirePending(workflowId, "pr.create");
  
  // Guard should block high-risk actions initially.
  const rPrCreate = guardHighRisk("pr.create", workflowId, registry);
  expect(rPrCreate.allowed).toBe(false);
  expect(rPrCreate.reason).toContain("requires unconsumed Discord approval");
  
  const rPrMerge = guardHighRisk("pr.merge", workflowId, registry);
  expect(rPrMerge.allowed).toBe(false);
  
  // Approving pr.create only allows pr.create once.
  registry.approve(workflowId, "pr.create", "admin-user");
  expect(guardHighRisk("pr.create", workflowId, registry).allowed).toBe(true);
  expect(guardHighRisk("pr.create", workflowId, registry).allowed).toBe(false);
  expect(guardHighRisk("pr.merge", workflowId, registry).allowed).toBe(false);
  
  // Reject re-blocks even if a prior approval existed.
  registry.approve(workflowId, "pr.merge", "admin-user");
  registry.reject(workflowId, "pr.merge", "admin-user");
  expect(guardHighRisk("pr.merge", workflowId, registry).allowed).toBe(false);
});

test("4.4 Control event path - unauthenticated approval mutation is rejected", async () => {
  const store = new Map<string, WorkflowState>();
  const res = await handleControlEventRequest(
    new Request("http://localhost/control-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "approve", workflowId: "wf-1", action: "pr.merge", user: "mallory" }),
    }),
    { store, controlEventSecret: "control-secret" },
  );
  expect(res.status).toBe(401);
  expect(store.size).toBe(0);
});

test("4.5 Discord control plane - approval command outside approval policy is rejected", async () => {
  const registry = new ApprovalRegistry();
  const received: ControlEvent[] = [];
  let reply = "";
  const handlers = buildHandlers({
    registry,
    policy: {
      guildId: "guild-1",
      requestChannelId: "request-chan",
      approvalChannelId: "approval-chan",
      approverRoleId: "approver-role",
    },
    onEvent: async (event) => {
      received.push(event);
    },
  });

  await handlers.handleMessage({
    content: "approve wf-1 pr.merge",
    author: { bot: false, tag: "mallory#0001" },
    guildId: "guild-1",
    channelId: "request-chan",
    member: { roles: { cache: new Set() }, permissions: { has: () => false } },
    reply: async (msg: string) => { reply = msg; },
  });

  expect(received).toEqual([]);
  expect(reply).toContain("wrong channel");
});
test("4.6 Dispatch broker - unauthenticated write-secret release is rejected", async () => {
  const store = new Map<string, WorkflowState>();
  const wf = createWorkflow("wf-broker", "zeroclaw", "build secure feature");
  store.set(wf.id, wf);

  const res = await handleControlDispatchRequest(
    new Request("http://localhost/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId: wf.id, runtime: "zeroclaw", role: "pr-creator", stage: "pr-create", action: "pr.create" }),
    }),
    {
      store,
      controlEventSecret: "control-secret",
      prefix: "jeo-claw",
      sourceFactory: () => new SpySource({ "jeo-claw-github-token-rw": "ghp_rw" }),
    },
  );

  expect(res.status).toBe(401);
});

test("4.7 Dispatch broker - approved write-secret release is scoped and consumes approval", async () => {
  const store = new Map<string, WorkflowState>();
  let wf = pendingPrCreateWorkflow("wf-broker");
  wf = applyEvent(wf, { type: "approve", action: "pr.create", user: "alice" });
  store.set(wf.id, wf);

  const res = await handleControlDispatchRequest(
    new Request("http://localhost/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-control-event-secret": "control-secret",
      },
      body: JSON.stringify({ workflowId: wf.id, runtime: "zeroclaw", role: "pr-creator", stage: "pr-create", action: "pr.create" }),
    }),
    {
      store,
      controlEventSecret: "control-secret",
      prefix: "jeo-claw",
      sourceFactory: () => new SpySource({ "jeo-claw-github-token-rw": "ghp_rw" }),
    },
  );

  expect(res.status).toBe(200);
  const data = (await res.json()) as { credentials?: Record<string, string>; credentialReleased?: boolean };
  expect(data.credentials).toBeUndefined();
  expect(data.credentialReleased).toBe(false);
  expect(store.get(wf.id)?.actionApprovals?.["pr.create"]?.status).toBe("consumed");
});

test("4.7b Dispatch broker - approved merge release is scoped and consumed only when merge is ready", async () => {
  const store = new Map<string, WorkflowState>();
  let wf = pendingMergeWorkflow("wf-broker-merge");
  wf.prNumber = 101;
  wf = applyEvent(wf, { ciPassed: true, reviewPassed: true });
  wf = advanceStage(wf);
  wf = applyEvent(wf, { type: "approve", action: "pr.merge", user: "alice" });
  store.set(wf.id, wf);

  const res = await handleControlDispatchRequest(
    new Request("http://localhost/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-control-event-secret": "control-secret",
      },
      body: JSON.stringify({ workflowId: wf.id, runtime: "zeroclaw", role: "merger", stage: "merge", action: "pr.merge" }),
    }),
    {
      store,
      controlEventSecret: "control-secret",
      prefix: "jeo-claw",
      sourceFactory: () => new SpySource({ "jeo-claw-github-token-rw": "ghp_rw" }),
    },
  );

  expect(res.status).toBe(200);
  expect(store.get(wf.id)?.actionApprovals?.["pr.merge"]?.status).toBe("consumed");
});

test("4.2 High-risk guard - unknown or non-high-risk action always allowed", () => {
  const registry = new ApprovalRegistry();
  const workflowId = "wf-123";
  
  expect(guardHighRisk("git.fetch", workflowId, registry).allowed).toBe(true);
  expect(guardHighRisk("pr.comment", workflowId, registry).allowed).toBe(true);
  expect(guardHighRisk("something.else", workflowId, registry).allowed).toBe(true);
});

test("4.3 High-risk guard - approval for workflowId/action A must not authorize workflowId/action B", () => {
  const registry = new ApprovalRegistry();
  registry.requirePending("wf-A", "pr.create");
  registry.requirePending("wf-B", "pr.create");
  registry.requirePending("wf-A", "pr.merge");
  
  registry.approve("wf-A", "pr.create", "user");
  
  expect(guardHighRisk("pr.create", "wf-A", registry).allowed).toBe(true);
  expect(guardHighRisk("pr.create", "wf-B", registry).allowed).toBe(false);
  expect(guardHighRisk("pr.merge", "wf-A", registry).allowed).toBe(false);
});

// ==========================================
// 5. COMMAND PARSER FUZZ
// ==========================================
test("5.1 Command parser fuzz - unrecognized inputs must return unknown, no crash", () => {
  const badInputs = [
    "",
    "   ",
    "request",
    "/request",
    "approve",
    "reject",
    "config set",
    "request invalid-runtime do task",
    "/request unknown task",
    "config set invalid-key some-value",
    "config set model",
    "approve  ",
    "reject  ",
    "nonsense words",
  ];
  
  for (const input of badInputs) {
    const result = parseCommand(input, "tester");
    expect(result.type).toBe("unknown");
    expect((result as any).raw).toBe(input);
  }
});

test("5.2 Command parser fuzz - extra whitespace handled correctly", () => {
  // Well-formed but extra whitespace command
  const r1 = parseCommand("request   zeroclaw   do task", "tester");
  expect(r1.type).toBe("request");
  if (r1.type === "request") {
    expect(r1.runtime).toBe("zeroclaw");
    expect(r1.request).toBe("do task");
  }
  
  const r2 = parseCommand("approve    wf-123    pr.create", "tester");
  expect(r2.type).toBe("approve");
  if (r2.type === "approve") {
    expect(r2.workflowId).toBe("wf-123");
    expect(r2.action).toBe("pr.create");
    expect(r2.user).toBe("tester");
  }
  
  const r3 = parseCommand("config   set    model    gpt-5", "tester");
  expect(r3.type).toBe("config-set");
  if (r3.type === "config-set") {
    expect(r3.key).toBe("model");
    expect(r3.value).toBe("gpt-5");
  }
});

// ==========================================
// 6. METRIC MATH ADVERSARIAL
// ==========================================
test("6.1 Metric math - empty samples returns empty array", () => {
  expect(summarize([])).toEqual([]);
});

test("6.2 Metric math - single runtime only", () => {
  const samples: MetricSample[] = [
    {
      runtime: "zeroclaw",
      run: 1,
      latencyMs: 100,
      ramMb: 200,
      cpuPct: 10,
      ciPassed: true,
      tokenCost: 0.1,
      failed: false,
    },
  ];
  
  const summaries = summarize(samples);
  // Expect two summaries because the system has fixed runtimes list (zeroclaw, nullclaw)
  expect(summaries.length).toBe(2);
  
  const zeroclaw = summaries.find(s => s.runtime === "zeroclaw")!;
  const nullclaw = summaries.find(s => s.runtime === "nullclaw")!;
  
  expect(zeroclaw.runs).toBe(1);
  expect(nullclaw.runs).toBe(0);
});

test("6.3 Metric math - all-failed batch", () => {
  const samples: MetricSample[] = [
    {
      runtime: "zeroclaw",
      run: 1,
      latencyMs: 100,
      ramMb: 200,
      cpuPct: 10,
      ciPassed: false,
      tokenCost: 0.1,
      failed: true,
    },
    {
      runtime: "zeroclaw",
      run: 2,
      latencyMs: 150,
      ramMb: 250,
      cpuPct: 15,
      ciPassed: false,
      tokenCost: 0.2,
      failed: true,
    },
  ];
  
  const summaries = summarize(samples);
  const zeroclaw = summaries.find(s => s.runtime === "zeroclaw")!;
  
  expect(zeroclaw.failureRate).toBe(1);
  expect(zeroclaw.ciPassRate).toBe(0);
});

test("6.4 Metric math - mixed exact averages", () => {
  const samples: MetricSample[] = [
    {
      runtime: "zeroclaw",
      run: 1,
      latencyMs: 100,
      ramMb: 200,
      cpuPct: 10,
      ciPassed: true,
      tokenCost: 0.1,
      failed: false,
    },
    {
      runtime: "zeroclaw",
      run: 2,
      latencyMs: 300,
      ramMb: 400,
      cpuPct: 30,
      ciPassed: false,
      tokenCost: 0.3,
      failed: true,
    },
  ];
  
  const summaries = summarize(samples);
  const zeroclaw = summaries.find(s => s.runtime === "zeroclaw")!;
  
  expect(zeroclaw.runs).toBe(2);
  expect(zeroclaw.latencyMs).toBe(200); // (100 + 300) / 2
  expect(zeroclaw.ramMb).toBe(300); // (200 + 400) / 2
  expect(zeroclaw.cpuPct).toBe(20); // (10 + 30) / 2
  expect(zeroclaw.tokenCost).toBeCloseTo(0.2); // (0.1 + 0.3) / 2
  expect(zeroclaw.ciPassRate).toBe(0.5);
  expect(zeroclaw.failureRate).toBe(0.5);
});

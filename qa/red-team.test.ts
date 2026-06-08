import { test, expect } from "bun:test";
import { evaluateMergeGate } from "../glue/merge-gate";
import { verifySignature } from "../glue/github-webhook";
import { loadSecretsForRole, MissingSecretError, redact, ROLE_SECRETS, type Role, type SecretSource } from "../secrets/loader";
import { ApprovalRegistry, guardHighRisk } from "../discord/approval";
import { parseCommand } from "../discord/commands";
import { summarize } from "../compare/metrics";
import type { MetricSample } from "../glue/contract";

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
    "jeo-claw-openai-api-key": "sk-fake",
    "jeo-claw-github-token-ro": "ghp_ro",
    "jeo-claw-github-token-rw": "ghp_rw",
  };
  
  const readOnlyRoles: Role[] = ["reviewer", "researcher-coder", "pr-review-scheduler"];
  for (const role of readOnlyRoles) {
    const spy = new SpySource(store);
    await loadSecretsForRole(role, spy, { prefix: "jeo-claw" });
    
    // The write token id "jeo-claw-github-token-rw" must never be accessed
    expect(spy.accessed).not.toContain("jeo-claw-github-token-rw");
  }
});

test("3.2 Secret loader - missing required secret and empty value throws MissingSecretError", async () => {
  const incompleteStore = {
    "jeo-claw-github-token-ro": "ghp_ro",
    // openai-api-key is missing
  };
  
  const spy = new SpySource(incompleteStore);
  expect(loadSecretsForRole("reviewer", spy, { prefix: "jeo-claw" })).rejects.toThrow(MissingSecretError);
  
  const emptyValueStore = {
    "jeo-claw-openai-api-key": "",
    "jeo-claw-github-token-ro": "ghp_ro",
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
  const secretValue = "sensitive-openai-key-999";
  const failingSource: SecretSource = {
    async access(id: string): Promise<string> {
      if (id.endsWith("openai-api-key")) {
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
    "jeo-claw-github-webhook-secret": "whsec_control",
    "jeo-claw-discord-bot-token": "xoxb_control",
    "jeo-claw-openai-api-key": "sk-fake",
    "jeo-claw-github-token-ro": "ghp_ro",
    "jeo-claw-github-token-rw": "ghp_rw",
  };
  const { loadSecretsForControl } = await import("../secrets/loader.ts");

  const glueSpy = new SpySource(store);
  const glue = await loadSecretsForControl("glue-webhook", glueSpy, { prefix: "jeo-claw" });
  expect(glue.GITHUB_WEBHOOK_SECRET).toBe("whsec_control");
  expect(glue.OPENAI_API_KEY).toBeUndefined();
  expect(glue.GITHUB_TOKEN).toBeUndefined();
  expect(glueSpy.accessed).toEqual(["jeo-claw-github-webhook-secret"]);

  const discordSpy = new SpySource(store);
  const discord = await loadSecretsForControl("discord-bot", discordSpy, { prefix: "jeo-claw" });
  expect(discord.DISCORD_BOT_TOKEN).toBe("xoxb_control");
  expect(discord.GITHUB_TOKEN).toBeUndefined();
  expect(discord.OPENAI_API_KEY).toBeUndefined();
  expect(discordSpy.accessed).toEqual(["jeo-claw-discord-bot-token"]);
});

// ==========================================
// 4. HIGH-RISK GUARD
// ==========================================
test("4.1 High-risk guard - action-scoped approvals are consumed and cannot cross-authorize", () => {
  const registry = new ApprovalRegistry();
  const workflowId = "wf-123";
  registry.requirePending(workflowId, "git.push");
  
  // Guard should block high-risk actions initially.
  const rGitPush = guardHighRisk("git.push", workflowId, registry);
  expect(rGitPush.allowed).toBe(false);
  expect(rGitPush.reason).toContain("requires unconsumed Discord approval");
  
  const rGitMerge = guardHighRisk("git.merge", workflowId, registry);
  expect(rGitMerge.allowed).toBe(false);
  
  const rPrMerge = guardHighRisk("pr.merge", workflowId, registry);
  expect(rPrMerge.allowed).toBe(false);
  
  // Approving git.push only allows git.push once.
  registry.approve(workflowId, "git.push", "admin-user");
  expect(guardHighRisk("git.push", workflowId, registry).allowed).toBe(true);
  expect(guardHighRisk("git.push", workflowId, registry).allowed).toBe(false);
  expect(guardHighRisk("git.merge", workflowId, registry).allowed).toBe(false);
  expect(guardHighRisk("pr.merge", workflowId, registry).allowed).toBe(false);
  
  // Reject re-blocks even if a prior approval existed.
  registry.approve(workflowId, "pr.merge", "admin-user");
  registry.reject(workflowId, "pr.merge", "admin-user");
  expect(guardHighRisk("pr.merge", workflowId, registry).allowed).toBe(false);
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
  registry.requirePending("wf-A", "git.push");
  registry.requirePending("wf-B", "git.push");
  registry.requirePending("wf-A", "pr.merge");
  
  registry.approve("wf-A", "git.push", "user");
  
  expect(guardHighRisk("git.push", "wf-A", registry).allowed).toBe(true);
  expect(guardHighRisk("git.push", "wf-B", registry).allowed).toBe(false);
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

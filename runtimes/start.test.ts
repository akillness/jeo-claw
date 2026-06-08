import { test, expect } from "bun:test";
import { commandForRuntime, resolveRuntimeEnvironment, validateRuntimeDispatchPayload, executeStageWork, handleDispatchRequest } from "./start.ts";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SecretSource } from "../secrets/loader.ts";

class MockSource implements SecretSource {
  constructor(private store: Record<string, string>) {}
  async access(id: string): Promise<string> {
    const value = this.store[id];
    if (value === undefined) throw new Error("not found");
    return value;
  }
}

test("commandForRuntime maps runtimes to startup commands", () => {
  expect(commandForRuntime("zeroclaw")).toEqual(["zeroclaw", "service", "start"]);
  expect(commandForRuntime("nullclaw")).toEqual(["nullclaw", "serve"]);
});

test("resolveRuntimeEnvironment loads least-privilege role secrets", async () => {
  const env = await resolveRuntimeEnvironment(
    "zeroclaw",
    {
      JEO_ROLE: "reviewer",
      GCLOUD_PROJECT: "project-id",
      GCLOUD_SECRET_PREFIX: "jeo-claw",
      JEO_WORKTREE: "/workspace",
      TARGET_REPO: "akillness/jeo-claw",
      OPENAI_API_KEY: "should-not-leak",
    },
    new MockSource({
      "jeo-claw-openai-api-key": "sk-live",
      "jeo-claw-github-token-ro": "ghp-live-ro",
      "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret",
    }),
  );

  expect(env.JEO_RUNTIME).toBe("zeroclaw");
  expect(env.JEO_ROLE).toBe("reviewer");
  expect(env.OPENAI_API_KEY).toBe("sk-live");
  expect(env.GITHUB_TOKEN).toBe("ghp-live-ro");
  expect(env.JEO_WORKTREE).toBe("/workspace");
});

test("resolveRuntimeEnvironment drops ambient secrets outside the role allowlist", async () => {
  const env = await resolveRuntimeEnvironment(
    "nullclaw",
    {
      JEO_ROLE: "reviewer",
      GCLOUD_PROJECT: "project-id",
      GCLOUD_SECRET_PREFIX: "jeo-claw",
      GITHUB_TOKEN: "should-not-leak",
      DISCORD_BOT_TOKEN: "should-not-leak",
      JEO_BRANCH_NAMESPACE: "jeo/nullclaw/reviewer/workflow",
    },
    new MockSource({
      "jeo-claw-openai-api-key": "sk-live",
      "jeo-claw-github-token-ro": "ghp-live-ro",
      "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret",
    }),
  );

  expect(env.GITHUB_TOKEN).toBe("ghp-live-ro");
  expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBe("sk-live");
});

test("resolveRuntimeEnvironment rejects missing role/project/prefix", async () => {
  await expect(
    resolveRuntimeEnvironment(
      "zeroclaw",
      { GCLOUD_PROJECT: "project-id", GCLOUD_SECRET_PREFIX: "jeo-claw" },
      new MockSource({}),
    ),
  ).rejects.toThrow("JEO_ROLE is missing or empty");
});
test("validateRuntimeDispatchPayload enforces runtime/role/stage matching", () => {
  const ok = validateRuntimeDispatchPayload(
    {
      workflowId: "wf-1",
      runtime: "zeroclaw",
      role: "reviewer",
      stage: "review",
      request: "check code",
    },
    "zeroclaw",
    "reviewer",
  );
  expect(ok.ok).toBe(true);

  const bad = validateRuntimeDispatchPayload(
    {
      workflowId: "wf-1",
      runtime: "nullclaw",
      role: "reviewer",
      stage: "review",
      request: "check code",
    },
    "zeroclaw",
    "reviewer",
  );
  expect(bad.ok).toBe(false);
});

test("executeStageWork writes a tangible stage artifact", () => {
  const root = join(process.env.TEMP || process.cwd(), "jeo-runtime-test-artifacts");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const artifact = executeStageWork(root, {
    workflowId: "wf-1",
    runtime: "zeroclaw",
    role: "reviewer",
    stage: "review",
    request: "review the generated code",
    headRef: "jeo/zeroclaw/pr-creator/wf-1",
  });
  const content = readFileSync(artifact, "utf8");
  expect(content).toContain("workflowId: wf-1");
  expect(content).toContain("stage: review");
});

test("handleDispatchRequest authenticates and writes artifact plus receipt", async () => {
  const stateDir = join(process.env.TEMP || process.cwd(), "jeo-runtime-test-state");
  const worktreeDir = join(process.env.TEMP || process.cwd(), "jeo-runtime-test-worktree");
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(worktreeDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });

  const badRes = await handleDispatchRequest(
    new Request("http://runtime/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId: "wf-1", runtime: "zeroclaw", role: "reviewer", stage: "review", request: "do work" }),
    }),
    "zeroclaw",
    "reviewer",
    "runtime-dispatch-secret",
    stateDir,
    worktreeDir,
  );
  expect(badRes.status).toBe(401);

  const goodRes = await handleDispatchRequest(
    new Request("http://runtime/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-runtime-dispatch-secret": "runtime-dispatch-secret",
      },
      body: JSON.stringify({ workflowId: "wf-1", runtime: "zeroclaw", role: "reviewer", stage: "review", request: "do work" }),
    }),
    "zeroclaw",
    "reviewer",
    "runtime-dispatch-secret",
    stateDir,
    worktreeDir,
  );
  expect(goodRes.status).toBe(200);
  const payload = await goodRes.json() as { receiptPath: string; artifactPath: string };
  expect(readFileSync(payload.receiptPath, "utf8")).toContain("\"workflowId\": \"wf-1\"");
  expect(readFileSync(payload.artifactPath, "utf8")).toContain("stage: review");
});

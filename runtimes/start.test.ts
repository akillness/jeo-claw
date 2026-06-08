import { test, expect } from "bun:test";
import { commandForRuntime, resolveRuntimeEnvironment } from "./start.ts";
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

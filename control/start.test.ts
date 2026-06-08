import { test, expect } from "bun:test";
import { commandForService, resolveControlEnvironment } from "./start.ts";
import type { SecretSource } from "../secrets/loader.ts";

class MockSource implements SecretSource {
  constructor(private store: Record<string, string>) {}
  async access(id: string): Promise<string> {
    const value = this.store[id];
    if (value === undefined) throw new Error("not found");
    return value;
  }
}

test("commandForService maps control services to startup commands", () => {
  expect(commandForService("glue-webhook")).toEqual(["bun", "run", "glue/server.ts"]);
  expect(commandForService("discord-bot")).toEqual(["bun", "run", "discord/bot.ts"]);
});

test("resolveControlEnvironment loads control secrets from Secret Manager inputs", async () => {
  const env = await resolveControlEnvironment(
    "glue-webhook",
    {
      GCLOUD_PROJECT: " project-id ",
      GCLOUD_SECRET_PREFIX: " jeo-claw ",
      GLUE_PORT: "8787",
    },
    new MockSource({
      "jeo-claw-github-webhook-secret": "whsec_live",
      "jeo-claw-control-event-secret": "control-secret",
      "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret",
    }),
  );

  expect(env.GCLOUD_PROJECT).toBe("project-id");
  expect(env.GCLOUD_SECRET_PREFIX).toBe("jeo-claw");
  expect(env.GITHUB_WEBHOOK_SECRET).toBe("whsec_live");
  expect(env.GLUE_PORT).toBe("8787");
});

test("resolveControlEnvironment rejects missing project or prefix", async () => {
  await expect(
    resolveControlEnvironment(
      "discord-bot",
      { GCLOUD_PROJECT: "", GCLOUD_SECRET_PREFIX: "jeo-claw" },
      new MockSource({ "jeo-claw-discord-bot-token": "xoxb-live", "jeo-claw-control-event-secret": "control-secret", "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret" }),
    ),
  ).rejects.toThrow("GCLOUD_PROJECT is missing or empty");

  await expect(
    resolveControlEnvironment(
      "discord-bot",
      { GCLOUD_PROJECT: "project-id", GCLOUD_SECRET_PREFIX: "   " },
      new MockSource({ "jeo-claw-discord-bot-token": "xoxb-live", "jeo-claw-control-event-secret": "control-secret", "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret" }),
    ),
  ).rejects.toThrow("GCLOUD_SECRET_PREFIX is missing or empty");
});

test("resolveControlEnvironment rejects blank loaded secrets", async () => {
  await expect(
    resolveControlEnvironment(
      "discord-bot",
      { GCLOUD_PROJECT: "project-id", GCLOUD_SECRET_PREFIX: "jeo-claw" },
      new MockSource({ "jeo-claw-discord-bot-token": "   ", "jeo-claw-control-event-secret": "control-secret", "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret" }),
    ),
  ).rejects.toThrow("jeo-claw-discord-bot-token resolved empty");
});
test("resolveControlEnvironment drops ambient non-control secrets from child env", async () => {
  const env = await resolveControlEnvironment(
    "discord-bot",
    {
      GCLOUD_PROJECT: "project-id",
      GCLOUD_SECRET_PREFIX: "jeo-claw",
      GLUE_EVENT_ENDPOINT: "http://glue-webhook:8787",
      DISCORD_GUILD_ID: "guild-1",
      DISCORD_REQUEST_CHANNEL_ID: "request-chan",
      DISCORD_APPROVAL_CHANNEL_ID: "approval-chan",
      GITHUB_TOKEN: "should-not-leak",
      OPENAI_API_KEY: "should-not-leak",
    },
    new MockSource({
      "jeo-claw-discord-bot-token": "xoxb-live",
      "jeo-claw-control-event-secret": "control-secret",
    }),
  );

  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.DISCORD_BOT_TOKEN).toBe("xoxb-live");
  expect(env.JEO_CONTROL_EVENT_SECRET).toBe("control-secret");
});

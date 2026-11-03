import { test, expect } from "bun:test";
import { bindTerminationHandlers, commandForService, resolveControlEnvironment } from "./start.ts";
import type { SecretSource } from "../secrets/loader.ts";
import { resolveLivePolicy } from "../discord/bot.ts";
import { ChannelType } from "discord.js";

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

test("bindTerminationHandlers forwards registered signals and unregisters on cleanup", () => {
  const registered = new Map<string, () => void>();
  const seen: string[] = [];

  const cleanup = bindTerminationHandlers(
    (signal, handler) => {
      registered.set(signal, handler);
    },
    (signal) => {
      registered.delete(signal);
    },
    (signal) => {
      seen.push(signal);
    },
  );

  registered.get("SIGTERM")?.();
  registered.get("SIGINT")?.();
  expect(seen).toEqual(["SIGTERM", "SIGINT"]);

  cleanup();
  expect(registered.size).toBe(0);
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
      "jeo-claw-github-webhook-secret": "whsec_generated_secret_value",
      "jeo-claw-control-event-secret": "control-event-secret-value",
      "jeo-claw-status-relay-secret": "status-relay-secret-value",
      "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret-value",
    }),
  );

  expect(env.GCLOUD_PROJECT).toBe("project-id");
  expect(env.GCLOUD_SECRET_PREFIX).toBe("jeo-claw");
  expect(env.GITHUB_WEBHOOK_SECRET).toBe("whsec_generated_secret_value");
  expect(env.GLUE_PORT).toBe("8787");
});

test("resolveControlEnvironment rejects missing project or prefix", async () => {
  await expect(
    resolveControlEnvironment(
      "discord-bot",
      { GCLOUD_PROJECT: "", GCLOUD_SECRET_PREFIX: "jeo-claw" },
      new MockSource({ "jeo-claw-discord-bot-token": "xoxb-live", "jeo-claw-control-event-secret": "control-event-secret-value", "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret-value" }),
    ),
  ).rejects.toThrow("GCLOUD_PROJECT is missing or empty");

  await expect(
    resolveControlEnvironment(
      "discord-bot",
      { GCLOUD_PROJECT: "project-id", GCLOUD_SECRET_PREFIX: "   " },
      new MockSource({ "jeo-claw-discord-bot-token": "xoxb-live", "jeo-claw-control-event-secret": "control-event-secret-value", "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret-value" }),
    ),
  ).rejects.toThrow("GCLOUD_SECRET_PREFIX is missing or empty");
});

test("resolveControlEnvironment rejects blank loaded secrets", async () => {
  await expect(
    resolveControlEnvironment(
      "discord-bot",
      { GCLOUD_PROJECT: "project-id", GCLOUD_SECRET_PREFIX: "jeo-claw" },
      new MockSource({ "jeo-claw-discord-bot-token": "   ", "jeo-claw-control-event-secret": "control-event-secret-value", "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret-value" }),
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
      "jeo-claw-control-event-secret": "control-event-secret-value",
      "jeo-claw-status-relay-secret": "status-relay-secret-value",
    }),
  );

  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.DISCORD_BOT_TOKEN).toBe("xoxb-live");
  expect(env.JEO_CONTROL_EVENT_SECRET).toBe("control-event-secret-value");
});

test("control startup preserves channel names for Discord discovery", async () => {
  const env = await resolveControlEnvironment("discord-bot", {
    GCLOUD_PROJECT: "project-id", GCLOUD_SECRET_PREFIX: "jeo-claw", DISCORD_GUILD_ID: "guild-1",
    DISCORD_REQUEST_CHANNEL_NAME: "team-requests", DISCORD_APPROVAL_CHANNEL_NAME: "team-approvals",
  }, new MockSource({
    "jeo-claw-discord-bot-token": "synthetic-discord-token-long",
    "jeo-claw-control-event-secret": "synthetic-control-secret-long",
    "jeo-claw-status-relay-secret": "synthetic-relay-secret-long",
  }));
  const channels = new Map([
    ["request-id", { id: "request-id", name: "team-requests", type: ChannelType.GuildText }],
    ["approval-id", { id: "approval-id", name: "team-approvals", type: ChannelType.GuildText }],
  ]);
  const client = { guilds: { fetch: async () => ({ channels: { fetch: async () => channels } }) } };
  const policy = await resolveLivePolicy(client, env);
  expect(policy.requestChannelId).toBe("request-id");
  expect(policy.approvalChannelId).toBe("approval-id");
});

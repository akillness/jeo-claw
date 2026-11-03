import { test, expect } from "bun:test";
import { ChannelType } from "discord.js";
import { buildHandlers, buildStatusRelayHandler, resolveLivePolicy } from "./bot.ts";
import type { ControlEvent } from "../glue/contract.ts";

test("probe-only Discord rejects ordinary requests and approvals while allowing an authenticated ping", async () => {
  const events: ControlEvent[] = [];
  const replies: string[] = [];
  const handlers = buildHandlers({ mode: "probe-only", policy: { guildId: "123", requestChannelId: "456", approvalChannelId: "789", approverRoleId: "reviewer" },
    onEvent: (event) => { events.push(event); } });
  const interaction = (commandName: string, values: Record<string, string>, guildId = "123", channelId = "456") => ({
    isChatInputCommand: () => true, commandName, guildId, channelId, user: { tag: "alice" },
    member: { roles: { cache: new Set(["reviewer"]) } }, options: { getString: (key: string) => values[key] },
    deferReply: async () => {}, reply: async (value: { content: string }) => { replies.push(value.content); },
    editReply: async (value: { content: string }) => { replies.push(value.content); },
  });
  await handlers.handleInteraction(interaction("request", { runtime: "zeroclaw", request: "implement feature" }));
  await handlers.handleInteraction(interaction("approve", { workflowid: "wf-existing", action: "pr.create" }, "123", "789"));
  expect(events).toEqual([]);
  expect(replies).toEqual(["Ordinary workflow commands are disabled in probe-only mode.", "Ordinary workflow commands are disabled in probe-only mode."]);
  await handlers.handleInteraction(interaction("ping", {}, "999"));
  expect(events).toEqual([]);
  expect(replies.at(-1)).toContain("wrong guild");
  await handlers.handleInteraction(interaction("ping", {}));
  expect(events).toEqual([{ type: "ping" }]);
  expect(replies.at(-1)).toBe("pong");
});

test("probe-only policy requires the configured numeric guild and existing text channel", async () => {
  const client = { guilds: { fetch: async (id: string) => {
    if (id !== "123") throw new Error("unknown guild");
    return { channels: { fetch: async (channel: string) => channel === "456" ? { type: ChannelType.GuildText } : null } };
  } } };
  const env = { JEO_CONTROL_MODE: "probe-only", DISCORD_GUILD_ID: "123", DISCORD_REQUEST_CHANNEL_ID: "456" };
  const policy = await resolveLivePolicy(client, env);
  expect(policy.guildId).toBe("123");
  expect(policy.requestChannelId).toBe("456");
  await expect(resolveLivePolicy(client, { ...env, DISCORD_GUILD_ID: "not-a-number" })).rejects.toThrow("numeric");
  await expect(resolveLivePolicy(client, { ...env, DISCORD_GUILD_ID: "999" })).rejects.toThrow("unknown guild");
  await expect(resolveLivePolicy(client, { ...env, DISCORD_REQUEST_CHANNEL_ID: "999" })).rejects.toThrow("missing or not a text channel");
});

test("probe-only relay refuses ordinary approval notifications without sending controls", async () => {
  const sent: Array<{ content: string; components: unknown[] }> = [];
  const sendToChannel = async (_id: string | undefined, content: string, components?: unknown[]) => { sent.push({ content, components: components ?? [] }); };
  const request = (secret: string) => new Request("http://localhost/status", { method: "POST", headers: { "x-status-relay-secret": secret },
    body: JSON.stringify({ workflowId: "wf-existing", stage: "pr-create", status: "awaiting-approval", pendingAction: "pr.create", message: "approve" }) });
  const blocked = buildStatusRelayHandler({ statusRelaySecret: "relay-secret", mode: "probe-only", sendToChannel });
  expect((await blocked(request("wrong"))).status).toBe(401);
  expect((await blocked(request("relay-secret"))).status).toBe(409);
  expect(sent).toEqual([]);
  const normal = buildStatusRelayHandler({ statusRelaySecret: "relay-secret", mode: "normal", sendToChannel });
  expect((await normal(request("relay-secret"))).status).toBe(200);
  expect(JSON.stringify(sent)).toContain("approve:wf-existing:pr.create");
});

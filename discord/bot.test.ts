import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";
import { buildHandlers, buildStatusRelayHandler, start } from "./bot.ts";
import type { ControlEvent } from "../glue/contract.ts";

class FakeClient extends EventEmitter {
  user = { id: "bot", tag: "bot#1" };
  application = { id: "app" };
  channels: { fetch: (id: string) => Promise<unknown> } = { fetch: async () => null };
  destroyed = 0;
  async login() { return "logged-in"; }
  async destroy() { this.destroyed++; }
}

const policy = {
  guildId: "guild", controlEndpoint: "http://127.0.0.1:1", controlEventSecret: "secret",
};

async function withToken(run: () => Promise<void>) {
  const original = process.env.DISCORD_BOT_TOKEN;
  const originalRelay = process.env.JEO_STATUS_RELAY_SECRET;
  process.env.DISCORD_BOT_TOKEN = "test-token";
  process.env.JEO_STATUS_RELAY_SECRET = "synthetic-status-relay-secret";
  try { await run(); } finally {
    if (original === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = original;
    if (originalRelay === undefined) delete process.env.JEO_STATUS_RELAY_SECRET;
    else process.env.JEO_STATUS_RELAY_SECRET = originalRelay;
  }
}

function availablePort() {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port;
}

test("repeated bot shutdown releases the relay port and owned listeners", async () => {
  await withToken(async () => {
    const port = availablePort();
    for (let i = 0; i < 3; i++) {
      const client = new FakeClient();
      const started = await start({
        createClient: () => client as unknown as Client,
        resolvePolicy: async () => policy,
        registerCommands: async () => {},
        relayPort: port,
      });
      expect(client.listenerCount("messageCreate")).toBe(1);
      expect(client.listenerCount("interactionCreate")).toBe(1);
      await started.destroy();
      await started.destroy();
      expect(client.destroyed).toBe(1);
      expect(client.listenerCount("ready")).toBe(0);
      expect(client.listenerCount("messageCreate")).toBe(0);
      expect(client.listenerCount("interactionCreate")).toBe(0);
      const probe = Bun.serve({ port, hostname: "0.0.0.0", fetch: () => new Response() });
      probe.stop(true);
    }
  });
});

test("failed command registration closes relay and destroys logged-in client", async () => {
  await withToken(async () => {
    const port = availablePort();
    const client = new FakeClient();
    await expect(start({
      createClient: () => client as unknown as Client,
      resolvePolicy: async () => policy,
      registerCommands: async () => { throw new Error("registration failed"); },
      relayPort: port,
    })).rejects.toThrow("registration failed");
    expect(client.destroyed).toBe(1);
    expect(client.listenerCount("ready")).toBe(0);
    expect(client.listenerCount("messageCreate")).toBe(0);
    expect(client.listenerCount("interactionCreate")).toBe(0);
    const probe = Bun.serve({ port, hostname: "0.0.0.0", fetch: () => new Response() });
    probe.stop(true);
  });
});

test("bot startup rejects a relay secret reused as its Discord token", async () => {
  await withToken(async () => {
    const shared = "synthetic-shared-discord-secret-long";
    process.env.DISCORD_BOT_TOKEN = shared;
    process.env.JEO_STATUS_RELAY_SECRET = shared;
    const client = new FakeClient();
    await expect(start({ createClient: () => client as unknown as Client, resolvePolicy: async () => policy,
      registerCommands: async () => {}, relayPort: 0 })).rejects.toThrow();
    expect(client.destroyed).toBe(1);
  });
});

test("startup never logs the control-event secret on success or registration failure", async () => {
  const secret = "synthetic-control-secret-8b7f2c";
  const token = "synthetic-discord-token";
  const temp = mkdtempSync(join(tmpdir(), "jeo-bot-redaction-"));
  const script = `
    import { EventEmitter } from "node:events";
    import { start } from "./discord/bot.ts";
    class FakeClient extends EventEmitter {
      user = { id: "bot", tag: "bot#1" };
      application = { id: "app" };
      channels = { fetch: async () => null };
      async login() { return "logged-in"; }
      async destroy() {}
    }
    try {
      const client = await start({
        createClient: () => new FakeClient(),
        resolvePolicy: async () => ({ guildId: "redaction-guild", controlEndpoint: "http://127.0.0.1:1", controlEventSecret: process.env.TEST_SECRET }),
        registerCommands: async () => { if (process.env.TEST_FAIL === "yes") throw new Error("synthetic registration failure"); },
        relayPort: 0,
      });
      await client.destroy();
    } catch (error) {
      console.error("caught startup failure:", error);
      process.exitCode = 1;
    }
  `;
  try {
    for (const failure of [false, true]) {
      const child = Bun.spawn([process.execPath, "--smol", "-e", script], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, HOME: temp, TMPDIR: temp, DISCORD_BOT_TOKEN: token, TEST_SECRET: secret, TEST_FAIL: failure ? "yes" : "no", JEO_STATUS_RELAY_SECRET: "synthetic-status-relay-secret" },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exitCode).toBe(failure ? 1 : 0);
      expect(stdout).toContain("redaction-guild");
      if (failure) expect(stderr).toContain("synthetic registration failure");
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
      expect(stdout).not.toContain(token);
      expect(stderr).not.toContain(token);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("destroy aborts an in-flight Discord status request", async () => {
  await withToken(async () => {
    let received!: () => void;
    const arrived = new Promise<void>((resolve) => { received = resolve; });
    let finish!: (response: Response) => void;
    const relay = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
      received();
      return new Promise<Response>((resolve) => { finish = resolve; });
    } });
    const client = new FakeClient();
    const started = await start({
      createClient: () => client as unknown as Client,
      resolvePolicy: async () => ({ ...policy, controlEndpoint: `http://127.0.0.1:${relay.port}` }),
      registerCommands: async () => {}, relayPort: 0,
    });
    let replies = 0;
    try {
      const handleInteraction = client.listeners("interactionCreate")[0] as (interaction: unknown) => Promise<void>;
      const handling = handleInteraction({
        isChatInputCommand: () => true, commandName: "status",
        deferReply: async () => {}, editReply: async () => { replies++; },
      });
      await arrived;
      await started.destroy();
      await handling;
      expect(replies).toBe(0);
      expect(client.destroyed).toBe(1);
    } finally {
      await started.destroy();
      finish?.(new Response("done"));
      relay.stop(true);
    }
  });
});

test("merge approval button displays and forwards the exact reviewed head SHA", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const events: ControlEvent[] = [];
  let content = "";
  let components: unknown[] = [];
  const relay = buildStatusRelayHandler({ statusRelaySecret: "synthetic-relay-secret", sendToChannel: async (_id, text, rows) => {
    content = text;
    components = rows ?? [];
  } });
  const response = await relay(new Request("http://localhost/status", {
    headers: { "x-status-relay-secret": "synthetic-relay-secret" },
    method: "POST", body: JSON.stringify({ workflowId: "wf-sha", stage: "merge", status: "awaiting-approval", pendingAction: "pr.merge", headSha: sha, message: "review this change" }),
  }));
  expect(response.status).toBe(200);
  expect(content).toContain(sha);
  const rows = components as Array<{ components: Array<{ custom_id: string }> }>;
  const approve = rows.flatMap((row) => row.components).find((button) => button.custom_id.startsWith("approve:"));
  expect(approve?.custom_id).toBe(`approve:wf-sha:pr.merge:${sha}`);
  const handlers = buildHandlers({
    policy: { guildId: "guild", approvalChannelId: "approvals", approverRoleId: "reviewer" },
    onEvent: (event) => { events.push(event); },
  });
  await handlers.handleInteraction({
    isButton: () => true, customId: approve!.custom_id, guildId: "guild", channelId: "approvals",
    user: { tag: "alice" }, member: { roles: { cache: new Set(["reviewer"]) } },
    update: async () => {}, followUp: async () => {},
  });
  expect(events).toEqual([{ type: "approve", source: "discord", workflowId: "wf-sha", action: "pr.merge", user: "alice", headSha: sha }]);
});

test("slash merge approval requires a full reviewed SHA and forwards it unchanged", async () => {
  const events: ControlEvent[] = [];
  const handlers = buildHandlers({
    policy: { guildId: "guild", approvalChannelId: "approvals", approverRoleId: "reviewer" },
    onEvent: (event) => { events.push(event); },
  });
  const sha = "0123456789abcdef0123456789abcdef01234567";
  for (const value of [undefined, sha.slice(0, 39), sha.toUpperCase()]) {
    await handlers.handleInteraction({
      isChatInputCommand: () => true, commandName: "approve", guildId: "guild", channelId: "approvals",
      user: { tag: "alice" }, member: { roles: { cache: new Set(["reviewer"]) } },
      options: { getString: (key: string) => ({ workflowid: "wf-sha", action: "pr.merge", headsha: value } as Record<string, string | undefined>)[key] },
      reply: async () => {}, deferReply: async () => {}, editReply: async () => {},
    });
  }
  expect(events).toEqual([]);
  await handlers.handleInteraction({
    isChatInputCommand: () => true, commandName: "approve", guildId: "guild", channelId: "approvals",
    user: { tag: "alice" }, member: { roles: { cache: new Set(["reviewer"]) } },
    options: { getString: (key: string) => ({ workflowid: "wf-sha", action: "pr.merge", headsha: sha } as Record<string, string>)[key] },
    reply: async () => {}, deferReply: async () => {}, editReply: async () => {},
  });
  expect(events).toEqual([{ type: "approve", source: "discord", workflowId: "wf-sha", action: "pr.merge", user: "alice", headSha: sha }]);
});

test("merge notifications never offer approval without a valid, encodable head SHA", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  for (const [workflowId, headSha] of [["wf-no-sha", undefined], ["wf-bad-sha", "bad"], ["w".repeat(50), sha]] as const) {
    let components: unknown[] = [];
    const relay = buildStatusRelayHandler({ statusRelaySecret: "synthetic-relay-secret", sendToChannel: async (_id, _content, rows) => { components = rows ?? []; } });
    const response = await relay(new Request("http://localhost/status", {
      headers: { "x-status-relay-secret": "synthetic-relay-secret" },
      method: "POST", body: JSON.stringify({ workflowId, stage: "merge", status: "awaiting-approval", pendingAction: "pr.merge", headSha, message: "review" }),
    }));
    expect(response.status).toBe(200);
    const rows = components as Array<{ components: Array<{ custom_id: string }> }>;
    const ids = rows.flatMap((row) => row.components.map((button) => button.custom_id));
    expect(ids.some((id) => id.startsWith("approve:"))).toBe(false);
    expect(ids).toContain(`reject:${workflowId}:pr.merge`);
  }
});

test("status relay routes approval buttons to approval channel and clears stale buttons", async () => {
  await withToken(async () => {
    type Message = { content: string; components: unknown[] };
    const channels = new Map<string, Map<string, Message>>();
    let nextId = 0;
    const client = new FakeClient();
    client.channels.fetch = async (id: string) => {
      let messages = channels.get(id);
      if (!messages) { messages = new Map(); channels.set(id, messages); }
      const entries = messages;
      return {
        send: async (message: Message) => { const key = String(++nextId); entries.set(key, message); return { id: key }; },
        messages: { fetch: async (key: string) => entries.has(key) ? { edit: async (message: Message) => { entries.set(key, message); } } : null },
      };
    };
    const port = availablePort();
    const started = await start({ createClient: () => client as unknown as Client,
      resolvePolicy: async () => ({ ...policy, requestChannelId: "requests", approvalChannelId: "approvals", approverRoleId: "reviewer" }),
      registerCommands: async () => {}, relayPort: port });
    const post = (body: object) => fetch(`http://127.0.0.1:${port}/status`, {
      method: "POST", headers: { "x-status-relay-secret": "synthetic-status-relay-secret" }, body: JSON.stringify(body),
    });
    const sha = "0123456789abcdef0123456789abcdef01234567";
    try {
      expect((await post({ workflowId: "wf-routing", stage: "merge", status: "awaiting-approval", pendingAction: "pr.merge", headSha: sha, message: "review" })).status).toBe(200);
      const approvals = [...(channels.get("approvals")?.values() ?? [])];
      expect(approvals).toHaveLength(1);
      expect(JSON.stringify(approvals[0]?.components)).toContain(`approve:wf-routing:pr.merge:${sha}`);
      expect(JSON.stringify([...(channels.get("requests")?.values() ?? [])])).not.toContain("approve:wf-routing");
      expect((await post({ workflowId: "wf-routing", stage: "merge", status: "running", message: "continuing" })).status).toBe(200);
      expect(JSON.stringify([...(channels.get("approvals")?.values() ?? [])])).not.toContain("approve:wf-routing");
    } finally {
      await started.destroy();
    }
  });
});

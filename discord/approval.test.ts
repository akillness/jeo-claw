import { test, expect } from "bun:test";
import { ApprovalRegistry, guardHighRisk } from "./approval.ts";
import { createWorkflow, applyEvent } from "../glue/state-machine.ts";
import type { WorkflowState, ControlEvent } from "../glue/contract.ts";
import { buildHandlers, discordCommandDefinitions, forwardControlEvent, resolveLivePolicy } from "./bot.ts";

test("ApprovalRegistry: action-scoped lifecycle with consume", () => {
  const registry = new ApprovalRegistry();
  const wfId = "wf-123";

  expect(registry.status(wfId, "pr.create")).toBeUndefined();
  expect(registry.isApproved(wfId, "pr.create")).toBe(false);

  registry.requirePending(wfId, "pr.create");
  expect(registry.status(wfId, "pr.create")).toBe("pending");
  expect(registry.status(wfId, "pr.merge")).toBeUndefined();

  registry.approve(wfId, "pr.create", "alice");
  expect(registry.status(wfId, "pr.create")).toBe("approved");
  expect(registry.isApproved(wfId, "pr.create")).toBe(true);
  expect(registry.getApprover(wfId, "pr.create")).toBe("alice");

  expect(registry.consume(wfId, "pr.create")).toBe(true);
  expect(registry.status(wfId, "pr.create")).toBe("consumed");
  expect(registry.consume(wfId, "pr.create")).toBe(false);

  registry.reject(wfId, "pr.merge", "bob");
  expect(registry.status(wfId, "pr.merge")).toBe("rejected");
  expect(registry.isApproved(wfId, "pr.merge")).toBe(false);
  expect(registry.getApprover(wfId, "pr.merge")).toBe("bob");
});

test("ApprovalRegistry prunes stale terminal records and preserves recent approvals", () => {
  let now = Date.parse("2026-06-09T00:00:00.000Z");
  const registry = new ApprovalRegistry({
    maxRecords: 2,
    retentionMs: 60 * 60 * 1000,
    now: () => now,
  });

  registry.approve("wf-old", "pr.create", "alice");
  registry.consume("wf-old", "pr.create");

  now = Date.parse("2026-06-09T03:00:00.000Z");
  registry.approve("wf-new", "pr.create", "bob");
  registry.approve("wf-keep", "pr.merge", "carol");

  expect(registry.status("wf-old", "pr.create")).toBeUndefined();
  expect(registry.status("wf-new", "pr.create")).toBe("approved");
  expect(registry.status("wf-keep", "pr.merge")).toBe("approved");
});

test("ApprovalRegistry bounded mode evicts consumed records before approved records", () => {
  const registry = new ApprovalRegistry({ maxRecords: 2 });

  registry.approve("wf-consumed", "pr.create", "alice");
  registry.consume("wf-consumed", "pr.create");
  registry.approve("wf-approved-1", "pr.create", "bob");
  registry.approve("wf-approved-2", "pr.merge", "carol");

  expect(registry.status("wf-consumed", "pr.create")).toBeUndefined();
  expect(registry.status("wf-approved-1", "pr.create")).toBe("approved");
  expect(registry.status("wf-approved-2", "pr.merge")).toBe("approved");
});

test("guardHighRisk: blocks, consumes matching action approval, and isolates actions", () => {
  const registry = new ApprovalRegistry();
  const wfId = "wf-456";
  const highRiskActions = ["pr.create", "pr.merge"];
  const nonHighRiskActions = ["git.checkout", "ci.run", "comment.add", "build"];

  registry.requirePending(wfId, "pr.create");
  for (const action of highRiskActions) {
    const res = guardHighRisk(action, wfId, registry);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("requires unconsumed Discord approval");
  }

  for (const action of nonHighRiskActions) {
    const res = guardHighRisk(action, wfId, registry);
    expect(res.allowed).toBe(true);
    expect(res.reason).toBeUndefined();
  }

  registry.approve(wfId, "pr.create", "alice");
  expect(guardHighRisk("pr.create", wfId, registry).allowed).toBe(true);
  expect(guardHighRisk("pr.create", wfId, registry).allowed).toBe(false);
  expect(guardHighRisk("pr.merge", wfId, registry).allowed).toBe(false);

  registry.approve(wfId, "pr.merge", "alice");
  registry.reject(wfId, "pr.merge", "bob");
  expect(guardHighRisk("pr.merge", wfId, registry).allowed).toBe(false);
});

test("bot handlers: buildHandlers routes action-scoped events and manages registry", async () => {
  const registry = new ApprovalRegistry();
  const receivedEvents: ControlEvent[] = [];
  const onEvent = async (e: ControlEvent) => {
    receivedEvents.push(e);
  };

  const handlers = buildHandlers({ registry, onEvent });

  let replyCalled = false;
  let replyContent = "";
  const mockMsgRequest = {
    content: "request zeroclaw build something",
    author: { bot: false, tag: "alice#0001" },
    reply: async (msg: string) => {
      replyCalled = true;
      replyContent = msg;
    },
  };

  await handlers.handleMessage(mockMsgRequest);
  expect(receivedEvents).toHaveLength(1);
  expect(receivedEvents[0]).toEqual({
    type: "request",
    runtime: "zeroclaw",
    request: "build something",
  });
  expect(replyCalled).toBe(true);
  expect(replyContent).toBe("Processed command: request");

  replyCalled = false;
  const mockMsgApprove = {
    content: "approve wf-888 pr.create",
    author: { bot: false, tag: "bob#0002" },
    reply: async () => {
      replyCalled = true;
    },
  };
  registry.requirePending("wf-888", "pr.create");
  expect(registry.status("wf-888", "pr.create")).toBe("pending");

  await handlers.handleMessage(mockMsgApprove);
  expect(receivedEvents).toHaveLength(2);
  expect(receivedEvents[1]).toEqual({
    type: "approve",
    workflowId: "wf-888",
    action: "pr.create",
    user: "bob#0002",
  });
  expect(registry.status("wf-888", "pr.create")).toBe("approved");
  expect(registry.getApprover("wf-888", "pr.create")).toBe("bob#0002");

  const initialEventsLength = receivedEvents.length;
  const mockMsgBot = {
    content: "approve wf-888 pr.create",
    author: { bot: true, tag: "bot#0000" },
    reply: async () => {},
  };
  await handlers.handleMessage(mockMsgBot);
  expect(receivedEvents).toHaveLength(initialEventsLength);

  let interactionReplyCalled = false;
  let interactionReplyContent: any = null;
  const mockInteraction = {
    isChatInputCommand: () => true,
    commandName: "config",
    user: { tag: "admin#1337" },
    options: {
      getSubcommand: () => "set",
      getString: (name: string) => {
        if (name === "key") return "provider";
        if (name === "value") return "openai-codex";
        return null;
      },
    },
    reply: async (payload: any) => {
      interactionReplyCalled = true;
      interactionReplyContent = payload;
    },
  };

  await handlers.handleInteraction(mockInteraction);
  expect(receivedEvents).toHaveLength(initialEventsLength);
  expect(interactionReplyCalled).toBe(true);
  expect(interactionReplyContent.content).toContain("config-set is not implemented");

  let buttonReplyCalled = false;
  let buttonReplyContent: any = null;
  const mockButtonInteraction = {
    isButton: () => true,
    customId: "approve:wf-999:pr.merge",
    user: { tag: "approver#9999" },
    reply: async (payload: any) => {
      buttonReplyCalled = true;
      buttonReplyContent = payload;
    },
  };

  registry.requirePending("wf-999", "pr.merge");
  await handlers.handleInteraction(mockButtonInteraction);
  expect(registry.status("wf-999", "pr.merge")).toBe("approved");
  expect(registry.getApprover("wf-999", "pr.merge")).toBe("approver#9999");
  expect(buttonReplyCalled).toBe(true);
  expect(buttonReplyContent.content).toContain("Workflow wf-999 action pr.merge approved.");
});

test("bot handlers with bridging: request creates workflow, action approval bridges to store, config set yolo is rejected", async () => {
  const registry = new ApprovalRegistry();
  const store = new Map<string, WorkflowState>();

  const handlers = buildHandlers({
    registry,
    store,
    createWorkflow,
    applyEvent,
    onEvent: async () => {}
  });

  const mockMsgRequest = {
    content: "request zeroclaw build a secure feature",
    author: { bot: false, tag: "alice#0001" },
    reply: async () => {},
  };
  await handlers.handleMessage(mockMsgRequest);

  expect(store.size).toBe(1);
  const [wfId, wf] = Array.from(store.entries())[0]!;
  expect(wf.runtime).toBe("zeroclaw");
  expect(wf.request).toBe("build a secure feature");
  expect(wf.actionApprovals).toBeUndefined();

  const mockMsgApprove = {
    content: `approve ${wfId} pr.create`,
    author: { bot: false, tag: "bob#0002" },
    reply: async () => {},
  };
  await handlers.handleMessage(mockMsgApprove);

  expect(registry.isApproved(wfId, "pr.create")).toBe(true);
  const updatedWf = store.get(wfId);
  expect(updatedWf).toBeDefined();
  expect(updatedWf!.actionApprovals?.["pr.create"]?.status).toBeUndefined();

  let rejectReply = "";
  const badConfig = {
    content: "config set autonomy yolo",
    author: { bot: false, tag: "admin#0001" },
    reply: async (msg: string) => { rejectReply = msg; },
  };
  await handlers.handleMessage(badConfig);
  expect(rejectReply).toContain("Only 'supervised' is allowed");
});
test("bot handlers forward events through async onEvent bridge", async () => {
  const registry = new ApprovalRegistry();
  const received: ControlEvent[] = [];
  const handlers = buildHandlers({
    registry,
    onEvent: async (event) => {
      received.push(event);
    },
  });

  await handlers.handleMessage({
    content: "approve wf-42 pr.create",
    author: { bot: false, tag: "alice#0001" },
    reply: async () => {},
  });

  expect(received).toEqual([
    {
      type: "approve",
      workflowId: "wf-42",
      action: "pr.create",
      user: "alice#0001",
    },
  ]);
});
test("bot handlers reply to direct mentions and parse commands after mention", async () => {
  const registry = new ApprovalRegistry();
  const received: ControlEvent[] = [];
  const replies: string[] = [];
  const handlers = buildHandlers({
    registry,
    botUserId: "bot-1",
    onEvent: async (event) => {
      received.push(event);
    },
  });

  await handlers.handleMessage({
    content: "<@bot-1> 하이",
    author: { bot: false, tag: "alice#0001" },
    reply: async (msg: string) => { replies.push(msg); },
  });

  expect(replies.at(-1)).toContain("request zeroclaw");

  await handlers.handleMessage({
    content: "<@bot-1> request nullclaw do live work",
    author: { bot: false, tag: "alice#0001" },
    reply: async (msg: string) => { replies.push(msg); },
  });

  expect(received.at(-1)).toEqual({
    type: "request",
    runtime: "nullclaw",
    request: "do live work",
  });
  expect(replies.at(-1)).toContain("Processed command: request");
});
test("bot handlers can fan out request both into both runtimes", async () => {
  const registry = new ApprovalRegistry();
  const received: ControlEvent[] = [];
  const replies: string[] = [];
  const handlers = buildHandlers({
    registry,
    botUserId: "bot-1",
    onEvent: async (event) => {
      received.push(event);
    },
  });

  await handlers.handleMessage({
    content: "<@bot-1> request both do the same work",
    author: { bot: false, tag: "alice#0001" },
    reply: async (msg: string) => { replies.push(msg); },
  });

  expect(received).toEqual([
    { type: "request", runtime: "zeroclaw", request: "do the same work" },
    { type: "request", runtime: "nullclaw", request: "do the same work" },
  ]);
  expect(replies.at(-1)).toContain("Processed command: request");
});
test("bot handlers reject commands from the wrong guild or channel", async () => {
  const registry = new ApprovalRegistry();
  const received: ControlEvent[] = [];
  let reply = "";
  const handlers = buildHandlers({
    registry,
    policy: {
      guildId: "guild-1",
      requestChannelId: "request-chan",
      approvalChannelId: "approval-chan",
    },
    onEvent: async (event) => {
      received.push(event);
    },
  });

  await handlers.handleMessage({
    content: "request zeroclaw build something",
    author: { bot: false, tag: "alice#0001" },
    guildId: "guild-2",
    channelId: "request-chan",
    member: {},
    reply: async (msg: string) => { reply = msg; },
  });

  expect(received).toEqual([]);
  expect(reply).toContain("wrong guild");
});

test("bot handlers require approval permission for approve/reject/config-set", async () => {
  const registry = new ApprovalRegistry();
  let reply = "";
  const handlers = buildHandlers({
    registry,
    policy: {
      guildId: "guild-1",
      requestChannelId: "request-chan",
      approvalChannelId: "approval-chan",
      approverRoleId: "approver-role",
    },
    onEvent: async () => {},
  });

  await handlers.handleMessage({
    content: "approve wf-1 pr.merge",
    author: { bot: false, tag: "alice#0001" },
    guildId: "guild-1",
    channelId: "approval-chan",
    member: { roles: { cache: new Set() }, permissions: { has: () => false } },
    reply: async (msg: string) => { reply = msg; },
  });

  expect(reply).toContain("approver permission required");
});

test("discordCommandDefinitions registers the production slash command surface", () => {
  const commands = discordCommandDefinitions() as Array<{ name: string }>;

  expect(commands.map((command) => command.name)).toEqual(["request", "approve", "reject", "config"]);
});

test("bot handlers reply with delivery failures instead of hanging", async () => {
  const registry = new ApprovalRegistry();
  let reply = "";
  const handlers = buildHandlers({
    registry,
    onEvent: async () => {
      throw new Error("glue unavailable");
    },
  });

  await handlers.handleMessage({
    content: "request zeroclaw build something",
    author: { bot: false, tag: "alice#0001" },
    reply: async (msg: string) => { reply = msg; },
  });

  expect(reply).toContain("Command failed: glue unavailable");
});

test("bot interaction handlers defer before forwarding and edit final response", async () => {
  const registry = new ApprovalRegistry();
  let deferred = false;
  let edited = "";
  const handlers = buildHandlers({
    registry,
    onEvent: async () => {},
  });

  await handlers.handleInteraction({
    isChatInputCommand: () => true,
    commandName: "request",
    user: { tag: "alice#0001" },
    options: {
      getString: (name: string) => {
        if (name === "runtime") return "zeroclaw";
        if (name === "request") return "build something";
        return null;
      },
    },
    deferReply: async (payload: { ephemeral: boolean }) => {
      deferred = payload.ephemeral;
    },
    editReply: async (payload: { content: string }) => {
      edited = payload.content;
    },
  });

  expect(deferred).toBe(true);
  expect(edited).toContain("Processed command: request");
});
test("forwardControlEvent does not echo upstream response bodies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("secret ghp_should_not_log", { status: 500 })) as unknown as typeof fetch;
  try {
    let message = "";
    try {
      await forwardControlEvent("http://glue", "control-secret", { type: "request", runtime: "zeroclaw", request: "do work" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe("control event delivery failed (500)");
    expect(message).not.toContain("ghp_should_not_log");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveLivePolicy auto-selects single guild and provisions missing channels by name", async () => {
  const created: string[] = [];
  const guild = {
    id: "guild-1",
    channels: {
      fetch: async (id?: string) => {
        if (id) return undefined;
        return new Map<string, any>([]);
      },
      create: async ({ name }: { name: string }) => {
        created.push(name);
        return { id: `${name}-id`, name, type: 0 };
      },
    },
  };
  const client = {
    guilds: {
      cache: new Map([["guild-1", guild]]),
      fetch: async () => guild,
    },
  };

  const policy = await resolveLivePolicy(client, {
    GLUE_EVENT_ENDPOINT: "http://glue-webhook:8787",
    JEO_CONTROL_EVENT_SECRET: "control-secret",
  } as NodeJS.ProcessEnv);

  expect(policy.guildId).toBe("guild-1");
  expect(policy.requestChannelId).toBe("jeo-request-id");
  expect(policy.approvalChannelId).toBe("jeo-approval-id");
  expect(created).toEqual(["jeo-request", "jeo-approval"]);
});

test("resolveLivePolicy respects configured channel ids", async () => {
  const channels = new Map([
    ["request-1", { id: "request-1", name: "request", type: 0 }],
    ["approval-1", { id: "approval-1", name: "approval", type: 0 }],
  ]);
  const guild = {
    id: "guild-1",
    channels: {
      fetch: async (id?: string) => {
        if (id) return channels.get(id);
        return channels;
      },
      create: async () => {
        throw new Error("should not create");
      },
    },
  };
  const client = {
    guilds: {
      cache: new Map([["guild-1", guild]]),
      fetch: async () => guild,
    },
  };

  const policy = await resolveLivePolicy(client, {
    DISCORD_GUILD_ID: "guild-1",
    DISCORD_REQUEST_CHANNEL_ID: "request-1",
    DISCORD_APPROVAL_CHANNEL_ID: "approval-1",
  } as NodeJS.ProcessEnv);

  expect(policy.requestChannelId).toBe("request-1");
  expect(policy.approvalChannelId).toBe("approval-1");
});
test("bot handlers allow approval commands for authorized approvers in the approval channel", async () => {
  const registry = new ApprovalRegistry();
  const received: ControlEvent[] = [];
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
    author: { bot: false, tag: "alice#0001" },
    guildId: "guild-1",
    channelId: "approval-chan",
    member: { roles: { cache: new Set(["approver-role"]) }, permissions: { has: () => false } },
    reply: async () => {},
  });

  expect(received).toEqual([
    {
      type: "approve",
      workflowId: "wf-1",
      action: "pr.merge",
      user: "alice#0001",
    },
  ]);
});

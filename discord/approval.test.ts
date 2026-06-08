import { test, expect } from "bun:test";
import { ApprovalRegistry, guardHighRisk } from "./approval.ts";
import { createWorkflow, applyEvent } from "../glue/state-machine.ts";
import type { WorkflowState, ControlEvent } from "../glue/contract.ts";
import { buildHandlers } from "./bot.ts";

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
        if (name === "value") return "openai";
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
  expect(buttonReplyContent.content).toContain("action pr.merge has been approved");
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
  expect(updatedWf!.actionApprovals?.["pr.create"]?.status).toBe("approved");

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

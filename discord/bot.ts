import { createHash, timingSafeEqual } from "node:crypto";
import { HIGH_RISK_ACTIONS, RUNTIMES, STAGES } from "../glue/contract.ts";

import { ChannelType, Client, GatewayIntentBits, PermissionFlagsBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { ORCHESTRATOR_STATUS_PORT, type ControlEvent, type WorkflowState, type HighRiskAction, type Runtime, type StatusNotification } from "../glue/contract.ts";
import { parseRepoRef } from "./commands.ts";
import { discordProxyRequest } from "./proxy-transport.ts";

export interface CommandPolicy {
  guildId?: string;
  requestChannelId?: string;
  approvalChannelId?: string;
  approverRoleId?: string;
  controlEndpoint?: string;
  controlEventSecret?: string;
}

interface EventContext {
  guildId?: string;
  channelId?: string;
  member?: any;
}
type ApprovalControlEvent = Extract<ControlEvent, { type: "approve" | "reject" }>;
type MessageEvent =
  | ControlEvent
  | { type: "unknown" };


function actionFromInteraction(interaction: any): HighRiskAction | undefined {
  const action = interaction.options?.getString?.("action") || interaction.options?.getString?.("approval_action") || "";
  return action === "pr.create" || action === "pr.merge" ? action : undefined;
}

function requestEventFromInteraction(interaction: any): ControlEvent | undefined {
  const runtime = interaction.options?.getString?.("runtime")?.trim();
  const requestText = interaction.options?.getString?.("request")?.trim();
  const scheduledAt = interaction.options?.getString?.("at")?.trim() || undefined;
  if ((runtime !== "zeroclaw" && runtime !== "nullclaw") || !requestText) return undefined;

  const parsed = parseRepoRef(requestText);
  const repo = parsed ? `${parsed.owner}/${parsed.repo}` : process.env.TARGET_REPO;
  return {
    type: "request",
    source: "discord",
    runtime: runtime as Runtime,
    request: requestText,
    repo,
    flow: scheduledAt ? "scheduled" : "direct",
    scheduledAt,
  };
}

function isHeadSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function approvalEventFromInteraction(
  commandName: "approve" | "reject",
  interaction: any,
  user: string,
): ApprovalControlEvent | undefined {
  const workflowId = interaction.options?.getString?.("workflowid")?.trim();
  const action = actionFromInteraction(interaction);
  if (!workflowId || !action) return undefined;
  if (commandName === "approve" && action === "pr.merge") {
    const headSha = interaction.options?.getString?.("headsha")?.trim();
    if (!isHeadSha(headSha)) return undefined;
    return { type: "approve", source: "discord", workflowId, action, user, headSha };
  }
  return { type: commandName, source: "discord", workflowId, action, user };
}

function approvalEventFromButton(customId: string, user: string): ApprovalControlEvent | undefined {
  const [verb, workflowId, actionRaw, headSha, ...extra] = customId.split(":");
  if (verb !== "approve" && verb !== "reject") return undefined;
  const action = actionRaw === "pr.create" || actionRaw === "pr.merge" ? actionRaw : undefined;
  if (!workflowId || !action) return undefined;
  if (extra.length) return undefined;
  if (verb === "approve" && action === "pr.merge") {
    if (!isHeadSha(headSha)) return undefined;
    return { type: "approve", source: "discord", workflowId, action, user, headSha };
  }
  if (headSha !== undefined) return undefined;
  return { type: verb, source: "discord", workflowId, action, user };
}

/**
 * Extracts direct-flow or scheduled workflow metadata from mention text.
 * Supports format: @bot <github repo url> [PROMPT] --flow <direct|scheduled> --at <ISO_TIMESTAMP>
 */
function parseFlowFlags(commandText: string): { flow?: "direct" | "scheduled"; scheduledAt?: string; cleanCommand: string } {
  let cleanCommand = commandText;
  const atMatch = cleanCommand.match(/--at\s+([^\s"]+|"[^"]+")/i);
  const scheduledAt = atMatch?.[1]?.replace(/"/g, "");
  if (atMatch) cleanCommand = cleanCommand.replace(atMatch[0], "").trim();

  const flowMatch = cleanCommand.match(/--flow\s+(direct|scheduled)\b/i);
  let flow = flowMatch?.[1] as "direct" | "scheduled" | undefined;
  if (flowMatch) cleanCommand = cleanCommand.replace(flowMatch[0], "").trim();

  cleanCommand = cleanCommand.replace("--force", "").trim();

  if (!flow) flow = scheduledAt ? "scheduled" : "direct";

  return { flow, scheduledAt, cleanCommand };
}

function requireTrimmed(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is missing or empty`);
  }
  return trimmed;
}

const DEFAULT_CONTROL_EVENT_TIMEOUT_MS = 15_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function deferInteraction(interaction: any, ephemeral: boolean): Promise<boolean> {
  if (typeof interaction.isButton === "function" && interaction.isButton()) {
    if (typeof interaction.update === "function") {
      try {
        await interaction.update({ components: [] });
        return true;
      } catch (err) {
        console.error("Failed to update button interaction:", err);
      }
    }
  }
  if (typeof interaction.deferReply === "function") {
    try {
      await interaction.deferReply({ ephemeral });
      return true;
    } catch (err) {
      console.error("Failed to defer interaction:", err);
    }
  }
  return false;
}

async function replyInteraction(interaction: any, payload: any, deferred: boolean): Promise<void> {
  if (typeof interaction.isButton === "function" && interaction.isButton()) {
    if (typeof interaction.followUp === "function") {
      try {
        await interaction.followUp({ ...payload, ephemeral: false });
        return;
      } catch (err) {
        console.error("Failed to followUp button interaction:", err);
      }
    }
  }
  const target = deferred && typeof interaction.editReply === "function" ? interaction.editReply.bind(interaction) : interaction.reply?.bind(interaction);
  if (typeof target !== "function") return;
  try {
    await target(payload);
  } catch (err) {
    console.error("Failed to reply to interaction:", err);
  }
}

export function discordCommandDefinitions(): unknown[] {
  return [
    new SlashCommandBuilder()
      .setName("request")
      .setDescription("Start a jeo-claw workflow")
      .addStringOption((option) =>
        option
          .setName("runtime")
          .setDescription("Runtime to execute")
          .setRequired(true)
          .addChoices(
            { name: "zeroclaw", value: "zeroclaw" },
            { name: "nullclaw", value: "nullclaw" }
          ),
      )
      .addStringOption((option) => option.setName("request").setDescription("Work request").setRequired(true))
      .addStringOption((option) =>
        option
          .setName("at")
          .setDescription("Schedule time (ISO 8601, e.g. 2026-06-12T10:00:00Z)")
          .setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("approve")
      .setDescription("Approve one high-risk workflow action")
      .addStringOption((option) => option.setName("workflowid").setDescription("Workflow id").setRequired(true))
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("High-risk action")
          .setRequired(true)
          .addChoices({ name: "pr.create", value: "pr.create" }, { name: "pr.merge", value: "pr.merge" }),
      )
      .addStringOption((option) => option.setName("headsha").setDescription("Full reviewed PR head SHA (required for merge)").setRequired(false))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("reject")
      .setDescription("Reject one high-risk workflow action")
      .addStringOption((option) => option.setName("workflowid").setDescription("Workflow id").setRequired(true))
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("High-risk action")
          .setRequired(true)
          .addChoices({ name: "pr.create", value: "pr.create" }, { name: "pr.merge", value: "pr.merge" }),
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Check the status of current workflows")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Ping the bot")
      .toJSON(),
  ];
}


async function registerGuildCommands(token: string, guildId: string, applicationId: string | undefined, proxy?: string): Promise<void> {
  const appId = applicationId?.trim();
  if (!appId) throw new Error("Discord application id is unavailable after login");
  const appIdSafe = appId;
  const rest = new REST({ version: "10", ...(proxy ? { makeRequest: discordProxyRequest(proxy) } : {}) }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(appIdSafe, guildId), { body: discordCommandDefinitions() });
}


function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function selectGuildId(client: any, preferredGuildId: string | undefined): Promise<string> {
  const direct = optionalTrimmed(preferredGuildId);
  if (direct) return direct;

  const cachedGuilds = [...(client.guilds?.cache?.values?.() ?? [])];
  const fetchedGuilds = cachedGuilds.length > 0 ? cachedGuilds : [...((await client.guilds?.fetch?.())?.values?.() ?? [])];
  if (fetchedGuilds.length === 1) {
    return fetchedGuilds[0]?.id;
  }

  throw new Error("DISCORD_GUILD_ID is required when the bot is connected to multiple guilds");
}

async function ensureTextChannel(guild: any, channelId: string | undefined, preferredName: string): Promise<string> {
  const directId = optionalTrimmed(channelId);
  if (directId) {
    const direct = await guild.channels.fetch(directId);
    if (!direct || direct.type !== ChannelType.GuildText) {
      throw new Error(`Configured channel ${directId} is missing or not a text channel`);
    }
    return direct.id;
  }

  const fetched = await guild.channels.fetch();
  const existing = [...fetched.values()].find((channel: any) => channel && channel.type === ChannelType.GuildText && channel.name === preferredName);
  if (existing) return existing.id;

  try {
    const created = await guild.channels.create({
      name: preferredName,
      type: ChannelType.GuildText,
      reason: "jeo-claw bootstrap channel provisioning",
    });
    return created.id;
  } catch (err) {
    throw new Error(`Unable to provision Discord text channel '${preferredName}': ${errorMessage(err)}`);
  }
}

export async function resolveLivePolicy(client: any, env: NodeJS.ProcessEnv = process.env): Promise<CommandPolicy> {
  const basePolicy = policyFromEnv(env);
  if (env.JEO_CONTROL_MODE === "probe-only") {
    const guildId = requireTrimmed("DISCORD_GUILD_ID", basePolicy.guildId);
    const channelId = requireTrimmed("DISCORD_REQUEST_CHANNEL_ID", basePolicy.requestChannelId);
    if (!/^\d{1,20}$/.test(guildId) || !/^\d{1,20}$/.test(channelId)) throw new Error("Probe mode requires numeric guild and request channel IDs");
    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error("Configured request channel is missing or not a text channel");
    return { ...basePolicy, guildId, requestChannelId: channelId };
  }
  const guildId = await selectGuildId(client, basePolicy.guildId);
  const guild = await client.guilds.fetch(guildId);
  const requestChannelId = await ensureTextChannel(guild, basePolicy.requestChannelId, optionalTrimmed(env.DISCORD_REQUEST_CHANNEL_NAME) ?? "jeo-request");
  const approvalChannelId = await ensureTextChannel(guild, basePolicy.approvalChannelId, optionalTrimmed(env.DISCORD_APPROVAL_CHANNEL_NAME) ?? "jeo-approval");
  return {
    ...basePolicy,
    guildId,
    requestChannelId,
    approvalChannelId,
  };
}
export function policyFromEnv(env: NodeJS.ProcessEnv): CommandPolicy {
  return {
    guildId: env.DISCORD_GUILD_ID?.trim(),
    requestChannelId: env.DISCORD_REQUEST_CHANNEL_ID?.trim(),
    approvalChannelId: env.DISCORD_APPROVAL_CHANNEL_ID?.trim(),
    approverRoleId: env.DISCORD_APPROVER_ROLE_ID?.trim(),
    controlEndpoint: env.GLUE_EVENT_ENDPOINT?.trim(),
    controlEventSecret: env.JEO_CONTROL_EVENT_SECRET?.trim(),
  };
}

function requiredChannel(event: ControlEvent, policy: CommandPolicy): string | undefined {
  if (event.type === "request") return policy.requestChannelId;
  if (event.type === "approve" || event.type === "reject") return policy.approvalChannelId;
  return undefined;
}

function hasApproverPermission(member: any, approverRoleId?: string): boolean {
  const permissions = member?.permissions;
  if (typeof permissions?.has === "function") {
    if (permissions.has(PermissionFlagsBits.Administrator) || permissions.has(PermissionFlagsBits.ManageGuild)) {
      return true;
    }
    if (permissions.has("Administrator") || permissions.has("ManageGuild")) {
      return true;
    }
  }

  if (!approverRoleId) return false;
  const roleCache = member?.roles?.cache;
  if (typeof roleCache?.has === "function") {
    return roleCache.has(approverRoleId);
  }
  if (Array.isArray(roleCache)) {
    return roleCache.includes(approverRoleId);
  }
  if (Array.isArray(member?.roles)) {
    return member.roles.includes(approverRoleId);
  }
  return false;
}

export function authorizeEvent(event: ControlEvent, context: EventContext, policy?: CommandPolicy): { ok: boolean; reason?: string } {
  if (!policy) return { ok: true };

  if (policy.guildId && context.guildId !== policy.guildId) {
    return { ok: false, reason: "Command rejected: wrong guild." };
  }

  const required = requiredChannel(event, policy);
  if (required && context.channelId !== required) {
    return { ok: false, reason: "Command rejected: wrong channel." };
  }

  if (event.type === "approve" || event.type === "reject") {
    if (!hasApproverPermission(context.member, policy.approverRoleId)) {
      return { ok: false, reason: "Command rejected: approver permission required." };
    }
  }

  return { ok: true };
}

function controlEventLogSummary(event: ControlEvent): Record<string, string> {
  if (event.type === "request") return { type: event.type, runtime: event.runtime };
  if (event.type === "approve" || event.type === "reject") return { type: event.type, workflowId: event.workflowId, action: event.action, user: event.user };
  if (event.type === "config-set") return { type: event.type, key: event.key, value: event.value };
  if (event.type === "ping") return { type: event.type };
  return { type: (event as any).type };
}

export async function forwardControlEvent(
  endpoint: string,
  secret: string,
  event: ControlEvent,
  timeoutMs = DEFAULT_CONTROL_EVENT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/control-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-control-event-secret": secret,
      },
      body: JSON.stringify(event),
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });
    if (!res.ok) {
      throw new Error(`control event delivery failed (${res.status})`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    return contentType.includes("application/json") ? await res.json() : await res.text();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError" && controller.signal.aborted && !signal?.aborted) {
      throw new Error(`control event delivery timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Builds the message and interaction handlers.
 */
export function buildHandlers(deps: {
  onEvent?: (e: ControlEvent) => unknown | Promise<unknown>;
  policy?: CommandPolicy;
  botUserId?: string;
  allowSelfTest?: boolean;
  fetchStatus?: () => Promise<WorkflowState[]>;
  signal?: AbortSignal;
  mode?: "normal" | "probe-only";
}) {
  const processEvent = async (
    event: ControlEvent,
    context: EventContext,
    replyError: (reason: string) => Promise<void>
  ): Promise<{ ok: boolean; response?: unknown }> => {
    if (deps.mode === "probe-only" && event.type !== "ping") {
      await replyError("Ordinary workflow commands are disabled in probe-only mode.");
      return { ok: false };
    }
    const auth = authorizeEvent(event, context, deps.policy);
    if (!auth.ok) {
      await replyError(auth.reason || "Unauthorized command");
      return { ok: false };
    }

    if (deps.onEvent) {
      const response = await deps.onEvent(event);
      return { ok: true, response };
    }
    return { ok: true };
  };

  const replyToMessage = async (message: any, content: any): Promise<void> => {
    if (typeof message.reply === "function") {
      try {
        let cleanContent = String(content || "");
        if (cleanContent.startsWith("[selftest]")) {
          cleanContent = cleanContent.slice("[selftest]".length).trim();
        }
        await message.reply(cleanContent);
      } catch (err) {
        console.error("Failed to reply to message:", err);
      }
    }
  };

  const stripBotMention = (content: string): { mentioned: boolean; commandText: string } => {
    const id = deps.botUserId?.trim();
    const isMentioned = (id && (content.includes(`<@${id}>`) || content.includes(`<@!${id}>`))) || /<@&\d+>/.test(content);
    
    let commandText = content.replace(/<@[!&]?\d+>/g, "").replace(/<#\d+>/g, "").trim();
    return { mentioned: isMentioned, commandText };
  };

  const eventFromMessage = (
    rawContent: string,
    forceMention = false,
  ): {
    event: MessageEvent;
    mentioned: boolean;
  } => {
    const mention = stripBotMention(rawContent);
    const mentioned = mention.mentioned || forceMention;
    if (!mentioned) return { event: { type: "unknown" }, mentioned: false };

    const commandText = mention.commandText.length > 0 ? mention.commandText : rawContent.trim();
    const normalized = commandText.trim().toLowerCase();

    if (normalized === "ping" || normalized === "/ping") {
      return { event: { type: "ping" }, mentioned };
    }

    const { flow, scheduledAt, cleanCommand } = parseFlowFlags(commandText.trim());
    const parsed = parseRepoRef(cleanCommand);
    if (!parsed || !parsed.repo) return { event: { type: "unknown" }, mentioned };

    return {
      event: {
        type: "request",
        source: "discord",
        runtime: "zeroclaw",
        request: parsed.rest || "프로젝트 작업내역 분석 및 코드 개선",
        repo: `${parsed.owner}/${parsed.repo}`,
        baseBranch: undefined,
        flow,
        scheduledAt,
      },
      mentioned,
    };
  };

  const workflowSummary = (response: unknown, event: ControlEvent): string => {
    if (event.type === "approve" || event.type === "reject") {
      return "";
    }
    if (event.type === "ping") {
      return "pong";
    }
    if (response && typeof response === "object" && "workflow" in response) {
      const wf = (response as any).workflow;
      const stageKorean: Record<string, string> = {
        "research-code": "코딩 (Researcher/Coder)",
        "review": "검토 (Reviewer)",
        "pr-create": "PR 생성 (PR Creator)",
        "pr-review-schedule": "CI/리뷰 (PR Scheduler)",
        "merge": "머지 (Merger)",
        "orchestrator": "오케스트레이션 (Sovereign)",
        "orchestration": "오케스트레이션 (Sovereign)",
        "finalize": "마무리"
      };
      const currentStageName = stageKorean[wf.stage] || wf.stage;
      if (wf.repo) {
        const repoLink = wf.repo.startsWith("http") ? wf.repo : `https://github.com/${wf.repo}`;
        return `✅ **워크플로우 ${wf.id} 생성 (${repoLink})**
🏰 **제어 타워 (JOC/Sovereign Orchestrator)**: Sovereign이 제어를 시작합니다.
🤖 **협업 구성**: @제로가재 @NullClaw-Bot @ResearcherClaw @ReviewerClaw @ReviewClaw @CoordinatorClaw 협업을 준비하세요.
⚡ **Execution Mode**: Direct Evolution Flow
📡 **Live Ping**: #SovereignEvolution #JOC_Tower`;
      }
      return `✅ **Workflow ${wf.id} created: runtime=${wf.runtime}, stage=${currentStageName}, status=${wf.status}${wf.pendingAction ? `, pending=${wf.pendingAction}` : ""}**
🏰 **제어 타워 (JOC/Sovereign Orchestrator)**: Sovereign이 제어를 시작합니다.
🤖 **협업 구성**: @제로가재 @NullClaw-Bot @ResearcherClaw @ReviewerClaw @ReviewClaw @CoordinatorClaw 협업을 준비하세요.
⚡ **Execution Mode**: Direct Evolution Flow
📡 **Live Ping**: #SovereignEvolution #JOC_Tower`;
    }
    return "";
  };

  const executeInteractionEvent = async (
    interaction: any,
    event: ControlEvent,
    context: EventContext,
    opts: { ephemeralDefer: boolean; ephemeralReply: boolean; fallbackSummary: string },
  ): Promise<void> => {
    const deferred = await deferInteraction(interaction, opts.ephemeralDefer);
    const replyError = async (reason: string) => {
      await replyInteraction(interaction, {
        content: reason,
        ephemeral: true,
      }, deferred);
    };
    let result: { ok: boolean; response?: unknown } = { ok: false };
    try {
      result = await processEvent(event, context, replyError);
    } catch (err) {
      await replyError(`Command failed: ${errorMessage(err)}`);
      return;
    }
    if (result.ok) {
      await replyInteraction(interaction, {
        content: workflowSummary(result.response, event) || opts.fallbackSummary,
        ephemeral: opts.ephemeralReply,
      }, deferred);
    }
  };

  const usageGuide = () =>
    [
      "**jeo-claw Discord 도움말**",
      "- @봇 <github repo url> [요청]: 새로운 워크플로우 시작",
      "- @봇 <github repo url> [요청] --flow scheduled --at <YYYY-MM-DDTHH:mm:ssZ>: 워크플로우 예약",
      "- /request runtime:<zeroclaw|nullclaw> request:<요청> [at:ISO_TIME]: 워크플로우 시작 또는 예약",
      "- /status: 현재 진행 중인 워크플로우 상태 확인",
      "- /approve workflowid:<wfId> action:<action>: 고위험 작업 승인 (pr.create, pr.merge)",
      "- /reject workflowid:<wfId> action:<action>: 고위험 작업 거절",
      "- /help: 이 도움말 표시",
    ].join("\n");


  return {
    handleMessage: async (message: any) => {
      const allowSelfTest = deps.allowSelfTest ?? (process.env.JEO_ALLOW_SELF_TEST === "1");
      const isSelfTest = allowSelfTest && String(message.content ?? "").startsWith("[selftest]");
      if (message.author?.bot && !isSelfTest) return;

      let rawContent = String(message.content ?? "");
      if (isSelfTest && rawContent.startsWith("[selftest]")) {
        rawContent = rawContent.slice("[selftest]".length);
      }
      const { event, mentioned } = eventFromMessage(rawContent, isSelfTest);

      const context: EventContext = {
        guildId: message.guildId || message.guild?.id,
        channelId: message.channelId || message.channel?.id,
        member: message.member,
      };
      const replyError = async (reason: string) => replyToMessage(message, reason);

      if (event.type !== "unknown") {
        let result: { ok: boolean; response?: unknown } = { ok: false };
        try {
          result = await processEvent(event, context, replyError);
        } catch (err) {
          await replyError(`Command failed: ${errorMessage(err)}`);
          return;
        }
        if (result.ok) {
          const summary = workflowSummary(result.response, event) || `Processed command: ${event.type}`;
          await replyToMessage(message, summary);
        }
      } else if (mentioned) {
        await replyToMessage(message, usageGuide());
      }
    },

    handleInteraction: async (interaction: any) => {
      const user = interaction.user?.tag || interaction.user?.username || "unknown";
      const context: EventContext = {
        guildId: interaction.guildId || interaction.guild?.id,
        channelId: interaction.channelId || interaction.channel?.id,
        member: interaction.member,
      };

      if (interaction.isChatInputCommand?.()) {
        const commandName = interaction.commandName;
        if (commandName === "status") {
          if (deps.fetchStatus) {
            const deferred = await deferInteraction(interaction, true);
            try {
              const list = await deps.fetchStatus();
              if (deps.signal?.aborted) return;
                      const lines = list.slice(-10).map((wf) => {
                const repoStr = wf.repo ? `[${wf.repo}]` : "[-]";
                const stageKorean: Record<string, string> = {
                  "research-code": "코딩 (Researcher/Coder)",
                  "review": "검토 (Reviewer)",
                  "pr-create": "PR 생성 (PR Creator)",
                  "pr-review-schedule": "CI/리뷰 (PR Scheduler)",
                  "merge": "머지 (Merger)",
                  "orchestrator": "오케스트레이션 (Sovereign)",
                  "orchestration": "오케스트레이션 (Sovereign)",
                  "finalize": "마무리"
                };
                const stageStr = stageKorean[wf.stage] || wf.stage;
                const statusStr = wf.status === "scheduled" ? `예약(${wf.scheduledAt?.slice(5, 16).replace("T", " ")})` : wf.status;
                const actionStr = wf.pendingAction ? ` | **${wf.pendingAction} 대기**` : "";
                const flowStr = wf.flow === "direct" ? " ⚡" : (wf.flow === "scheduled" ? " 📅" : "");
                const emoji = wf.status === "failed" ? "❌" : (wf.status === "running" || wf.status === "pending" ? "⚙️" : (wf.status === "merged" ? "✅" : "•"));
                const runtimeStr = wf.runtime === "zeroclaw" ? " (🦀)" : (wf.runtime === "nullclaw" ? " (⚡)" : "");
                return `${emoji} **${wf.id}**${runtimeStr} ${repoStr} | ${stageStr} → ${statusStr}${actionStr}${flowStr}`;
              }).join("\n");
              const reply = lines.length > 0 ? `🏰 **[Sovereign 제어 타워: 현재 상태 (최근 10건)]**\n${lines}` : "진행 중인 워크플로우가 없습니다.";
              await replyInteraction(interaction, { content: reply, ephemeral: false }, deferred);
            } catch (err) {
              if (deps.signal?.aborted) return;
              await replyInteraction(interaction, { content: `Failed to fetch status: ${errorMessage(err)}`, ephemeral: true }, deferred);
            }
          } else {
            await interaction.reply({ content: "Status check not configured.", ephemeral: true });
          }
          return;
        }
        const event = commandName === "request"
          ? requestEventFromInteraction(interaction)
          : (commandName === "approve" || commandName === "reject")
            ? approvalEventFromInteraction(commandName, interaction, user)
            : (commandName === "ping")
              ? { type: "ping" as const }
              : undefined;

        if (event) {
          await executeInteractionEvent(interaction, event, context, {
            ephemeralDefer: true,
            ephemeralReply: true,
            fallbackSummary: `Processed command: ${event.type}`,
          });
        } else {
          await replyInteraction(interaction, {
            content: commandName === "approve" ? "Approval requires a valid workflow, action, and full lowercase head SHA for merge." : "Unknown command.",
            ephemeral: true,
          }, false);
        }
      } else if (interaction.isButton?.()) {
        const customId = interaction.customId || "";
        const event = approvalEventFromButton(customId, user);
        if (event) {
          await executeInteractionEvent(interaction, event, context, {
            ephemeralDefer: true,
            ephemeralReply: false,
            fallbackSummary: `Workflow ${event.workflowId} action ${event.action} has been ${event.type}d by ${user}.`,
          });
        }
      }
    },
  };
}
const MAX_STATUS_BODY_BYTES = 64 * 1024;

async function readStatusBody(req: Request): Promise<string | undefined> {
  const length = req.headers.get("content-length");
  if (length && Number(length) > MAX_STATUS_BODY_BYTES) {
    void req.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      size += value.byteLength;
      if (size > MAX_STATUS_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function validStatusNotification(value: unknown): value is StatusNotification & { claw?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const optionalString = (key: string) => item[key] === undefined || typeof item[key] === "string";
  return typeof item.workflowId === "string" && item.workflowId.length > 0 &&
    typeof item.stage === "string" && (STAGES as readonly string[]).includes(item.stage) &&
    typeof item.status === "string" && ["queued", "pending", "running", "awaiting-approval", "merged", "rejected", "failed", "scheduled"].includes(item.status) &&
    typeof item.message === "string" && optionalString("repo") && optionalString("claw") && optionalString("headSha") &&
    (item.runtime === undefined || (typeof item.runtime === "string" && (RUNTIMES as readonly string[]).includes(item.runtime))) &&
    (item.pendingAction === undefined || (typeof item.pendingAction === "string" && (HIGH_RISK_ACTIONS as readonly string[]).includes(item.pendingAction)));
}

export function buildStatusRelayHandler(deps: {
  statusRelaySecret?: string;
  mode?: "normal" | "probe-only";
  sendToChannel: (workflowId: string | undefined, content: string, components?: unknown[]) => Promise<void>;
}) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const url = new URL(req.url);
    if (url.pathname !== "/status") {
      return new Response("Not Found", { status: 404 });
    }
    const supplied = req.headers.get("x-status-relay-secret") ?? "";
    const expected = deps.statusRelaySecret ?? "";
    const suppliedHash = createHash("sha256").update(supplied).digest();
    const expectedHash = createHash("sha256").update(expected).digest();
    if (!supplied || !expected || !timingSafeEqual(suppliedHash, expectedHash)) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (deps.mode === "probe-only") return new Response("Ordinary notifications disabled", { status: 409 });
    try {
      const body = await readStatusBody(req);
      if (body === undefined) return new Response("Payload Too Large", { status: 413 });
      const notification: unknown = JSON.parse(body);
      if (!validStatusNotification(notification)) return new Response("Bad Request", { status: 400 });

      const claw = notification.claw ?? "🏰 Sovereign (Orchestrator)";
      const repoStr = notification.repo ? `[${notification.repo}]` : "[-]";
      const stageKorean: Record<string, string> = {
        "research-code": "코딩 (Researcher/Coder)",
        "review": "검토 (Reviewer)",
        "pr-create": "PR 생성 (PR Creator)",
        "pr-review-schedule": "CI/리뷰 (PR Scheduler)",
        "merge": "머지 (Merger)",
        "orchestrator": "오케스트레이션 (Sovereign)",
        "orchestration": "오케스트레이션 (Sovereign)",
      };
      const stageStr = stageKorean[notification.stage] || notification.stage;
      const getStatusColor = (s: string) => {
        if (s === "failed") return "🔴";
        if (s === "merged" || s === "completed") return "🟢";
        if (s === "awaiting-approval") return "🟡";
        if (s === "running") return "🔵";
        return "⚪";
      };
      const statusColor = getStatusColor(notification.status);

      const mergeApproval = notification.status === "awaiting-approval" && notification.pendingAction === "pr.merge";
      const headSha = isHeadSha(notification.headSha) ? notification.headSha : undefined;
      const content = `> ${statusColor} **Sovereign Evolution Control Tower**
> 
> 🔹 **Workflow:** \`${notification.workflowId}\`${mergeApproval ? `\n> 🔐 **Reviewed head SHA:** ${headSha ? `\`${headSha}\`` : "unavailable; merge approval disabled"}` : ""}
> 📦 **Target:** ${repoStr}
> 📍 **Stage:** **${stageStr}**
> 🚥 **Status:** \`${notification.status.toUpperCase()}\`
> 🤖 **Claw:** ${claw} @CoordinatorClaw
> 
> 💬 **Log:** ${notification.message}`;

      let components: any[] | undefined = undefined;

      if (notification.status === "awaiting-approval" && notification.pendingAction && !notification.workflowId.includes(":")) {
        const approveId = `approve:${notification.workflowId}:${notification.pendingAction}${mergeApproval && headSha ? `:${headSha}` : ""}`;
        const rejectId = `reject:${notification.workflowId}:${notification.pendingAction}`;
        const buttons = [];
        if ((!mergeApproval || headSha) && approveId.length <= 100) {
          buttons.push({ type: 2, style: 3, label: "승인", custom_id: approveId });
        }
        if (rejectId.length <= 100) {
          buttons.push({ type: 2, style: 4, label: "거부", custom_id: rejectId });
        }
        if (buttons.length) components = [{ type: 1, components: buttons }];
      }

      await deps.sendToChannel(notification.workflowId, content, components);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid status request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
}

export function startStatusRelay(
  port: number,
  handler: (req: Request) => Promise<Response> | Response
) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      return handler(req);
    },
  });
}

/**
 * Starts the Discord bot client.
 * Constructs client and logs in using Secret-Manager-loaded env.
 */
export async function start(deps: {
  createClient?: () => Client;
  resolvePolicy?: typeof resolveLivePolicy;
  registerCommands?: typeof registerGuildCommands;
  relayPort?: number;
  proxy?: string;
} = {}): Promise<Client> {
  const mode = process.env.JEO_CONTROL_MODE ?? "normal";
  if (mode !== "normal" && mode !== "probe-only") throw new Error("Invalid JEO_CONTROL_MODE");
  const client = deps.createClient?.() ?? new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    ...(deps.proxy ? { rest: { makeRequest: discordProxyRequest(deps.proxy) } } : {}),
  });

  let relay: { readonly port: number | undefined; stop(closeActiveConnections?: boolean): void } | undefined;
  const lifecycle = new AbortController();
  const detachListeners: Array<() => void> = [];
  const destroyClient = client.destroy.bind(client);
  let shutdown: Promise<void> | undefined;
  client.destroy = () => {
    if (!shutdown) {
      shutdown = (async () => {
        lifecycle.abort();
        for (const detach of detachListeners) detach();
        try {
          relay?.stop(true);
        } finally {
          await destroyClient();
        }
      })();
    }
    return shutdown;
  };

  try {
  const token = requireTrimmed("DISCORD_BOT_TOKEN", process.env.DISCORD_BOT_TOKEN);
  const onReady = () => {
    console.log(`[Discord Bot] Ready. Logged in as ${client.user?.tag}`);
  };
  client.on("ready", onReady);
  detachListeners.push(() => client.off("ready", onReady));

  await client.login(token);

  const policy = await (deps.resolvePolicy ?? resolveLivePolicy)(client, process.env);
  console.log("[Discord Bot] Policy:", JSON.stringify({
    guildId: policy.guildId,
    requestChannelId: policy.requestChannelId,
    approvalChannelId: policy.approvalChannelId,
    approverRoleId: policy.approverRoleId,
  }));
  const guildId = requireTrimmed("DISCORD_GUILD_ID", policy.guildId);
  const glueEndpoint = requireTrimmed("GLUE_EVENT_ENDPOINT", policy.controlEndpoint);
  const controlEventSecret = requireTrimmed("JEO_CONTROL_EVENT_SECRET", policy.controlEventSecret);
  const statusRelaySecret = requireTrimmed("JEO_STATUS_RELAY_SECRET", process.env.JEO_STATUS_RELAY_SECRET);
  if (statusRelaySecret.length < 24 || statusRelaySecret === controlEventSecret || statusRelaySecret === token) throw new Error("JEO_STATUS_RELAY_SECRET must be at least 24 characters and distinct from other control secrets");

  const workflowMessageMap = new Map<string, string>();
  const MAX_MESSAGE_MAP_SIZE = 1000;
  const sendToChannel = async (workflowId: string | undefined, content: string, components?: any[]) => {
    if (content.length > 1950) {
      content = content.substring(0, 1950) + "... (truncated)";
    }

    try {
      const channels = new Set([policy.requestChannelId, ...(components?.length ? [policy.approvalChannelId] : [])]);
      if (workflowId && policy.approvalChannelId && workflowMessageMap.has(`${policy.approvalChannelId}:${workflowId}`)) channels.add(policy.approvalChannelId);
      for (const channelId of channels) {
      if (!channelId) continue;
      const messageKey = workflowId ? `${channelId}:${workflowId}` : undefined;
      const channelComponents = channelId === policy.approvalChannelId ? components : undefined;
      const channel = await client.channels.fetch(channelId);
      if (channel && "send" in channel) {
        const textChannel = channel as any;
        if (messageKey && workflowMessageMap.has(messageKey)) {
          const msgId = workflowMessageMap.get(messageKey)!;
          try {
            const msg = await textChannel.messages.fetch(msgId);
            if (msg) {
              await msg.edit({ content, components: channelComponents || [] });
              continue;
            }
          } catch(e) {
            // message might have been deleted, fallback to send
            workflowMessageMap.delete(messageKey);
          }
        }
        const sent = await textChannel.send({
          content,
          components: channelComponents || [],
        });
        if (messageKey) {
          workflowMessageMap.set(messageKey, sent.id);
          if (workflowMessageMap.size > MAX_MESSAGE_MAP_SIZE) {
            const firstKey = workflowMessageMap.keys().next().value;
            if (firstKey) workflowMessageMap.delete(firstKey);
          }
        }
      }
      }
    } catch {
      console.error("[Discord Bot] Failed to send relay message");
    }
  };

  const statusRelayHandler = buildStatusRelayHandler({ statusRelaySecret, sendToChannel, mode });
  relay = startStatusRelay(deps.relayPort ?? ORCHESTRATOR_STATUS_PORT, statusRelayHandler);
  console.log(`[Discord Bot] Status relay listening on 127.0.0.1:${relay.port}`);

  const handlers = buildHandlers({
    mode,
    policy,
    botUserId: client.user?.id,
    allowSelfTest: process.env.JEO_ALLOW_SELF_TEST === "1",
    signal: lifecycle.signal,
    fetchStatus: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_CONTROL_EVENT_TIMEOUT_MS);
      try {
        const res = await fetch(`${glueEndpoint}/debug/workflows`, {
          headers: { "x-control-event-secret": controlEventSecret },
          signal: AbortSignal.any([lifecycle.signal, controller.signal]),
        });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = (await res.json()) as { workflows: WorkflowState[] };
        return data.workflows || [];
      } finally {
        clearTimeout(timeout);
      }
    },
    onEvent: async (event) => {
      const response = await forwardControlEvent(glueEndpoint, controlEventSecret, event, DEFAULT_CONTROL_EVENT_TIMEOUT_MS, lifecycle.signal);
      console.log("[Discord Bot] ControlEvent:", controlEventLogSummary(event));
      return response;
    },
  });

  const onMessage = async (message: Parameters<typeof handlers.handleMessage>[0]) => {
    try {
      await handlers.handleMessage(message);
    } catch (err) {
      console.error("Error handling message:", err);
    }
  };
  client.on("messageCreate", onMessage);
  detachListeners.push(() => client.off("messageCreate", onMessage));

  const onInteraction = async (interaction: Parameters<typeof handlers.handleInteraction>[0]) => {
    try {
      await handlers.handleInteraction(interaction);
    } catch (err) {
      console.error("Error handling interaction:", err);
    }
  };
  client.on("interactionCreate", onInteraction);
  detachListeners.push(() => client.off("interactionCreate", onInteraction));

  if (mode === "normal") {
    await (deps.registerCommands ?? registerGuildCommands)(token, guildId, client.application?.id ?? client.user?.id, deps.proxy);
    console.log(`[Discord Bot] Registered guild slash commands for ${guildId}`);
  }
  return client;
  } catch (error) {
    try {
      await client.destroy();
    } catch (cleanupError) {
      console.error("[Discord Bot] Cleanup failed:", cleanupError);
    }
    throw error;
  }
}

if (import.meta.main) {
  throw new Error("Start Discord through discord/proxy-main.ts");
}

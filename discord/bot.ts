import { ChannelType, Client, GatewayIntentBits, PermissionFlagsBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { ORCHESTRATOR_STATUS_PORT, type ControlEvent, type WorkflowState, type HighRiskAction, type Runtime, type StatusNotification } from "../glue/contract.ts";
import { parseRepoRef } from "./commands.ts";

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
  const repo = parsed?.repo;
  return {
    type: "request",
    source: "discord",
    runtime: runtime as Runtime,
    request: repo ? (requestText.replace(repo, "").trim() || "프로젝트 작업내역 분석 및 코드 개선") : requestText,
    repo: repo,
    baseBranch: undefined,
    flow: scheduledAt ? "scheduled" : "direct",
    scheduledAt,
  };
}

function approvalEventFromInteraction(
  commandName: "approve" | "reject",
  interaction: any,
  user: string,
): ApprovalControlEvent | undefined {
  const workflowId = interaction.options?.getString?.("workflowid")?.trim();
  const action = actionFromInteraction(interaction);
  if (!workflowId || !action) return undefined;
  return { type: commandName, source: "discord", workflowId, action, user };
}

function approvalEventFromButton(customId: string, user: string): ApprovalControlEvent | undefined {
  const [verb, workflowId, actionRaw] = customId.split(":");
  if (verb !== "approve" && verb !== "reject") return undefined;
  const action = actionRaw === "pr.create" || actionRaw === "pr.merge" ? actionRaw : undefined;
  if (!workflowId || !action) return undefined;
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
  ];
}


async function registerGuildCommands(token: string, guildId: string, applicationId: string | undefined): Promise<void> {
  const appId = applicationId?.trim();
  if (!appId) throw new Error("Discord application id is unavailable after login");
  const appIdSafe = appId;
  const rest = new REST({ version: "10" }).setToken(token);
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
  return { type: event.type, workflowId: event.workflowId, action: event.action, user: event.user };
}

export async function forwardControlEvent(
  endpoint: string,
  secret: string,
  event: ControlEvent,
  timeoutMs = DEFAULT_CONTROL_EVENT_TIMEOUT_MS,
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
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`control event delivery failed (${res.status})`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    return contentType.includes("application/json") ? await res.json() : await res.text();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
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
}) {
  const processEvent = async (
    event: ControlEvent,
    context: EventContext,
    replyError: (reason: string) => Promise<void>
  ): Promise<{ ok: boolean; response?: unknown }> => {
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
            : undefined;

        if (event) {
          await executeInteractionEvent(interaction, event, context, {
            ephemeralDefer: true,
            ephemeralReply: true,
            fallbackSummary: `Processed command: ${event.type}`,
          });
        } else {
          await replyInteraction(interaction, {
            content: "Unknown command.",
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
export function buildStatusRelayHandler(deps: {
  client?: unknown;
  sendToChannel: (content: string, components?: unknown[]) => Promise<void>;
}) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const url = new URL(req.url);
    if (url.pathname !== "/status") {
      return new Response("Not Found", { status: 404 });
    }
    try {
      const notification = (await req.json()) as StatusNotification;
      if (!notification.workflowId || !notification.stage || !notification.status) {
        return new Response("Bad Request: Missing required fields", { status: 400 });
      }

      const claw = (notification as any).claw ?? "🏰 Sovereign (Orchestrator)";
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
      const getClawEmoji = (c: string) => {
        if (c.includes("zeroclaw") || c.includes("제로가재")) return "🦀";
        if (c.includes("nullclaw")) return "⚡";
        if (c.includes("Sovereign")) return "🏰";
        return "🤖";
      };
      const clawEmoji = getClawEmoji(claw);
      const content = `${clawEmoji} **[${claw}]** | ${notification.workflowId} ${repoStr}
📍 Stage: ${stageStr} → ${notification.status}
💬 ${notification.message}
🤖 **Collaborators**: @제로가재 @NullClaw-Bot @ResearcherClaw @ReviewerClaw @ReviewClaw @CoordinatorClaw 협업 대기 중
📡 **Live Ping**: #SovereignEvolution #JOC_Relay #SovereignControlTower`;

      let components: any[] | undefined = undefined;
      if (notification.status === "awaiting-approval" && notification.pendingAction) {
        components = [
          {
            type: 1, // ActionRow
            components: [
              {
                type: 2, // Button
                style: 3, // Success
                label: "승인",
                custom_id: `approve:${notification.workflowId}:${notification.pendingAction}`,
              },
              {
                type: 2, // Button
                style: 4, // Danger
                label: "거부",
                custom_id: `reject:${notification.workflowId}:${notification.pendingAction}`,
              },
            ],
          },
        ];
      }

      await deps.sendToChannel(content, components);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: String(err) }), {
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
    hostname: "0.0.0.0",
    fetch(req) {
      return handler(req);
    },
  });
}

/**
 * Starts the Discord bot client.
 * Constructs client and logs in using Secret-Manager-loaded env.
 */
export async function start(): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const token = requireTrimmed("DISCORD_BOT_TOKEN", process.env.DISCORD_BOT_TOKEN);

  client.on("ready", () => {
    console.log(`[Discord Bot] Ready. Logged in as ${client.user?.tag}`);
  });

  await client.login(token);

  const policy = await resolveLivePolicy(client, process.env);
  console.log("[Discord Bot] Policy:", JSON.stringify(policy));
  const guildId = requireTrimmed("DISCORD_GUILD_ID", policy.guildId);
  const glueEndpoint = requireTrimmed("GLUE_EVENT_ENDPOINT", policy.controlEndpoint);
  const controlEventSecret = requireTrimmed("JEO_CONTROL_EVENT_SECRET", policy.controlEventSecret);

  
  const sendToChannel = async (content: string, components?: any[]) => {
    if (content.length > 1950) {
      content = content.substring(0, 1950) + "... (truncated)";
    }

    try {
      const channelId = policy.requestChannelId;
      if (!channelId) return;
      const channel = await client.channels.fetch(channelId);
      if (channel && "send" in channel) {
        await (channel as any).send({
          content,
          components: components || [],
        });
      }
    } catch (err) {
      console.error("[Discord Bot] Failed to send relay message:", err);
    }
  };

  const statusRelayHandler = buildStatusRelayHandler({ client, sendToChannel });
  startStatusRelay(ORCHESTRATOR_STATUS_PORT, statusRelayHandler);
  console.log(`[Discord Bot] Status relay listening on 0.0.0.0:${ORCHESTRATOR_STATUS_PORT}`);

  const handlers = buildHandlers({
    policy,
    botUserId: client.user?.id,
    allowSelfTest: process.env.JEO_ALLOW_SELF_TEST === "1",
    fetchStatus: async () => {
      const res = await fetch(`${glueEndpoint}/debug/workflows`, {
        headers: { "x-control-event-secret": controlEventSecret },
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const data = (await res.json()) as { workflows: WorkflowState[] };
      return data.workflows || [];
    },
    onEvent: async (event) => {
      const response = await forwardControlEvent(glueEndpoint, controlEventSecret, event);
      console.log("[Discord Bot] ControlEvent:", controlEventLogSummary(event));
      return response;
    },
  });

  client.on("messageCreate", async (message) => {
    try {
      await handlers.handleMessage(message);
    } catch (err) {
      console.error("Error handling message:", err);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      await handlers.handleInteraction(interaction);
    } catch (err) {
      console.error("Error handling interaction:", err);
    }
  });

  await registerGuildCommands(token, guildId, client.application?.id ?? client.user?.id);
  console.log(`[Discord Bot] Registered guild slash commands for ${guildId}`);
  return client;
}

if (import.meta.main) {
  start().catch((err) => {
    console.error("[Discord Bot] Startup failed:", err);
    process.exit(1);
  });
}

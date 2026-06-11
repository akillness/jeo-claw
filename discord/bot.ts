import { ChannelType, Client, GatewayIntentBits, PermissionFlagsBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { RUNTIMES, type ControlEvent, type WorkflowState, type HighRiskAction } from "../glue/contract.ts";
import { parseCommand, validateConfigValue } from "./commands.ts";
import { ApprovalRegistry } from "./approval.ts";
import type { applyEvent, createWorkflow } from "../glue/state-machine.ts";

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

function actionFromInteraction(interaction: any): string {
  return interaction.options?.getString?.("action") || interaction.options?.getString?.("approval_action") || "";
}

function requireTrimmed(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is missing or empty`);
  }
  return trimmed;
}

const DEFAULT_CONTROL_EVENT_TIMEOUT_MS = 2_500;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function deferInteraction(interaction: any, ephemeral: boolean): Promise<boolean> {
  if (typeof interaction.deferReply !== "function") return false;
  try {
    await interaction.deferReply({ ephemeral });
    return true;
  } catch (err) {
    console.error("Failed to defer interaction:", err);
    return false;
  }
}

async function replyInteraction(interaction: any, payload: any, deferred: boolean): Promise<void> {
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
          .addChoices({ name: "zeroclaw", value: "zeroclaw" }, { name: "nullclaw", value: "nullclaw" }),
      )
      .addStringOption((option) => option.setName("request").setDescription("Work request").setRequired(true))
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
      .setName("config")
      .setDescription("Inspect or request safe configuration changes")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Request a config mutation; currently rejected by control plane")
          .addStringOption((option) =>
            option
              .setName("key")
              .setDescription("Config key")
              .setRequired(true)
              .addChoices(
                { name: "provider", value: "provider" },
                { name: "model", value: "model" },
                { name: "autonomy", value: "autonomy" },
                { name: "scaleout", value: "scaleout" },
              ),
          )
          .addStringOption((option) => option.setName("value").setDescription("Config value").setRequired(true)),
      )
      .toJSON(),
  ];
}

async function registerGuildCommands(token: string, guildId: string, applicationId: string | undefined): Promise<void> {
  const appId = applicationId?.trim();
  if (!appId) throw new Error("Discord application id is unavailable after login");
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: discordCommandDefinitions() });
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
  if (event.type === "approve" || event.type === "reject" || event.type === "config-set") return policy.approvalChannelId;
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

  if (event.type === "approve" || event.type === "reject" || event.type === "config-set") {
    if (!hasApproverPermission(context.member, policy.approverRoleId)) {
      return { ok: false, reason: "Command rejected: approver permission required." };
    }
  }

  return { ok: true };
}

function controlEventLogSummary(event: ControlEvent): Record<string, string> {
  if (event.type === "request") return { type: event.type, runtime: event.runtime };
  if (event.type === "approve" || event.type === "reject") {
    return { type: event.type, workflowId: event.workflowId, action: event.action, user: event.user };
  }
  return { type: event.type, key: event.key };
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
  registry: ApprovalRegistry;
  store?: Map<string, WorkflowState>;
  applyEvent?: typeof applyEvent;
  createWorkflow?: typeof createWorkflow;
  policy?: CommandPolicy;
  botUserId?: string;
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

    if (event.type === "config-set") {
      const validation = validateConfigValue(event.key, event.value);
      if (!validation.ok) {
        await replyError(validation.reason || "Invalid config value");
        return { ok: false };
      }
      await replyError("Command rejected: config-set is not implemented in the control plane.");
      return { ok: false };
    }

    if (event.type === "request") {
      if (deps.createWorkflow && deps.store) {
        const wfId = `wf-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const wf = deps.createWorkflow(wfId, event.runtime, event.request);
        deps.store.set(wfId, wf);
      }
    } else if (event.type === "approve") {
      deps.registry.approve(event.workflowId, event.action, event.user);
      if (deps.store && deps.applyEvent) {
        const wf = deps.store.get(event.workflowId);
        if (wf) {
          const updated = deps.applyEvent(wf, { type: "approve", action: event.action, user: event.user });
          deps.store.set(event.workflowId, updated);
        }
      }
    } else if (event.type === "reject") {
      deps.registry.reject(event.workflowId, event.action, event.user);
      if (deps.store && deps.applyEvent) {
        const wf = deps.store.get(event.workflowId);
        if (wf) {
          const updated = deps.applyEvent(wf, { type: "reject", action: event.action, user: event.user });
          deps.store.set(event.workflowId, updated);
        }
      }
    }

    if (deps.onEvent) {
      const response = await deps.onEvent(event);
      return { ok: true, response };
    }
    return { ok: true };
  };

  const replyToMessage = async (message: any, content: string): Promise<void> => {
    if (typeof message.reply === "function") {
      try {
        await message.reply(content);
      } catch (err) {
        console.error("Failed to reply to message:", err);
      }
    }
  };

  const botMentionPattern = (): RegExp | undefined => {
    const id = deps.botUserId?.trim();
    return id ? new RegExp(`^<@!?${id}>\\s*`) : undefined;
  };

  const stripBotMention = (content: string): { mentioned: boolean; commandText: string } => {
    const pattern = botMentionPattern();
    if (!pattern) return { mentioned: false, commandText: content };
    const mentioned = pattern.test(content.trim());
    return { mentioned, commandText: content.trim().replace(pattern, "").trim() };
  };

  const eventFromMessage = (
    rawContent: string,
    user: string,
  ): {
    event: ControlEvent | { type: "unknown"; raw: string };
    mentioned: boolean;
    multiRequest: ControlEvent[] | null;
    commandText: string;
  } => {
    const mention = stripBotMention(rawContent);
    const commandText = mention.mentioned && mention.commandText.length > 0 ? mention.commandText : rawContent;
    const multi = commandText.match(/^request\s+(all|both|claws)\s+(.+)$/i);
    if (multi?.[2]?.trim()) {
      return {
        event: { type: "unknown", raw: commandText },
        mentioned: mention.mentioned,
        multiRequest: RUNTIMES.map((runtime) => ({ type: "request", runtime, request: multi[2]!.trim() })),
        commandText,
      };
    }
    const parsed = parseCommand(commandText, user, mentioned);
    return {
      event: parsed,
      mentioned: mention.mentioned,
      multiRequest: null,
      commandText,
    };
  };

  const workflowSummary = (response: unknown, event: ControlEvent): string => {
    if (response && typeof response === "object" && "workflow" in response) {
      const wf = (response as any).workflow;
      return `Workflow ${wf.id} created: runtime=${wf.runtime}, stage=${wf.stage}, status=${wf.status}${wf.pendingAction ? `, pending=${wf.pendingAction}` : ""}`;
    }
    if (event.type === "approve" || event.type === "reject") {
      return `Workflow ${event.workflowId} action ${event.action} ${event.type}d.`;
    }
    return ``;
  };

  const usageGuide = () =>
    [
      "실행 명령 형식:",
      "- `request zeroclaw <요청>`",
      "- `request nullclaw <요청>`",
      "- `request both <요청>`  ← 두 runtime 모두 시작",
      "- `/request` slash command도 사용 가능",
    ].join("\\n");

  return {
    handleMessage: async (message: any) => {
      if (message.author?.bot) return;

      const user = message.author?.tag || message.author?.username || "unknown";
      const rawContent = String(message.content ?? "");
      const { event, mentioned, multiRequest } = eventFromMessage(rawContent, user);

      const context: EventContext = {
        guildId: message.guildId || message.guild?.id,
        channelId: message.channelId || message.channel?.id,
        member: message.member,
      };
      const replyError = async (reason: string) => replyToMessage(message, reason);

      if (multiRequest) {
        try {
          const summaries: string[] = [];
          for (const requestEvent of multiRequest) {
            const result = await processEvent(requestEvent, context, replyError);
            if (result.ok) summaries.push(workflowSummary(result.response, requestEvent));
          }
          if (summaries.length > 0) {
            await replyToMessage(message, summaries.join("\\n"));
          }
        } catch (err) {
          await replyError(`Command failed: ${errorMessage(err)}`);
        }
        return;
      }

      if (event.type !== "unknown") {
        let result: { ok: boolean; response?: unknown } = { ok: false };
        try {
          result = await processEvent(event, context, replyError);
        } catch (err) {
          await replyError(`Command failed: ${errorMessage(err)}`);
          return;
        }
        if (result.ok) {
          await replyToMessage(message, workflowSummary(result.response, event));
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
        let cmdString = "";
        const commandName = interaction.commandName;

        if (commandName === "request") {
          const runtime = interaction.options.getString("runtime") || "";
          const request = interaction.options.getString("request") || "";
          cmdString = `request ${runtime} ${request}`;
        } else if (commandName === "approve") {
          const workflowId = interaction.options.getString("workflowid") || "";
          const action = actionFromInteraction(interaction);
          cmdString = `approve ${workflowId} ${action}`;
        } else if (commandName === "reject") {
          const workflowId = interaction.options.getString("workflowid") || "";
          const action = actionFromInteraction(interaction);
          cmdString = `reject ${workflowId} ${action}`;
        } else if (commandName === "config") {
          const subcommand = interaction.options.getSubcommand?.(false);
          if (subcommand === "set") {
            const key = interaction.options.getString("key") || "";
            const value = interaction.options.getString("value") || "";
            cmdString = `config set ${key} ${value}`;
          }
        }

        if (cmdString) {
          const event = parseCommand(cmdString, user);
          if (event.type !== "unknown") {
            const deferred = await deferInteraction(interaction, true);
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
                content: workflowSummary(result.response, event),
                ephemeral: true,
              }, deferred);
            }
          } else {
            await replyInteraction(interaction, {
              content: "Unknown command.",
              ephemeral: true,
            }, false);
          }
        }
      } else if (interaction.isButton?.()) {
        const customId = interaction.customId || "";
        if (customId.startsWith("approve:") || customId.startsWith("reject:")) {
          const parts = customId.split(":");
          const verb = parts[0];
          const workflowId = parts[1];
          const approvalAction = parts[2] as HighRiskAction | undefined;

          const cmdString = `${verb} ${workflowId ?? ""} ${approvalAction ?? ""}`;
          const event = parseCommand(cmdString, user);
          if (event.type === "approve" || event.type === "reject") {
            const deferred = await deferInteraction(interaction, false);
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
                content: workflowSummary(result.response, event),
                ephemeral: false,
              }, deferred);
            }
          }
        }
      }
    },
  };
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
    console.log(`[Discord Bot] Ready. Logged in as ${client.user?.tag}`); console.log("[Discord Bot] Policy:", JSON.stringify(policy));
  });

  await client.login(token);

  const policy = await resolveLivePolicy(client, process.env);
  const guildId = requireTrimmed("DISCORD_GUILD_ID", policy.guildId);
  const glueEndpoint = requireTrimmed("GLUE_EVENT_ENDPOINT", policy.controlEndpoint);
  const controlEventSecret = requireTrimmed("JEO_CONTROL_EVENT_SECRET", policy.controlEventSecret);

  const registry = new ApprovalRegistry();
  const handlers = buildHandlers({
    registry,
    policy,
    botUserId: client.user?.id,
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

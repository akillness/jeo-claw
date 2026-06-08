import { Client, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import type { ControlEvent, WorkflowState, HighRiskAction } from "../glue/contract.ts";
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

async function forwardControlEvent(endpoint: string, secret: string, event: ControlEvent): Promise<void> {
  const res = await fetch(`${endpoint.replace(/\/$/, "")}/control-event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-control-event-secret": secret,
    },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`control event delivery failed (${res.status}): ${text}`);
  }
}

/**
 * Builds the message and interaction handlers.
 */
export function buildHandlers(deps: {
  onEvent?: (e: ControlEvent) => void | Promise<void>;
  registry: ApprovalRegistry;
  store?: Map<string, WorkflowState>;
  applyEvent?: typeof applyEvent;
  createWorkflow?: typeof createWorkflow;
  policy?: CommandPolicy;
}) {
  const processEvent = async (
    event: ControlEvent,
    context: EventContext,
    replyError: (reason: string) => Promise<void>
  ): Promise<boolean> => {
    const auth = authorizeEvent(event, context, deps.policy);
    if (!auth.ok) {
      await replyError(auth.reason || "Unauthorized command");
      return false;
    }

    if (event.type === "config-set") {
      const validation = validateConfigValue(event.key, event.value);
      if (!validation.ok) {
        await replyError(validation.reason || "Invalid config value");
        return false;
      }
      await replyError("Command rejected: config-set is not implemented in the control plane.");
      return false;
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
      await deps.onEvent(event);
    }
    return true;
  };

  return {
    handleMessage: async (message: any) => {
      if (message.author?.bot) return;

      const user = message.author?.tag || message.author?.username || "unknown";
      const event = parseCommand(message.content, user);

      if (event.type !== "unknown") {
        const context: EventContext = {
          guildId: message.guildId || message.guild?.id,
          channelId: message.channelId || message.channel?.id,
          member: message.member,
        };
        const replyError = async (reason: string) => {
          if (typeof message.reply === "function") {
            try {
              await message.reply(reason);
            } catch (err) {
              console.error("Failed to reply to message:", err);
            }
          }
        };
        const ok = await processEvent(event, context, replyError);
        if (ok && typeof message.reply === "function") {
          try {
            await message.reply(`Processed command: ${event.type}`);
          } catch (err) {
            console.error("Failed to reply to message:", err);
          }
        }
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
            const replyError = async (reason: string) => {
              if (typeof interaction.reply === "function") {
                try {
                  await interaction.reply({
                    content: reason,
                    ephemeral: true,
                  });
                } catch (err) {
                  console.error("Failed to reply to interaction:", err);
                }
              }
            };
            const ok = await processEvent(event, context, replyError);
            if (ok && typeof interaction.reply === "function") {
              try {
                await interaction.reply({
                  content: `Command processed: ${cmdString}`,
                  ephemeral: true,
                });
              } catch (err) {
                console.error("Failed to reply to interaction:", err);
              }
            }
          } else if (typeof interaction.reply === "function") {
            try {
              await interaction.reply({
                content: `Unknown command: ${cmdString}`,
                ephemeral: true,
              });
            } catch (err) {
              console.error("Failed to reply to interaction:", err);
            }
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
            const replyError = async (reason: string) => {
              if (typeof interaction.reply === "function") {
                try {
                  await interaction.reply({
                    content: reason,
                    ephemeral: true,
                  });
                } catch (err) {
                  console.error("Failed to reply to interaction:", err);
                }
              }
            };
            const ok = await processEvent(event, context, replyError);
            if (ok && typeof interaction.reply === "function") {
              try {
                await interaction.reply({
                  content: `Workflow ${event.workflowId} action ${event.action} has been ${verb}d by ${user}.`,
                  ephemeral: false,
                });
              } catch (err) {
                console.error("Failed to reply to interaction:", err);
              }
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
  const policy = policyFromEnv(process.env);
  requireTrimmed("DISCORD_GUILD_ID", policy.guildId);
  requireTrimmed("DISCORD_REQUEST_CHANNEL_ID", policy.requestChannelId);
  requireTrimmed("DISCORD_APPROVAL_CHANNEL_ID", policy.approvalChannelId);
  const glueEndpoint = requireTrimmed("GLUE_EVENT_ENDPOINT", policy.controlEndpoint);
  const controlEventSecret = requireTrimmed("JEO_CONTROL_EVENT_SECRET", policy.controlEventSecret);

  const registry = new ApprovalRegistry();
  const handlers = buildHandlers({
    registry,
    policy,
    onEvent: async (event) => {
      await forwardControlEvent(glueEndpoint, controlEventSecret, event);
      console.log("[Discord Bot] ControlEvent:", event);
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

  client.on("ready", () => {
    console.log(`[Discord Bot] Ready. Logged in as ${client.user?.tag}`);
  });

  await client.login(token);
  return client;
}

if (import.meta.main) {
  start().catch((err) => {
    console.error("[Discord Bot] Startup failed:", err);
    process.exit(1);
  });
}

import { Client, GatewayIntentBits } from "discord.js";
import type { ControlEvent, WorkflowState, HighRiskAction } from "../glue/contract.ts";
import { parseCommand, validateConfigValue } from "./commands.ts";
import { ApprovalRegistry } from "./approval.ts";
import type { applyEvent, createWorkflow } from "../glue/state-machine.ts";

function actionFromInteraction(interaction: any): string {
  return interaction.options?.getString?.("action") || interaction.options?.getString?.("approval_action") || "";
}
async function forwardControlEvent(endpoint: string, event: ControlEvent): Promise<void> {
  const res = await fetch(`${endpoint.replace(/\/$/, "")}/control-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
}) {
  const processEvent = async (
    event: ControlEvent,
    replyError: (reason: string) => Promise<void>
  ): Promise<boolean> => {
    if (event.type === "config-set") {
      const validation = validateConfigValue(event.key, event.value);
      if (!validation.ok) {
        await replyError(validation.reason || "Invalid config value");
        return false;
      }
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
        const replyError = async (reason: string) => {
          if (typeof message.reply === "function") {
            try {
              await message.reply(`Command rejected: ${reason}`);
            } catch (err) {
              console.error("Failed to reply to message:", err);
            }
          }
        };
        const ok = await processEvent(event, replyError);
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
                    content: `Command rejected: ${reason}`,
                    ephemeral: true,
                  });
                } catch (err) {
                  console.error("Failed to reply to interaction:", err);
                }
              }
            };
            const ok = await processEvent(event, replyError);
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
                    content: `Command rejected: ${reason}`,
                    ephemeral: true,
                  });
                } catch (err) {
                  console.error("Failed to reply to interaction:", err);
                }
              }
            };
            const ok = await processEvent(event, replyError);
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
 * Constructs client and logs in using process.env.DISCORD_BOT_TOKEN.
 */
export async function start(): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const registry = new ApprovalRegistry();
  const glueEndpoint = process.env.GLUE_EVENT_ENDPOINT;
  const handlers = buildHandlers({
    registry,
    onEvent: async (event) => {
      if (glueEndpoint) {
        await forwardControlEvent(glueEndpoint, event);
      }
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

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || token.trim() === "") {
    throw new Error("[Discord Bot] DISCORD_BOT_TOKEN is missing or empty.");
  }

  await client.login(token);
  return client;
}

if (import.meta.main) {
  start().catch((err) => {
    console.error("[Discord Bot] Startup failed:", err);
    process.exit(1);
  });
}

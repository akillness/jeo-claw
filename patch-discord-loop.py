import sys
import re

with open("glue/server.ts", "r", encoding="utf-8") as f:
    glue_content = f.read()

if "if (process.env.NODE_ENV === \"test\") return;" not in glue_content:
    glue_content = glue_content.replace(
        "async function notifyStatus(workflow: WorkflowState, message: string) {",
        "async function notifyStatus(workflow: WorkflowState, message: string) {\n  if (process.env.NODE_ENV === \"test\") return;"
    )

with open("glue/server.ts", "w", encoding="utf-8") as f:
    f.write(glue_content)

with open("discord/bot.ts", "r", encoding="utf-8") as f:
    discord_content = f.read()

discord_content = discord_content.replace(
    "sendToChannel: (content: string, components?: unknown[]) => Promise<void>;",
    "sendToChannel: (content: string, components?: unknown[], workflowId?: string) => Promise<void>;"
)

discord_content = discord_content.replace(
    "await deps.sendToChannel(content, components);",
    "await deps.sendToChannel(content, components, notification.workflowId);"
)

old_send_impl = """  const sendToChannel = async (content: string, components?: any[]) => {
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
  };"""

new_send_impl = """  const messageCache = new Map<string, string>();
  const sendToChannel = async (content: string, components?: any[], workflowId?: string) => {
    if (content.length > 1950) {
      content = content.substring(0, 1950) + "... (truncated)";
    }

    try {
      const channelId = policy.requestChannelId;
      if (!channelId) return;
      const channel = await client.channels.fetch(channelId);
      if (channel && "send" in channel) {
        if (workflowId && messageCache.has(workflowId)) {
          const msgId = messageCache.get(workflowId)!;
          try {
            const existingMsg = await (channel as any).messages.fetch(msgId);
            if (existingMsg && "edit" in existingMsg) {
              await existingMsg.edit({
                content,
                components: components || [],
              });
              return;
            }
          } catch (e) {
            // Message might be deleted, fallback to send
            messageCache.delete(workflowId);
          }
        }
        
        const sent = await (channel as any).send({
          content,
          components: components || [],
        });
        
        if (workflowId && sent && sent.id) {
          messageCache.set(workflowId, sent.id);
        }
      }
    } catch (err) {
      console.error("[Discord Bot] Failed to send relay message:", err);
    }
  };"""

discord_content = discord_content.replace(old_send_impl, new_send_impl)

with open("discord/bot.ts", "w", encoding="utf-8") as f:
    f.write(discord_content)


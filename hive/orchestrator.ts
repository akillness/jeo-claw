import { start as startGlue } from "../glue/server.ts";
import { start as startDiscord } from "../discord/bot.ts";

async function main() {
  console.log("[Orchestrator] Starting glue server...");
  startGlue();

  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  if (botToken) {
    console.log("[Orchestrator] Starting Discord bot...");
    try {
      await startDiscord();
      console.log("[Orchestrator] Discord bot started successfully.");
    } catch (err) {
      console.error("[Orchestrator] Failed to start Discord bot:", err);
    }
  } else {
    console.log("[Orchestrator] DISCORD_BOT_TOKEN is unset. Skipping Discord bot start (smoke run headless).");
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[Orchestrator] Orchestrator startup failed:", err);
    process.exit(1);
  });
}

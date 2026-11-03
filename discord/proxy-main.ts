import { installDiscordGatewayProxy } from "./proxy-transport.ts";

async function main(): Promise<void> {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      console.error("[Discord Bot] Shutdown timed out after 5 seconds");
      process.exit(1);
    }, 5_000);
    void startup.then((client) => client.destroy()).then(
      () => {
        clearTimeout(deadline);
        process.exit(0);
      },
      (error) => {
        clearTimeout(deadline);
        console.error("[Discord Bot] Shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  const startup = (async () => {
    const proxy = process.env.HTTPS_PROXY?.trim();
    if (!proxy) throw new Error("HTTPS_PROXY is required for the Discord process");
    const parsed = new URL(proxy);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("HTTPS_PROXY must be an HTTP proxy URL");
    }
    installDiscordGatewayProxy(proxy);
    // discord.js captures WebSocket at import time, so this process must install the proxy first.
    const { start } = await import("./bot.ts");
    return start({ proxy });
  })();
  await startup;
}

main().catch((error) => {
  console.error("[Discord Bot] Startup failed:", error);
  process.exitCode = 1;
});

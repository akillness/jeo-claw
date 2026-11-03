import { start as startGlue } from "../glue/server.ts";
import { parseControlMode } from "../glue/contract.ts";

export async function shutdownServer(server: { stop(closeActiveConnections?: boolean): Promise<void> }, timeoutMs = 5000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      server.stop(true),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Glue server shutdown timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log("[Orchestrator] Starting glue server...");
  const server = startGlue({ controlMode: parseControlMode(process.env.JEO_CONTROL_MODE) });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void shutdownServer(server).then(
      () => process.exit(0),
      () => {
        console.error("[Orchestrator] Glue server shutdown failed");
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.main) {
  main().catch(() => {
    console.error("[Orchestrator] Orchestrator startup failed");
    process.exit(1);
  });
}

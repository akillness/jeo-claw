import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { secretSourceFromEnv, loadSecretsForControl, loadSecretsForRole } from "../secrets/loader.ts";
import { prepareRuntimeConfig } from "./runtime-auth.ts";
import { ROLES, CLAW_PORTS } from "../glue/contract.ts";
import type { Role } from "../glue/contract.ts";

const ZEROCLAW_HOME = "/data/zeroclaw-home";
const ZEROCLAW_STATE_DIR = `${ZEROCLAW_HOME}/.zeroclaw`;

export interface ChildSpec {
  id: string;
  command: string[];
  env: Record<string, string>;
}

export interface HiveSecrets {
  orchestrator: Record<string, string>;
  roles: Record<Role, Record<string, string>>;
}

export function isBinaryOnPath(name: string): boolean {
  try {
    const result = spawnSync(name, ["--help"], { stdio: "ignore" });
    return result.error === undefined;
  } catch {
    return false;
  }
}

export function pickPassthroughEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  const secretKeys = new Set([
    "DISCORD_BOT_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_WEBHOOK_SECRET",
    "OPENAI_CODEX_AUTH",
    "JEO_CONTROL_EVENT_SECRET",
    "JEO_RUNTIME_DISPATCH_SECRET",
  ]);
  for (const key of Object.keys(parentEnv)) {
    const val = parentEnv[key];
    if (val !== undefined && !secretKeys.has(key)) {
      result[key] = val;
    }
  }
  return result;
}

export function buildChildSpecs(
  parentEnv: NodeJS.ProcessEnv,
  secrets: HiveSecrets,
  hasZeroclawBinary: boolean
): ChildSpec[] {
  const specs: ChildSpec[] = [];
  const configEnv = pickPassthroughEnv(parentEnv);

  // 1. orchestrator
  specs.push({
    id: "orchestrator",
    command: ["bun", "run", "hive/orchestrator.ts"],
    env: {
      ...configEnv,
      ...secrets.orchestrator,
    },
  });

  // Determine if LLM gateway should be run
  let openaiCodexAuth: string | undefined;
  for (const roleSecrets of Object.values(secrets.roles)) {
    if (roleSecrets.OPENAI_CODEX_AUTH) {
      openaiCodexAuth = roleSecrets.OPENAI_CODEX_AUTH;
      break;
    }
  }

  const shouldSpawnGateway = !!(openaiCodexAuth && hasZeroclawBinary);

  // 2. roles
  for (const r of ROLES) {
    const roleEnv: Record<string, string> = {
      ...configEnv,
      ...secrets.roles[r],
      JEO_CLAW_PORT: String(CLAW_PORTS[r]),
    };

    if (shouldSpawnGateway) {
      roleEnv.LLM_GATEWAY_URL = "http://127.0.0.1:4096";
    }

    specs.push({
      id: r,
      command: ["bun", "run", "claws/worker.ts", r],
      env: roleEnv,
    });
  }

  // 3. Optional LLM gateway child spec
  if (shouldSpawnGateway) {
    const gatewayEnv: Record<string, string> = {
      ...configEnv,
      HOME: ZEROCLAW_HOME,
      OPENAI_CODEX_AUTH: openaiCodexAuth!,
    };
    specs.push({
      id: "zeroclaw-gateway",
      command: ["zeroclaw", "gateway", "start", "-p", "4096"],
      env: gatewayEnv,
    });
  }

  return specs;
}

class ChildSupervisor {
  private proc: ChildProcess | null = null;
  private backoffMs = 1000;
  private healthyTimeout: any = null;
  private isShuttingDown = false;

  constructor(
    private readonly spec: ChildSpec
  ) {}

  start() {
    if (this.isShuttingDown) return;

    console.log(`[Hive Supervisor] Spawning child ${this.spec.id}: ${this.spec.command.join(" ")}`);

    const [cmd, ...args] = this.spec.command;
    this.proc = spawn(cmd!, args, {
      env: { ...process.env, ...this.spec.env },
      stdio: "inherit",
    });

    if (this.healthyTimeout) {
      clearTimeout(this.healthyTimeout);
    }
    this.healthyTimeout = setTimeout(() => {
      if (this.proc && !this.isShuttingDown) {
        console.log(`[Hive Supervisor] Child ${this.spec.id} has been healthy for 60s, resetting backoff.`);
        this.backoffMs = 1000;
      }
    }, 60000);

    this.proc.on("exit", (code, signal) => {
      this.proc = null;
      if (this.healthyTimeout) {
        clearTimeout(this.healthyTimeout);
        this.healthyTimeout = null;
      }

      if (this.isShuttingDown) {
        console.log(`[Hive Supervisor] Child ${this.spec.id} exited during shutdown (code: ${code}, signal: ${signal}).`);
        return;
      }

      console.error(`[Hive Supervisor] Child ${this.spec.id} crashed or exited (code: ${code}, signal: ${signal}).`);
      
      const currentBackoff = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);

      console.log(`[Hive Supervisor] Restarting child ${this.spec.id} in ${currentBackoff}ms...`);
      setTimeout(() => {
        this.start();
      }, currentBackoff);
    });
  }

  shutdown() {
    this.isShuttingDown = true;
    if (this.healthyTimeout) {
      clearTimeout(this.healthyTimeout);
      this.healthyTimeout = null;
    }
    if (this.proc) {
      console.log(`[Hive Supervisor] Killing child ${this.spec.id}...`);
      this.proc.kill("SIGTERM");
    }
  }
}

async function main() {
  const project = process.env.GCLOUD_PROJECT || "";
  const prefix = process.env.GCLOUD_SECRET_PREFIX || "";

  if (!project || !prefix) {
    console.error("[Hive Supervisor] GCLOUD_PROJECT and GCLOUD_SECRET_PREFIX are required.");
    process.exit(1);
  }

  console.log("[Hive Supervisor] Loading secrets...");
  const secretSource = secretSourceFromEnv(process.env, project);
  const opts = { prefix };

  const glueSecrets = await loadSecretsForControl("glue-webhook", secretSource, opts);
  const discordSecrets = await loadSecretsForControl("discord-bot", secretSource, opts);
  const orchestratorSecrets = { ...glueSecrets, ...discordSecrets };

  const rolesSecrets: Record<Role, Record<string, string>> = {} as any;
  for (const r of ROLES) {
    rolesSecrets[r] = await loadSecretsForRole(r, secretSource, opts);
  }

  const secrets: HiveSecrets = {
    orchestrator: orchestratorSecrets,
    roles: rolesSecrets,
  };

  const hasZeroclaw = isBinaryOnPath("zeroclaw");

  // Run prepareRuntimeConfig if ZeroClaw auth is loaded and zeroclaw binary is on path
  let openaiCodexAuth: string | undefined;
  for (const roleSecrets of Object.values(secrets.roles)) {
    if (roleSecrets.OPENAI_CODEX_AUTH) {
      openaiCodexAuth = roleSecrets.OPENAI_CODEX_AUTH;
      break;
    }
  }

  if (openaiCodexAuth && hasZeroclaw) {
    console.log("[Hive Supervisor] Preparing ZeroClaw runtime config...");
    try {
      prepareRuntimeConfig("zeroclaw", {
        HOME: ZEROCLAW_HOME,
        OPENAI_CODEX_AUTH: openaiCodexAuth,
        LLM_MODEL: process.env.LLM_MODEL,
        OPENAI_WIRE_API: process.env.OPENAI_WIRE_API,
      }, ZEROCLAW_STATE_DIR);
    } catch (err) {
      console.error("[Hive Supervisor] Failed to prepare ZeroClaw config:", err);
    }
  } else if (openaiCodexAuth) {
    console.log("[Hive Supervisor] Notice: ZeroClaw authentication loaded but zeroclaw binary not found on PATH. Skipping gateway config.");
  }

  const specs = buildChildSpecs(process.env, secrets, hasZeroclaw);
  const supervisors = specs.map((spec) => new ChildSupervisor(spec));

  function handleTermination(signal: string) {
    console.log(`[Hive Supervisor] Received ${signal}. Shutting down all children...`);
    for (const supervisor of supervisors) {
      supervisor.shutdown();
    }
    setTimeout(() => {
      console.log("[Hive Supervisor] Shutdown complete.");
      process.exit(0);
    }, 1000);
  }

  process.on("SIGINT", () => handleTermination("SIGINT"));
  process.on("SIGTERM", () => handleTermination("SIGTERM"));

  console.log("[Hive Supervisor] Starting all supervised children...");
  for (const supervisor of supervisors) {
    supervisor.start();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[Hive Supervisor] Supervisor main thread failed:", err);
    process.exit(1);
  });
}

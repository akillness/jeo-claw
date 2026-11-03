import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { secretSourceFromEnv, loadSecretsForControl, loadSecretsForRole, SecretAccessAbortedError } from "../secrets/loader.ts";
import { prepareRuntimeConfig, RuntimeAuthAbortedError, RuntimeAuthCleanupError } from "./runtime-auth.ts";
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
  discord: Record<string, string>;
  roles: Record<Role, Record<string, string>>;
}

export async function isBinaryOnPath(name: string, signal?: AbortSignal): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (signal?.aborted) throw new SecretAccessAbortedError();
    const candidate = join(directory || ".", name);
    try {
      await access(candidate, constants.X_OK);
      const found = (await stat(candidate)).isFile();
      if (signal?.aborted) throw new SecretAccessAbortedError();
      if (found) return true;
    } catch (error) {
      if (error instanceof SecretAccessAbortedError) throw error;
      // Continue searching PATH.
    }
  }
  if (signal?.aborted) throw new SecretAccessAbortedError();
  return false;
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
    "JEO_STATUS_RELAY_SECRET",
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
  const mode = parentEnv.JEO_CONTROL_MODE ?? "normal";
  if (mode !== "normal" && mode !== "probe-only") throw new Error("Invalid JEO_CONTROL_MODE");

  // 1. orchestrator
  specs.push({
    id: "orchestrator",
    command: ["bun", "run", "hive/orchestrator.ts"],
    env: {
      ...configEnv,
      ...secrets.orchestrator,
    },
  });

  if (secrets.discord.DISCORD_BOT_TOKEN?.trim()) {
    specs.push({
      id: "discord",
      command: ["bun", "run", "discord/proxy-main.ts"],
      env: { ...configEnv, ...secrets.discord },
    });
  }
  if (mode === "probe-only") return specs;

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

interface ChildSupervisorDeps {
  spawnChild?: typeof spawn;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}

export class ChildSupervisor {
  private proc: ChildProcess | null = null;
  private backoffMs = 1000;
  private healthyTimeout: ReturnType<typeof setTimeout> | null = null;
  private restartTimeout: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private childDone: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;

  constructor(
    private readonly spec: ChildSpec,
    private readonly deps: ChildSupervisorDeps = {},
  ) {}

  start() {
    if (this.isShuttingDown || this.proc) return;

    if (this.restartTimeout) {
      (this.deps.cancel ?? clearTimeout)(this.restartTimeout);
      this.restartTimeout = null;
    }

    console.log(`[Hive Supervisor] Spawning child ${this.spec.id}: ${this.spec.command.join(" ")}`);

    const [cmd, ...args] = this.spec.command;
    let child: ChildProcess;
    try {
      child = (this.deps.spawnChild ?? spawn)(cmd!, args, {
        env: this.spec.env,
        stdio: "inherit",
      });
    } catch (error) {
      console.error(`[Hive Supervisor] Failed to spawn child ${this.spec.id}:`, error);
      this.scheduleRestart();
      return;
    }
    this.proc = child;
    const { promise: childDone, resolve: finishChild } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    this.childDone = childDone;

    if (this.healthyTimeout) {
      (this.deps.cancel ?? clearTimeout)(this.healthyTimeout);
    }
    this.healthyTimeout = (this.deps.schedule ?? setTimeout)(() => {
      if (this.proc && !this.isShuttingDown) {
        console.log(`[Hive Supervisor] Child ${this.spec.id} has been healthy for 60s, resetting backoff.`);
        this.backoffMs = 1000;
      }
    }, 60000);

    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      if (this.proc === child) this.proc = null;
      if (this.healthyTimeout) {
        (this.deps.cancel ?? clearTimeout)(this.healthyTimeout);
        this.healthyTimeout = null;
      }
      finishChild({ code, signal });
      if (this.isShuttingDown) {
        console.log(`[Hive Supervisor] Child ${this.spec.id} exited during shutdown (code: ${code}, signal: ${signal}).`);
        return;
      }
      console.error(`[Hive Supervisor] Child ${this.spec.id} crashed or exited (code: ${code}, signal: ${signal}).`);
      this.scheduleRestart();
    };
    child.on("exit", finish);
    child.on("error", (error) => {
      console.error(`[Hive Supervisor] Child ${this.spec.id} process error:`, error);
      if (child.pid === undefined) finish(1, null);
    });
  }

  private scheduleRestart() {
    if (this.isShuttingDown || this.restartTimeout) return;
    const currentBackoff = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    console.log(`[Hive Supervisor] Restarting child ${this.spec.id} in ${currentBackoff}ms...`);
    this.restartTimeout = (this.deps.schedule ?? setTimeout)(() => {
      this.restartTimeout = null;
      this.start();
    }, currentBackoff);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.isShuttingDown = true;
    if (this.healthyTimeout) {
      (this.deps.cancel ?? clearTimeout)(this.healthyTimeout);
      this.healthyTimeout = null;
    }
    if (this.restartTimeout) {
      (this.deps.cancel ?? clearTimeout)(this.restartTimeout);
      this.restartTimeout = null;
    }
    const child = this.proc;
    const done = this.childDone;
    if (!child || !done) return this.shutdownPromise = Promise.resolve();
    this.shutdownPromise = (async () => {
      console.log(`[Hive Supervisor] Stopping child ${this.spec.id}...`);
      try {
        child.kill("SIGTERM");
      } catch (error) {
        console.error(`[Hive Supervisor] Failed to terminate child ${this.spec.id}:`, error);
      }
      const timeout = Promise.withResolvers<never>();
      let finalDeadline: NodeJS.Timeout | null = null;
      const escalation = (this.deps.schedule ?? setTimeout)(() => {
        if (this.proc !== child) return;
        console.error(`[Hive Supervisor] Child ${this.spec.id} did not stop; sending SIGKILL.`);
        finalDeadline = (this.deps.schedule ?? setTimeout)(() => {
          timeout.reject(new Error(`Child ${this.spec.id} did not exit after SIGKILL`));
        }, 5000);
        try {
          child.kill("SIGKILL");
        } catch (error) {
          console.error(`[Hive Supervisor] Failed to kill child ${this.spec.id}:`, error);
        }
      }, 10000);
      try {
        const result = await Promise.race([done, timeout.promise]);
        if ((result.code !== null && result.code !== 0) || (result.signal !== null && result.signal !== "SIGTERM")) {
          throw new Error(`Child ${this.spec.id} shutdown failed (code: ${result.code}, signal: ${result.signal})`);
        }
      } finally {
        (this.deps.cancel ?? clearTimeout)(escalation);
        if (finalDeadline) (this.deps.cancel ?? clearTimeout)(finalDeadline);
      }
    })();
    return this.shutdownPromise;
  }
}

export async function main(deps: { prepareRuntimeConfig?: typeof prepareRuntimeConfig; spawnChild?: typeof spawn } = {}) {
  const mode = process.env.JEO_CONTROL_MODE ?? "normal";
  if (mode !== "normal" && mode !== "probe-only") throw new Error("Invalid JEO_CONTROL_MODE");
  const project = process.env.GCLOUD_PROJECT || "";
  const prefix = process.env.GCLOUD_SECRET_PREFIX || "";

  if (!project || !prefix) {
    console.error("[Hive Supervisor] GCLOUD_PROJECT and GCLOUD_SECRET_PREFIX are required.");
    process.exit(1);
  }

  const startupAbort = new AbortController();
  const { promise: startupDone, resolve: finishStartup } = Promise.withResolvers<void>();
  let supervisors: ChildSupervisor[] = [];
  let termination: Promise<void> | null = null;
  let startupFailure: unknown;
  function handleTermination(signal: string) {
    if (termination) return;
    console.log(`[Hive Supervisor] Received ${signal}. Shutting down all children...`);
    startupAbort.abort();
    termination = (async () => {
      await startupDone;
      const results = await Promise.allSettled(supervisors.map((supervisor) => supervisor.shutdown()));
      const failures = results.filter((result) => result.status === "rejected");
      if (startupFailure) {
        console.error("[Hive Supervisor] Startup cleanup failed:", startupFailure);
        process.exit(1);
      }
      if (failures.length > 0) {
        for (const failure of failures) console.error("[Hive Supervisor] Shutdown failed:", failure.reason);
        process.exit(1);
      }
      console.log("[Hive Supervisor] Shutdown complete.");
      process.exit(0);
    })();
  }
  process.on("SIGINT", () => handleTermination("SIGINT"));
  process.on("SIGTERM", () => handleTermination("SIGTERM"));

  try {

  console.log("[Hive Supervisor] Loading secrets...");
  const secretSource = secretSourceFromEnv(process.env, project);
  const opts = { prefix, signal: startupAbort.signal };

  const glueSecrets = await loadSecretsForControl("glue-webhook", secretSource, opts);
  const discordSecrets = await loadSecretsForControl("discord-bot", secretSource, opts);

  const rolesSecrets: Record<Role, Record<string, string>> = {} as any;
  if (mode === "normal") {
    for (const r of ROLES) rolesSecrets[r] = await loadSecretsForRole(r, secretSource, opts);
  }

  const secrets: HiveSecrets = {
    orchestrator: glueSecrets,
    discord: discordSecrets,
    roles: rolesSecrets,
  };

  const hasZeroclaw = mode === "normal" && await isBinaryOnPath("zeroclaw", startupAbort.signal);

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
      await (deps.prepareRuntimeConfig ?? prepareRuntimeConfig)("zeroclaw", {
        HOME: ZEROCLAW_HOME,
        OPENAI_CODEX_AUTH: openaiCodexAuth,
        LLM_MODEL: process.env.LLM_MODEL,
        OPENAI_WIRE_API: process.env.OPENAI_WIRE_API,
      }, ZEROCLAW_STATE_DIR, startupAbort.signal);
    } catch (err) {
      if (startupAbort.signal.aborted || err instanceof RuntimeAuthCleanupError) throw err;
      throw new Error("Failed to prepare ZeroClaw config");
    }
  } else if (openaiCodexAuth) {
    console.log("[Hive Supervisor] Notice: ZeroClaw authentication loaded but zeroclaw binary not found on PATH. Skipping gateway config.");
  }

  const specs = buildChildSpecs(process.env, secrets, hasZeroclaw);
  supervisors = specs.map((spec) => new ChildSupervisor(spec, { spawnChild: deps.spawnChild }));

  console.log("[Hive Supervisor] Starting all supervised children...");
  for (const supervisor of supervisors) {
    supervisor.start();
  }
  } catch (error) {
    if (!startupAbort.signal.aborted) throw error;
    if (!(error instanceof SecretAccessAbortedError) && !(error instanceof RuntimeAuthAbortedError)) startupFailure = error;
  } finally {
    finishStartup();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[Hive Supervisor] Supervisor main thread failed:", err);
    process.exit(1);
  });
}

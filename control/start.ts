import { spawn } from "node:child_process";
import {
  loadSecretsForControl,
  secretSourceFromEnv,
  type ControlService,
  type SecretSource,
} from "../secrets/loader.ts";

const SERVICE_COMMANDS: Record<ControlService, readonly [string, ...string[]]> = {
  "glue-webhook": ["bun", "run", "glue/server.ts"],
  "discord-bot": ["bun", "run", "discord/bot.ts"],
};
const COMMON_BOOTSTRAP_ENV = [
  "PATH",
  "HOME",
  "HOSTNAME",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TERM",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_ENV",
  "JEO_CONTROL_SERVICE",
  "GCLOUD_PROJECT",
  "GCLOUD_SECRET_PREFIX",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "TARGET_REPO",
  "TARGET_BRANCH",
  "JEO_SECRET_SOURCE",
  "JEO_SECRETS_FILE",
  "GITHUB_API_BASE_URL",
] as const;

const SERVICE_BOOTSTRAP_ENV: Record<ControlService, readonly string[]> = {
  "glue-webhook": ["GLUE_PORT", "GITHUB_WEBHOOK_PATH"],
  "discord-bot": [
    "DISCORD_GUILD_ID",
    "DISCORD_REQUEST_CHANNEL_ID",
    "DISCORD_STATUS_CHANNEL_ID",
    "DISCORD_APPROVAL_CHANNEL_ID",
    "DISCORD_DASHBOARD_CHANNEL_ID",
    "DISCORD_APPROVER_ROLE_ID",
    "GLUE_EVENT_ENDPOINT",
  ],
};

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type SignalHandler = () => void;
type SignalRegistrar = (signal: NodeJS.Signals, handler: SignalHandler) => void;
type SignalUnregistrar = (signal: NodeJS.Signals, handler: SignalHandler) => void;

export function bindTerminationHandlers(
  register: SignalRegistrar,
  unregister: SignalUnregistrar,
  onSignal: (signal: NodeJS.Signals) => void,
): () => void {
  const handlers = new Map<NodeJS.Signals, SignalHandler>();
  for (const signal of TERMINATION_SIGNALS) {
    const handler = () => onSignal(signal);
    handlers.set(signal, handler);
    register(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      unregister(signal, handler);
    }
  };
}


function requireTrimmed(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is missing or empty`);
  }
  return trimmed;
}
function pickAllowedEnv(service: ControlService, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set<string>([...COMMON_BOOTSTRAP_ENV, ...SERVICE_BOOTSTRAP_ENV[service]]);
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => allowed.has(key) && value !== undefined),
  );
}


export function commandForService(service: ControlService): readonly [string, ...string[]] {
  return SERVICE_COMMANDS[service];
}

export async function resolveControlEnvironment(
  service: ControlService,
  env: NodeJS.ProcessEnv,
  source: SecretSource,
): Promise<NodeJS.ProcessEnv> {
  const project = requireTrimmed("GCLOUD_PROJECT", env.GCLOUD_PROJECT);
  const prefix = requireTrimmed("GCLOUD_SECRET_PREFIX", env.GCLOUD_SECRET_PREFIX);
  const loaded = await loadSecretsForControl(service, source, { prefix });
  const sanitizedLoaded = Object.fromEntries(
    Object.entries(loaded).map(([key, value]) => [key, requireTrimmed(key, value)]),
  );

  return {
    ...pickAllowedEnv(service, env),
    GCLOUD_PROJECT: project,
    GCLOUD_SECRET_PREFIX: prefix,
    ...sanitizedLoaded,
  };
}

export async function startControlService(
  service: ControlService,
  env: NodeJS.ProcessEnv = process.env,
  sourceFactory: (project: string, env: NodeJS.ProcessEnv) => SecretSource = (project, sourceEnv) => secretSourceFromEnv(sourceEnv, project),
): Promise<void> {
  const project = requireTrimmed("GCLOUD_PROJECT", env.GCLOUD_PROJECT);
  const source = sourceFactory(project, env);
  const childEnv = await resolveControlEnvironment(service, env, source);
  const [command, ...args] = commandForService(service);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: childEnv,
      stdio: "inherit",
    });
    const cleanupSignals = bindTerminationHandlers(
      (signal, handler) => process.on(signal, handler),
      (signal, handler) => process.off(signal, handler),
      (signal) => {
        if (!child.killed) child.kill(signal);
      },
    );
    child.on("error", (err) => {
      cleanupSignals();
      reject(err);
    });
    child.on("close", (code) => {
      cleanupSignals();
      if (code === 0) resolve();
      else reject(new Error(`${service} exited with code ${code ?? 1}`));
    });
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const service = argv[0] as ControlService | undefined;
  if (service !== "glue-webhook" && service !== "discord-bot") {
    throw new Error("usage: bun run control/start.ts <glue-webhook|discord-bot>");
  }
  await startControlService(service);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[control-start] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

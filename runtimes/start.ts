import { spawn } from "node:child_process";
import { GcloudSecretSource, loadSecretsForRole, type Role, type SecretSource } from "../secrets/loader.ts";
import type { Runtime } from "../glue/contract.ts";

const RUNTIME_COMMANDS: Record<Runtime, readonly [string, ...string[]]> = {
  zeroclaw: ["zeroclaw", "service", "start"],
  nullclaw: ["nullclaw", "serve"],
};

const COMMON_RUNTIME_ENV = [
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
  "JEO_RUNTIME",
  "JEO_ROLE",
  "JEO_WORKTREE",
  "JEO_BRANCH_NAMESPACE",
  "TARGET_REPO",
  "TARGET_BRANCH",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "OPENAI_WIRE_API",
  "GCLOUD_PROJECT",
  "GCLOUD_SECRET_PREFIX",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

function requireTrimmed(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is missing or empty`);
  }
  return trimmed;
}

function pickAllowedRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set<string>(COMMON_RUNTIME_ENV);
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.has(key) && value !== undefined));
}

export function commandForRuntime(runtime: Runtime): readonly [string, ...string[]] {
  return RUNTIME_COMMANDS[runtime];
}

export async function resolveRuntimeEnvironment(
  runtime: Runtime,
  env: NodeJS.ProcessEnv,
  source: SecretSource,
): Promise<NodeJS.ProcessEnv> {
  const role = requireTrimmed("JEO_ROLE", env.JEO_ROLE) as Role;
  const prefix = requireTrimmed("GCLOUD_SECRET_PREFIX", env.GCLOUD_SECRET_PREFIX);
  const project = requireTrimmed("GCLOUD_PROJECT", env.GCLOUD_PROJECT);
  const loaded = await loadSecretsForRole(role, source, { prefix });
  const sanitizedLoaded = Object.fromEntries(
    Object.entries(loaded).map(([key, value]) => [key, requireTrimmed(key, value)]),
  );

  return {
    ...pickAllowedRuntimeEnv(env),
    JEO_RUNTIME: runtime,
    JEO_ROLE: role,
    GCLOUD_PROJECT: project,
    GCLOUD_SECRET_PREFIX: prefix,
    ...sanitizedLoaded,
  };
}

export async function startRuntime(
  runtime: Runtime,
  env: NodeJS.ProcessEnv = process.env,
  sourceFactory: (project: string) => SecretSource = (project) => new GcloudSecretSource(project),
): Promise<void> {
  const project = requireTrimmed("GCLOUD_PROJECT", env.GCLOUD_PROJECT);
  const childEnv = await resolveRuntimeEnvironment(runtime, env, sourceFactory(project));
  const [command, ...args] = commandForRuntime(runtime);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: childEnv,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${runtime} exited with code ${code ?? 1}`));
    });
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const runtime = argv[0] as Runtime | undefined;
  if (runtime !== "zeroclaw" && runtime !== "nullclaw") {
    throw new Error("usage: bun run runtimes/start.ts <zeroclaw|nullclaw>");
  }
  await startRuntime(runtime);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[runtime-start] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

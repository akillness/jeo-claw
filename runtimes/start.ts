import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSecretsForRole, secretSourceFromEnv, type Role, type SecretSource } from "../secrets/loader.ts";
import { DISPATCHABLE_STAGES, STAGE_TO_ROLE, type Runtime, type Stage } from "../glue/contract.ts";


const MAX_DISPATCH_BODY_BYTES = 64 * 1024;
const MAX_DISPATCH_REQUEST_CHARS = 4000;

const DEFAULT_CHILD_PORT: Record<Runtime, number> = {
  zeroclaw: 42617,
  nullclaw: 3000,
};
const RUNTIME_COMMANDS: Record<Runtime, (port: number, configDir?: string) => readonly [string, ...string[]]> = {
  zeroclaw: (port, configDir) => configDir
    ? ["zeroclaw", "gateway", "start", "--config-dir", configDir, "-p", String(port)]
    : ["zeroclaw", "gateway", "start", "-p", String(port)],
  nullclaw: (port) => ["nullclaw", "gateway", "--port", String(port)],
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
  "JEO_SECRET_SOURCE",
  "JEO_SECRETS_FILE",
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

function runtimeStateDir(runtime: Runtime): string {
  return runtime === "zeroclaw" ? "/root/.zeroclaw" : "/root/.config/nullclaw";
}

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type SignalHandler = () => void;
type SignalRegistrar = (signal: NodeJS.Signals, handler: SignalHandler) => void;
type SignalUnregistrar = (signal: NodeJS.Signals, handler: SignalHandler) => void;
type StoppableServer = { stop(closeActiveConnections?: boolean): void };

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

export function shutdownRuntimeChild(child: ChildProcessWithoutNullStreams | null, server: StoppableServer | null, signal: NodeJS.Signals): void {
  server?.stop(true);
  if (child && !child.killed) child.kill(signal);
}


function runtimeChildPort(runtime: Runtime, env: NodeJS.ProcessEnv): number {
  return Number(env.JEO_RUNTIME_CHILD_PORT ?? DEFAULT_CHILD_PORT[runtime]);
}

function childHealthUrl(port: number): string {
  return `http://127.0.0.1:${port}/health`;
}

async function childReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(childHealthUrl(port), { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}


// Ensures the ZeroClaw gateway has a usable default provider/model entry.
// `zeroclaw onboard --quick` cannot seed OAuth providers (it requires a legacy
// api-key), so after the auth profile import we write the providers block that
// the gateway expects (`providers.fallback` + `[providers.models.openai-codex]`)
// directly into <stateDir>/config.toml. Without this the gateway boots in
// `503 needs_onboarding` mode and chat endpoints are unusable.
export function seedZeroclawProviderModel(stateDir: string, model: string, wireApi: string): void {
  const configPath = join(stateDir, "config.toml");
  let configText = "";
  try {
    configText = readFileSync(configPath, "utf8");
  } catch {
    configText = "schema_version = 2\n";
  }
  if (configText.includes("[providers.models.openai-codex]")) return;

  if (/^\[providers\]\s*$/m.test(configText)) {
    configText = configText.replace(/^\[providers\]\s*$/m, '[providers]\nfallback = "openai-codex"');
  } else {
    configText += '\n[providers]\nfallback = "openai-codex"\n';
  }
  configText += [
    "",
    "[providers.models.openai-codex]",
    'provider = "openai-codex"',
    `model = "${model}"`,
    `wire_api = "${wireApi}"`,
    "requires_openai_auth = true",
    "",
  ].join("\n");
  writeFileSync(configPath, configText, { mode: 0o600 });
}
type SpawnSyncRunner = typeof spawnSync;

export function prepareRuntimeConfig(
  runtime: Runtime,
  env: NodeJS.ProcessEnv,
  stateDir: string,
  runCommand: SpawnSyncRunner = spawnSync,
): string | undefined {
  const codexAuth = requireTrimmed("OPENAI_CODEX_AUTH", env.OPENAI_CODEX_AUTH);
  const model = env.LLM_MODEL?.trim() || "gpt-5-codex";

  const redactError = (errStr: string): string => {
    let safe = errStr;
    const normalizedAuth = codexAuth.trim();
    if (normalizedAuth) {
      safe = safe.replaceAll(normalizedAuth, "***REDACTED***");
    }
    return safe;
  };

  const runChecked = (
    label: string,
    command: string,
    args: string[],
    commandEnv: NodeJS.ProcessEnv,
  ): void => {
    const result = runCommand(command, args, {
      env: commandEnv,
      stdio: "pipe",
      encoding: "utf8",
    });

    if (result.status !== 0) {
      const err = redactError(String(result.stderr || result.stdout || "unknown error"));
      throw new Error(`${label} failed: ${err.trim()}`);
    }
  };

  if (runtime === "zeroclaw") {
    mkdirSync(stateDir, { recursive: true });
    const authPath = join(stateDir, "auth.json");
    writeFileSync(authPath, codexAuth, { mode: 0o600 });

    runChecked("zeroclaw auth import", "zeroclaw", ["auth", "login", "--provider", "openai-codex", "--import", authPath], env);
    runChecked("zeroclaw auth refresh", "zeroclaw", ["auth", "refresh", "--provider", "openai-codex"], env);

    seedZeroclawProviderModel(stateDir, model, env.OPENAI_WIRE_API?.trim() || "responses");

    return undefined;
  }

  if (runtime === "nullclaw") {
    const home = env.HOME || env.JEO_WORKTREE || "/workspace";
    mkdirSync(join(home, ".config", "nullclaw"), { recursive: true });
    mkdirSync(join(home, ".local", "share"), { recursive: true });
    const runtimeEnv = {
      ...env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    };

    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "auth.json"), codexAuth, { mode: 0o600 });

    runChecked("nullclaw auth login", "nullclaw", ["auth", "login", "openai-codex", "--import-codex"], runtimeEnv);
    runChecked(
      "nullclaw onboard",
      "nullclaw",
      [
        "onboard",
        "--provider",
        "openai-codex",
        "--model",
        model,
        "--memory",
        "none",
      ],
      runtimeEnv,
    );
  }

  return undefined;
}
export function commandForRuntime(runtime: Runtime, childPort = DEFAULT_CHILD_PORT[runtime], configDir?: string): readonly [string, ...string[]] {
  return RUNTIME_COMMANDS[runtime](childPort, configDir);
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

export interface RuntimeDispatchPayload {
  workflowId: string;
  runtime: Runtime;
  role: Role;
  stage: Stage;
  request: string;
  headRef?: string;
}

function dispatchBodyTooLarge(req: Request): boolean {
  const contentLength = req.headers.get("content-length");
  if (!contentLength) return false;
  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed > MAX_DISPATCH_BODY_BYTES;
}


export function validateRuntimeDispatchPayload(
  payload: unknown,
  runtime: Runtime,
  role: Role,
): { ok: boolean; reason?: string; payload?: RuntimeDispatchPayload } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "dispatch payload must be an object" };
  }
  const obj = payload as Record<string, unknown>;
  for (const key of ["workflowId", "runtime", "role", "stage", "request"]) {
    if (typeof obj[key] !== "string" || (obj[key] as string).trim() === "") {
      return { ok: false, reason: `missing dispatch field: ${key}` };
    }
  }
  if (obj.runtime !== runtime) {
    return { ok: false, reason: `runtime mismatch: expected ${runtime}` };
  }
  if (obj.role !== role) {
    return { ok: false, reason: `role mismatch: expected ${role}` };
  }
  if ((obj.request as string).length > MAX_DISPATCH_REQUEST_CHARS) {
    return { ok: false, reason: `dispatch request exceeds ${MAX_DISPATCH_REQUEST_CHARS} characters` };
  }
  const stage = obj.stage as Stage;
  if (!(DISPATCHABLE_STAGES as readonly Stage[]).includes(stage)) {
    return { ok: false, reason: `stage ${stage} is not runtime-dispatchable` };
  }
  if (STAGE_TO_ROLE[stage] !== role) {
    return { ok: false, reason: `stage ${stage} does not belong to role ${role}` };
  }
  return { ok: true, payload: obj as unknown as RuntimeDispatchPayload };
}

function writeDispatchReceipt(stateDir: string, runtime: Runtime, role: Role, payload: RuntimeDispatchPayload, artifactPath: string): string {
  const dir = join(stateDir, "dispatch-receipts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${payload.workflowId}-${payload.stage}.json`);
  writeFileSync(path, JSON.stringify({
    runtime,
    role,
    workflowId: payload.workflowId,
    stage: payload.stage,
    request: payload.request,
    headRef: payload.headRef,
    artifactPath,
    completedAt: new Date().toISOString(),
  }, null, 2));
  return path;
}

export function executeStageWork(worktreeDir: string, payload: RuntimeDispatchPayload): string {
  const dir = join(worktreeDir, ".jeo-runtime-work");
  mkdirSync(dir, { recursive: true });
  const ext = payload.stage === "pr-review-schedule" ? "json" : "md";
  const path = join(dir, `${payload.workflowId}-${payload.stage}.${ext}`);
  if (ext === "json") {
    writeFileSync(path, JSON.stringify({
      workflowId: payload.workflowId,
      stage: payload.stage,
      request: payload.request,
      headRef: payload.headRef,
      scheduledAt: new Date().toISOString(),
    }, null, 2));
  } else {
    const title = payload.stage === "research-code" ? "Research and Code" : "Review";
    writeFileSync(
      path,
      `# ${title} Receipt\n\n- workflowId: ${payload.workflowId}\n- stage: ${payload.stage}\n- request: ${payload.request}\n- headRef: ${payload.headRef ?? "n/a"}\n- completedAt: ${new Date().toISOString()}\n`,
    );
  }
  return path;
}

export async function handleDispatchRequest(
  req: Request,
  runtime: Runtime,
  role: Role,
  dispatchSecret: string,
  stateDir = runtimeStateDir(runtime),
  worktreeDir = "/workspace",
): Promise<Response> {
  if (req.headers.get("x-runtime-dispatch-secret") !== dispatchSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  if (dispatchBodyTooLarge(req)) {
    return new Response(JSON.stringify({ error: "Dispatch payload too large" }), { status: 413, headers: { "Content-Type": "application/json" } });
  }

  let payload: unknown;
  try {
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_DISPATCH_BODY_BYTES) {
      return new Response(JSON.stringify({ error: "Dispatch payload too large" }), { status: 413, headers: { "Content-Type": "application/json" } });
    }
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const validation = validateRuntimeDispatchPayload(payload, runtime, role);
  if (!validation.ok || !validation.payload) {
    const status = validation.reason?.startsWith("dispatch request exceeds") ? 413 : 400;
    return new Response(JSON.stringify({ error: validation.reason }), { status, headers: { "Content-Type": "application/json" } });
  }

  const artifactPath = executeStageWork(worktreeDir, validation.payload);
  const receiptPath = writeDispatchReceipt(stateDir, runtime, role, validation.payload, artifactPath);
  return new Response(JSON.stringify({ success: true, receiptPath, artifactPath, runtime, role, stage: validation.payload.stage }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function startRuntime(
  runtime: Runtime,
  env: NodeJS.ProcessEnv = process.env,
  sourceFactory: (project: string, env: NodeJS.ProcessEnv) => SecretSource = (project, sourceEnv) => secretSourceFromEnv(sourceEnv, project),
): Promise<void> {
  const project = requireTrimmed("GCLOUD_PROJECT", env.GCLOUD_PROJECT);
  const childEnv = await resolveRuntimeEnvironment(runtime, env, sourceFactory(project, env));
  const role = requireTrimmed("JEO_ROLE", childEnv.JEO_ROLE) as Role;
  const dispatchSecret = requireTrimmed("JEO_RUNTIME_DISPATCH_SECRET", childEnv.JEO_RUNTIME_DISPATCH_SECRET);
  const worktreeDir = childEnv.JEO_WORKTREE || "/workspace";
  if (runtime === "nullclaw") {
    childEnv.HOME = worktreeDir;
    childEnv.XDG_CONFIG_HOME = join(worktreeDir, ".config");
    childEnv.XDG_DATA_HOME = join(worktreeDir, ".local", "share");
  }
  const stateDir = runtimeStateDir(runtime);
  const port = Number(env.JEO_RUNTIME_PORT ?? 8787);
  const childPort = runtimeChildPort(runtime, env);
  const childConfigDir = prepareRuntimeConfig(runtime, childEnv, stateDir);
  delete childEnv.OPENAI_CODEX_AUTH;
  const [command, ...args] = commandForRuntime(runtime, childPort, childConfigDir);

  let child: ChildProcessWithoutNullStreams | null = spawn(command, args, {
    env: childEnv,
    stdio: "pipe",
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        const ok = await childReady(childPort);
        return new Response(JSON.stringify({ ok, runtime, role, childPort }), {
          status: ok ? 200 : 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/dispatch") {
        return handleDispatchRequest(req, runtime, role, dispatchSecret, stateDir, worktreeDir);
      }
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const cleanupSignals = bindTerminationHandlers(
    (signal, handler) => process.on(signal, handler),
    (signal, handler) => process.off(signal, handler),
    (signal) => shutdownRuntimeChild(child, server, signal),
  );

  child.on("error", (err) => {
    cleanupSignals();
    server.stop(true);
    console.error(`[runtime-start] ${runtime}/${role} child error:`, err);
    process.exit(1);
  });
  child.on("close", (code) => {
    cleanupSignals();
    server.stop(true);
    process.exit(code ?? 1);
  });

  await new Promise<void>(() => undefined);
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

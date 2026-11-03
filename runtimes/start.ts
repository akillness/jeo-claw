import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSecretsForRole, secretSourceFromEnv, type Role, type SecretSource } from "../secrets/loader.ts";
import { DISPATCHABLE_STAGES, STAGE_TO_ROLE, type Runtime, type Stage } from "../glue/contract.ts";


const MAX_DISPATCH_BODY_BYTES = 64 * 1024;
const MAX_DISPATCH_REQUEST_CHARS = 4000;
const MAX_RUNTIME_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_RUNTIME_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

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

export function configureRuntimePaths(runtime: Runtime, env: NodeJS.ProcessEnv, worktreeDir: string, stateDir: string): void {
  if (runtime === "nullclaw") {
    env.HOME = worktreeDir;
    env.XDG_CONFIG_HOME = join(worktreeDir, ".config");
    env.XDG_DATA_HOME = join(worktreeDir, ".local", "share");
    env.NULLCLAW_HOME = stateDir;
  }
}

export function installBundledSkills(worktreeDir: string, sourceDir = "/opt/jeo-skills"): void {
  if (!existsSync(sourceDir)) throw new Error(`bundled jeo-skills are missing: ${sourceDir}`);
  const destination = join(worktreeDir, "skills");
  mkdirSync(destination, { recursive: true });
  cpSync(sourceDir, destination, { recursive: true, errorOnExist: false, force: false });
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
export function seedZeroclawProviderModel(stateDir: string, model: string, wireApi: string, role = "default", workspace = "/workspace"): void {
  const configPath = join(stateDir, "config.toml");
  if (!/^[a-zA-Z0-9._/-]+$/.test(model) || !/^[a-zA-Z0-9._/-]+$/.test(wireApi) || !/^[a-zA-Z0-9._-]+$/.test(role)) {
    throw new Error("Invalid ZeroClaw model or wire API");
  }
  try {
    const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as {
      schema_version?: number;
      providers?: { models?: { openai?: Record<string, { model?: string; wire_api?: string; requires_openai_auth?: boolean }> } };
      agents?: Record<string, { model_provider?: string; risk_profile?: string; runtime_profile?: string; workspace?: { path?: string } }>;
    };
    const provider = config.providers?.models?.openai?.codex;
    const agent = config.agents?.[role];
    if (config.schema_version === 3 && provider?.model === model && provider.wire_api === wireApi && provider.requires_openai_auth === true && agent?.model_provider === "openai.codex" && agent.risk_profile === "supervised" && agent.runtime_profile === "default" && agent.workspace?.path === workspace) return;
    throw new Error("Existing ZeroClaw configuration requires explicit provider configuration");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let configText = "schema_version = 3\n";
  configText += [
    "",
    "[providers.models.openai.codex]",
    `model = "${model}"`,
    `wire_api = "${wireApi}"`,
    "requires_openai_auth = true",
    "",
    `[agents.${role}]`,
    "enabled = true",
    'model_provider = "openai.codex"',
    'risk_profile = "supervised"',
    'runtime_profile = "default"',
    "",
    `[agents.${role}.workspace]`,
    `path = ${JSON.stringify(workspace)}`,
    "",
    "[risk_profiles.supervised]",
    'level = "supervised"',
    "",
    "[runtime_profiles.default]",
    "",
  ].join("\n");
  writeFileSync(configPath, configText, { mode: 0o600, flag: "wx" });
}
type SpawnSyncRunner = typeof spawnSync;

export function prepareRuntimeConfig(
  runtime: Runtime,
  env: NodeJS.ProcessEnv,
  stateDir: string,
  runCommand: SpawnSyncRunner = spawnSync,
): string | undefined {
  const model = env.LLM_MODEL?.trim() || "gpt-6.1-terra";

  // Child diagnostics may contain individual credential fields, not only the
  // serialized auth document. Never relay them across the startup boundary.

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
      throw new Error(`${label} failed (exit ${result.status ?? "unknown"})`);
    }
  };

  if (runtime === "zeroclaw") {
    mkdirSync(stateDir, { recursive: true });
    seedZeroclawProviderModel(stateDir, model, env.OPENAI_WIRE_API?.trim() || "responses", env.JEO_ROLE?.trim() || "default", env.JEO_WORKTREE?.trim() || "/workspace");
    const profilesPath = join(stateDir, "auth-profiles.json");
    let profilesText: string | undefined;
    try {
      profilesText = readFileSync(profilesPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (profilesText === undefined) {
      const codexAuth = requireTrimmed("OPENAI_CODEX_AUTH", env.OPENAI_CODEX_AUTH);
      const importDir = mkdtempSync(join(stateDir, ".auth-import-"));
      try {
        const authPath = join(importDir, "auth.json");
        writeFileSync(authPath, codexAuth, { mode: 0o600, flag: "wx" });
        runChecked("zeroclaw auth import", "zeroclaw", ["--config-dir", stateDir, "auth", "login", "--model-provider", "openai-codex", "--import", authPath], env);
      } finally {
        rmSync(importDir, { recursive: true, force: true });
      }
    } else {
      let valid = false;
      try {
        const data = JSON.parse(profilesText);
        const active = data.active_profiles?.["openai-codex"];
        const profile = typeof active === "string" ? data.profiles?.[active] : undefined;
        valid = profile?.model_provider === "openai-codex" && profile?.kind === "oauth" && typeof profile?.access_token === "string" && profile.access_token.length > 0;
      } catch {
        // An unreadable store must not be replaced with stale credentials.
      }
      if (!valid) throw new Error("Existing ZeroClaw OAuth profile is invalid or missing");
    }


    return stateDir;
  }

  if (runtime === "nullclaw") {
    const home = env.HOME || env.JEO_WORKTREE || "/workspace";
    const configDir = env.NULLCLAW_HOME ?? stateDir;
    const readOptional = (path: string): string | undefined => {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    };
    const existingAuth = readOptional(join(configDir, "auth.json"));
    const existingConfig = readOptional(join(configDir, "config.json"));
    const validateState = (authText: string | undefined, configText: string | undefined): void => {
      try {
        const auth = JSON.parse(authText ?? "null")?.["openai-codex"];
        const config = JSON.parse(configText ?? "null");
        const validToken = typeof auth?.access_token === "string" && auth.access_token.length > 0;
        const validExpiry = auth?.expires_at === undefined || (typeof auth.expires_at === "number" && Number.isFinite(auth.expires_at) && (auth.expires_at === 0 || auth.expires_at > Date.now() / 1000 + 300 || (typeof auth.refresh_token === "string" && auth.refresh_token.length > 0)));
        if (!validToken || !validExpiry || config?.agents?.defaults?.model?.primary !== `openai-codex/${model}`) throw new Error();
      } catch {
        throw new Error("NullClaw OAuth profile or configuration is invalid or incompatible");
      }
    };
    if (existingAuth !== undefined || existingConfig !== undefined) {
      validateState(existingAuth, existingConfig);
      return undefined;
    }
    if (readOptional(join(home, ".nullclaw", "auth.json")) !== undefined ||
        readOptional(join(home, ".nullclaw", "config.json")) !== undefined ||
        readOptional(join(home, ".codex", "auth.json")) !== undefined) {
      throw new Error("Existing workspace credentials or configuration require explicit NullClaw migration");
    }
    const codexAuth = requireTrimmed("OPENAI_CODEX_AUTH", env.OPENAI_CODEX_AUTH);
    mkdirSync(join(home, ".config", "nullclaw"), { recursive: true });
    mkdirSync(join(home, ".local", "share"), { recursive: true });
    const runtimeEnv = {
      ...env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      NULLCLAW_HOME: configDir,
    };


    const importHome = mkdtempSync(join(tmpdir(), "jeo-nullclaw-auth-"));
    try {
      const codexDir = join(importHome, ".codex");
      mkdirSync(codexDir, { mode: 0o700 });
      writeFileSync(join(codexDir, "auth.json"), codexAuth, { mode: 0o600, flag: "wx" });
      runChecked("nullclaw auth login", "nullclaw", ["auth", "login", "openai-codex", "--import-codex"], {
        ...runtimeEnv,
        HOME: importHome,
        NULLCLAW_HOME: configDir,
      });
    } finally {
      rmSync(importHome, { recursive: true, force: true });
    }
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
    validateState(readOptional(join(configDir, "auth.json")), readOptional(join(configDir, "config.json")));
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

export interface NativeRuntimeResult {
  output: string;
  command: string;
}

type NativeRuntimeRunner = (
  runtime: Runtime,
  payload: RuntimeDispatchPayload,
  options: { stateDir: string; worktreeDir: string; env: NodeJS.ProcessEnv },
) => Promise<NativeRuntimeResult>;

function safeArtifactPart(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

export function nativeRuntimeCommand(
  runtime: Runtime,
  payload: RuntimeDispatchPayload,
  stateDir: string,
): readonly [string, ...string[]] {
  const prompt = [
    `Workflow: ${payload.workflowId}`,
    `Role: ${payload.role}`,
    `Stage: ${payload.stage}`,
    payload.headRef ? `Head ref: ${payload.headRef}` : undefined,
    "Use the installed jeo-skills when relevant. Perform the requested work in the current workspace and return a concise evidence-backed result.",
    `Request: ${payload.request}`,
  ].filter((line): line is string => line !== undefined).join("\n");

  return runtime === "zeroclaw"
    ? ["zeroclaw", "--config-dir", stateDir, "agent", "-a", payload.role, "-m", prompt]
    : ["nullclaw", "agent", "-m", prompt];
}

export async function runNativeRuntime(
  runtime: Runtime,
  payload: RuntimeDispatchPayload,
  options: { stateDir: string; worktreeDir: string; env: NodeJS.ProcessEnv },
): Promise<NativeRuntimeResult> {
  const [command, ...args] = nativeRuntimeCommand(runtime, payload, options.stateDir);
  const timeoutMs = Number(options.env.JEO_RUNTIME_EXECUTION_TIMEOUT_MS ?? DEFAULT_RUNTIME_EXECUTION_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > DEFAULT_RUNTIME_EXECUTION_TIMEOUT_MS) {
    throw new Error("invalid runtime execution timeout");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.worktreeDir,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        const output = stdout.toString("utf8").trim();
        if (!output) reject(new Error(`${runtime} returned no result`));
        else resolve({ output, command });
      }
    };
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const next = Buffer.concat([current, chunk]);
      if (next.byteLength > MAX_RUNTIME_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error(`${runtime} output exceeded ${MAX_RUNTIME_OUTPUT_BYTES} bytes`));
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", () => finish(new Error(`${runtime} execution failed to start`)));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new Error(`${runtime} execution failed (exit ${code ?? "unknown"})`));
        return;
      }
      finish();
    });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${runtime} execution timed out`));
    }, timeoutMs);
  });
}

function dispatchBodyTooLarge(req: Request): boolean {
  const contentLength = req.headers.get("content-length");
  if (!contentLength) return false;
  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed > MAX_DISPATCH_BODY_BYTES;
}


async function readDispatchBody(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Dispatch request aborted"));
    if (req.signal.aborted) onAbort();
    else req.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_DISPATCH_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (onAbort) req.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
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


export async function handleDispatchRequest(
  req: Request,
  runtime: Runtime,
  role: Role,
  dispatchSecret: string,
  stateDir = runtimeStateDir(runtime),
  worktreeDir = "/workspace",
  runner: NativeRuntimeRunner = runNativeRuntime,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  if (req.headers.get("x-runtime-dispatch-secret") !== dispatchSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  if (dispatchBodyTooLarge(req)) {
    return new Response(JSON.stringify({ error: "Dispatch payload too large" }), { status: 413, headers: { "Content-Type": "application/json" } });
  }

  let payload: unknown;
  try {
    const rawBody = await readDispatchBody(req);
    if (rawBody === null) {
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

  try {
    const validPayload = validation.payload;
    safeArtifactPart(validPayload.workflowId, "workflow id");
    const result = await runner(runtime, validPayload, { stateDir, worktreeDir, env: runtimeEnv });
    const artifactDir = join(worktreeDir, ".jeo-runtime-work");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, `${validPayload.workflowId}-${validPayload.stage}.md`);
    writeFileSync(artifactPath, `${result.output}\n`, { mode: 0o600, flag: "wx" });
    return new Response(JSON.stringify({
      ok: true,
      runtime,
      role,
      stage: validPayload.stage,
      model: runtimeEnv.LLM_MODEL,
      nativeCommand: result.command,
      artifact: artifactPath,
      output: result.output,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Runtime execution failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export function acquireRuntimeProcess(
  serve: () => StoppableServer,
  spawnChild: () => ChildProcessWithoutNullStreams,
  onError: (error: Error) => void,
): { server: StoppableServer; child: ChildProcessWithoutNullStreams } {
  const server = serve();
  try {
    const child = spawnChild();
    child.on("error", onError);
    return { server, child };
  } catch (error) {
    server.stop(true);
    throw error;
  }
}

export async function startRuntime(
  runtime: Runtime,
  env: NodeJS.ProcessEnv = process.env,
  sourceFactory: (project: string, env: NodeJS.ProcessEnv) => SecretSource = (project, sourceEnv) => secretSourceFromEnv(sourceEnv, project),
): Promise<void> {
  if (env.JEO_CONTROL_MODE !== undefined && env.JEO_CONTROL_MODE !== "normal") {
    throw new Error(env.JEO_CONTROL_MODE === "probe-only"
      ? "native probe runtime is unavailable until native tool denial is verified"
      : "invalid JEO_CONTROL_MODE");
  }
  const project = requireTrimmed("GCLOUD_PROJECT", env.GCLOUD_PROJECT);
  const childEnv = await resolveRuntimeEnvironment(runtime, env, sourceFactory(project, env));
  const role = requireTrimmed("JEO_ROLE", childEnv.JEO_ROLE) as Role;
  const dispatchSecret = requireTrimmed("JEO_RUNTIME_DISPATCH_SECRET", childEnv.JEO_RUNTIME_DISPATCH_SECRET);
  const worktreeDir = childEnv.JEO_WORKTREE || "/workspace";
  const stateDir = runtimeStateDir(runtime);
  configureRuntimePaths(runtime, childEnv, worktreeDir, stateDir);
  installBundledSkills(worktreeDir);
  const port = Number(env.JEO_RUNTIME_PORT ?? 8787);
  const childPort = runtimeChildPort(runtime, env);
  const childConfigDir = prepareRuntimeConfig(runtime, childEnv, stateDir);
  delete childEnv.OPENAI_CODEX_AUTH;
  const [command, ...args] = commandForRuntime(runtime, childPort, childConfigDir);

  const { server, child } = acquireRuntimeProcess(() => Bun.serve({
    port,
    maxRequestBodySize: MAX_DISPATCH_BODY_BYTES,
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
        return handleDispatchRequest(req, runtime, role, dispatchSecret, stateDir, worktreeDir, runNativeRuntime, childEnv);
      }
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  }), () => spawn(command, args, { env: childEnv, stdio: "pipe" }), (err) => {
    cleanupSignals();
    server.stop(true);
    console.error(`[runtime-start] ${runtime}/${role} child error:`, err);
    process.exit(1);
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  const cleanupSignals = bindTerminationHandlers(
    (signal, handler) => process.on(signal, handler),
    (signal, handler) => process.off(signal, handler),
    (signal) => shutdownRuntimeChild(child, server, signal),
  );

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

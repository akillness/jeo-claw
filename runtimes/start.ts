import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GcloudSecretSource, loadSecretsForRole, type Role, type SecretSource } from "../secrets/loader.ts";
import { STAGE_TO_ROLE, type Runtime, type Stage } from "../glue/contract.ts";

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

function runtimeStateDir(runtime: Runtime): string {
  return runtime === "zeroclaw" ? "/root/.zeroclaw" : "/root/.config/nullclaw";
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

export interface RuntimeDispatchPayload {
  workflowId: string;
  runtime: Runtime;
  role: Role;
  stage: Stage;
  request: string;
  headRef?: string;
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
  const stage = obj.stage as Stage;
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

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const validation = validateRuntimeDispatchPayload(payload, runtime, role);
  if (!validation.ok || !validation.payload) {
    return new Response(JSON.stringify({ error: validation.reason }), { status: 400, headers: { "Content-Type": "application/json" } });
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
  sourceFactory: (project: string) => SecretSource = (project) => new GcloudSecretSource(project),
): Promise<void> {
  const project = requireTrimmed("GCLOUD_PROJECT", env.GCLOUD_PROJECT);
  const childEnv = await resolveRuntimeEnvironment(runtime, env, sourceFactory(project));
  const role = requireTrimmed("JEO_ROLE", childEnv.JEO_ROLE) as Role;
  const dispatchSecret = requireTrimmed("JEO_RUNTIME_DISPATCH_SECRET", childEnv.JEO_RUNTIME_DISPATCH_SECRET);
  const worktreeDir = childEnv.JEO_WORKTREE || "/workspace";
  const port = Number(env.JEO_RUNTIME_PORT ?? 8787);
  const [command, ...args] = commandForRuntime(runtime);

  let child: ChildProcessWithoutNullStreams | null = spawn(command, args, {
    env: childEnv,
    stdio: "pipe",
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on("error", (err) => {
    console.error(`[runtime-start] ${runtime}/${role} child error:`, err);
    process.exit(1);
  });
  child.on("close", (code) => {
    process.exit(code ?? 1);
  });

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, runtime, role }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/dispatch") {
        return handleDispatchRequest(req, runtime, role, dispatchSecret, runtimeStateDir(runtime), worktreeDir);
      }
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
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

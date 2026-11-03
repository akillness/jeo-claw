// Least-privilege secret loader: pulls per-role and per-control-service credentials from gcloud Secret Manager.
// Invariants:
//  - Every runtime role gets only read-only startup credentials plus the runtime-dispatch secret.
//  - Write-capable GitHub credentials are released separately for approved write actions.
//  - Control services receive only control-plane credentials, never role GitHub/OpenAI-Codex-OAuth bundles.
//  - Missing or blank required secrets are a hard failure.
//  - Plaintext secret values and upstream secret-store messages are never logged or embedded in errors.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export type Role =
  | "researcher-coder"
  | "reviewer"
  | "pr-creator"
  | "pr-review-scheduler"
  | "merger";

export type ControlService = "glue-webhook" | "discord-bot";
export type Scope = "read" | "write";

type SecretSpec = { name: string; scope: Scope };

const WRITE_SECRET: SecretSpec = { name: "github-token-rw", scope: "write" };
const RUNTIME_DISPATCH_SECRET: SecretSpec = { name: "runtime-dispatch-secret", scope: "read" };
const OPENAI_OAUTH_SECRET: SecretSpec = { name: "openai-codex-oauth", scope: "read" };
const WRITE_ELIGIBLE_ROLES = new Set<Role>(["pr-creator", "merger"]);

const GENERATED_SHARED_SECRETS = new Set(["github-webhook-secret", "control-event-secret", "runtime-dispatch-secret", "status-relay-secret"]);
const MIN_SHARED_SECRET_LENGTH = 24;

export const ROLE_SECRETS: Record<Role, SecretSpec[]> = {
  "researcher-coder": [
    OPENAI_OAUTH_SECRET,
    { name: "github-token-ro", scope: "read" },
    RUNTIME_DISPATCH_SECRET,
  ],
  reviewer: [
    OPENAI_OAUTH_SECRET,
    { name: "github-token-ro", scope: "read" },
    RUNTIME_DISPATCH_SECRET,
  ],
  "pr-creator": [
    OPENAI_OAUTH_SECRET,
    { name: "github-token-ro", scope: "read" },
    RUNTIME_DISPATCH_SECRET,
  ],
  "pr-review-scheduler": [
    OPENAI_OAUTH_SECRET,
    { name: "github-token-ro", scope: "read" },
    RUNTIME_DISPATCH_SECRET,
  ],
  merger: [
    OPENAI_OAUTH_SECRET,
    { name: "github-token-ro", scope: "read" },
    RUNTIME_DISPATCH_SECRET,
  ],
};

export const CONTROL_SECRETS: Record<ControlService, SecretSpec[]> = {
  "glue-webhook": [
    { name: "github-webhook-secret", scope: "read" },
    { name: "control-event-secret", scope: "read" },
    { name: "status-relay-secret", scope: "read" },
    RUNTIME_DISPATCH_SECRET,
  ],
  "discord-bot": [
    { name: "discord-bot-token", scope: "read" },
    { name: "control-event-secret", scope: "read" },
    { name: "status-relay-secret", scope: "read" },
  ],
};

export const ENV_FOR: Record<string, string> = {
  "openai-codex-oauth": "OPENAI_CODEX_AUTH",
  "github-token-ro": "GITHUB_TOKEN",
  "github-token-rw": "GITHUB_TOKEN",
  "github-webhook-secret": "GITHUB_WEBHOOK_SECRET",
  "discord-bot-token": "DISCORD_BOT_TOKEN",
  "control-event-secret": "JEO_CONTROL_EVENT_SECRET",
  "status-relay-secret": "JEO_STATUS_RELAY_SECRET",
  "runtime-dispatch-secret": "JEO_RUNTIME_DISPATCH_SECRET",
};

export interface SecretSource {
  access(secretId: string, signal?: AbortSignal): Promise<string>;
}

export class SecretAccessAbortedError extends Error {
  constructor() { super("Secret access aborted"); }
}

export class SecretAccessCleanupError extends Error {
  constructor() { super("Secret subprocess cleanup failed"); }
}

export class GcloudSecretSource implements SecretSource {
  constructor(private project: string, private timeoutMs = 30_000) {}
  access(secretId: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new SecretAccessAbortedError());
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const p = spawn("gcloud", [
      "secrets", "versions", "access", "latest",
      `--secret=${secretId}`, `--project=${this.project}`,
    ], { detached: process.platform !== "win32" });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      cleanupTimer = setTimeout(() => reject(new SecretAccessCleanupError()), 5_000);
      if (p.exitCode !== null || p.signalCode !== null) return;
      try {
        if (process.platform !== "win32" && p.pid !== undefined) process.kill(-p.pid, "SIGKILL");
        else p.kill("SIGKILL");
      } catch {
        // The child may have already exited; close remains the authority for reaping.
      }
    };
    const abort = () => stop(new SecretAccessAbortedError());
    const timer = setTimeout(() => stop(new Error(`gcloud access timed out for ${secretId}`)), this.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    p.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      outputBytes += chunk.length;
      if (outputBytes > 1_048_576) stop(new Error(`gcloud access output too large for ${secretId}`));
      else chunks.push(chunk);
    });
    p.stderr.on("data", () => undefined);
    p.on("error", () => stop(new Error(`gcloud spawn failed for ${secretId}`)));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code === 0) resolve(Buffer.concat(chunks).toString("utf8").trim());
      else reject(new Error(`gcloud access failed for ${secretId} (exit ${code})`));
    });
    return promise;
  }
}

export class FileSecretSource implements SecretSource {
  private readonly secrets: Record<string, string>;

  constructor(path: string) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) throw new Error();
      this.secrets = parsed as Record<string, string>;
    } catch {
      throw new Error("Unable to load secret file");
    }
  }

  async access(secretId: string): Promise<string> {
    const value = this.secrets[secretId];
    if (value === undefined) {
      throw new Error(`file secret missing for ${secretId}`);
    }
    return value;
  }
}

export function secretSourceFromEnv(env: NodeJS.ProcessEnv, project: string): SecretSource {
  const mode = env.JEO_SECRET_SOURCE?.trim().toLowerCase();
  if (mode === "file") {
    const path = env.JEO_SECRETS_FILE?.trim();
    if (!path) throw new MissingSecretError("JEO_SECRETS_FILE is required when JEO_SECRET_SOURCE=file");
    return new FileSecretSource(path);
  }
  return new GcloudSecretSource(project);
}

export class MissingSecretError extends Error {}

function requireTrimmedSecret(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new MissingSecretError(`${label} resolved empty`);
  }
  return trimmed;
}

function validateSecretValue(spec: SecretSpec, label: string, value: string): string {
  const trimmed = requireTrimmedSecret(label, value);
  if (GENERATED_SHARED_SECRETS.has(spec.name) && trimmed.length < MIN_SHARED_SECRET_LENGTH) {
    throw new MissingSecretError(`${label} must be at least ${MIN_SHARED_SECRET_LENGTH} characters`);
  }
  return trimmed;
}

async function loadSpecs(
  label: string,
  specs: SecretSpec[],
  source: SecretSource,
  opts: { prefix: string; signal?: AbortSignal },
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const spec of specs) {
    const secretId = `${opts.prefix}-${spec.name}`;
    let value: string;
    try {
      if (opts.signal?.aborted) throw new SecretAccessAbortedError();
      value = await source.access(secretId, opts.signal);
      if (opts.signal?.aborted) throw new SecretAccessAbortedError();
    } catch (error) {
      if (error instanceof SecretAccessCleanupError) throw error;
      if (opts.signal?.aborted || error instanceof SecretAccessAbortedError) throw new SecretAccessAbortedError();
      throw new MissingSecretError(`${label}: cannot load ${secretId}`);
    }
    const envVarName = ENV_FOR[spec.name];
    if (!envVarName) {
      throw new Error(`unknown secret spec name: ${spec.name}`);
    }
    env[envVarName] = validateSecretValue(spec, `${label}: ${secretId}`, value);
  }
  return env;
}

export async function loadSecretsForRole(
  role: Role,
  source: SecretSource,
  opts: { prefix: string; signal?: AbortSignal },
): Promise<Record<string, string>> {
  const specs = ROLE_SECRETS[role];
  if (!specs) throw new Error(`unknown role: ${role}`);
  return loadSpecs(`role ${role}`, specs, source, opts);
}

export async function loadWriteSecretsForRole(
  role: Role,
  source: SecretSource,
  opts: { prefix: string; signal?: AbortSignal },
): Promise<Record<string, string>> {
  if (!WRITE_ELIGIBLE_ROLES.has(role)) {
    throw new MissingSecretError(`role ${role}: no write secret scope`);
  }
  return loadSpecs(`write role ${role}`, [WRITE_SECRET], source, opts);
}

export async function loadSecretsForControl(
  service: ControlService,
  source: SecretSource,
  opts: { prefix: string; signal?: AbortSignal },
): Promise<Record<string, string>> {
  const specs = CONTROL_SECRETS[service];
  if (!specs) throw new Error(`unknown control service: ${service}`);
  const env = await loadSpecs(`control ${service}`, specs, source, opts);
  if ([env.JEO_CONTROL_EVENT_SECRET, env.GITHUB_WEBHOOK_SECRET, env.JEO_RUNTIME_DISPATCH_SECRET, env.DISCORD_BOT_TOKEN].some((value) => value !== undefined && value === env.JEO_STATUS_RELAY_SECRET)) {
    throw new MissingSecretError(`control ${service}: status relay secret must differ from other control secrets`);
  }
  return env;
}

export function hasWriteScope(role: Role): boolean {
  return WRITE_ELIGIBLE_ROLES.has(role);
}

export function controlSecretNames(service: ControlService): string[] {
  return CONTROL_SECRETS[service].map((s) => s.name);
}

export function redact(s: string, secrets: string[]): string {
  let r = s;
  const uniqueSecrets = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const v of uniqueSecrets) r = r.split(v).join("***REDACTED***");
  return r;
}

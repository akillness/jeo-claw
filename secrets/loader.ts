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

const GENERATED_SHARED_SECRETS = new Set(["github-webhook-secret", "control-event-secret", "runtime-dispatch-secret"]);
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
    RUNTIME_DISPATCH_SECRET,
  ],
  "discord-bot": [
    { name: "discord-bot-token", scope: "read" },
    { name: "control-event-secret", scope: "read" },
  ],
};

export const ENV_FOR: Record<string, string> = {
  "openai-codex-oauth": "OPENAI_CODEX_AUTH",
  "github-token-ro": "GITHUB_TOKEN",
  "github-token-rw": "GITHUB_TOKEN",
  "github-webhook-secret": "GITHUB_WEBHOOK_SECRET",
  "discord-bot-token": "DISCORD_BOT_TOKEN",
  "control-event-secret": "JEO_CONTROL_EVENT_SECRET",
  "runtime-dispatch-secret": "JEO_RUNTIME_DISPATCH_SECRET",
};

export interface SecretSource {
  access(secretId: string): Promise<string>;
}

export class GcloudSecretSource implements SecretSource {
  constructor(private project: string) {}
  access(secretId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn("gcloud", [
        "secrets",
        "versions",
        "access",
        "latest",
        `--secret=${secretId}`,
        `--project=${this.project}`,
      ]);
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", () => undefined);
      p.on("close", (code) =>
        code === 0 ? resolve(out.trim()) : reject(new Error(`gcloud access failed for ${secretId} (exit ${code})`)),
      );
      p.on("error", () => reject(new Error(`gcloud spawn failed for ${secretId}`)));
    });
  }
}

export class FileSecretSource implements SecretSource {
  private readonly secrets: Record<string, string>;

  constructor(path: string) {
    const raw = readFileSync(path, "utf8");
    this.secrets = JSON.parse(raw) as Record<string, string>;
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
  opts: { prefix: string },
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const spec of specs) {
    const secretId = `${opts.prefix}-${spec.name}`;
    let value: string;
    try {
      value = await source.access(secretId);
    } catch {
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
  opts: { prefix: string },
): Promise<Record<string, string>> {
  const specs = ROLE_SECRETS[role];
  if (!specs) throw new Error(`unknown role: ${role}`);
  return loadSpecs(`role ${role}`, specs, source, opts);
}

export async function loadWriteSecretsForRole(
  role: Role,
  source: SecretSource,
  opts: { prefix: string },
): Promise<Record<string, string>> {
  if (!WRITE_ELIGIBLE_ROLES.has(role)) {
    throw new MissingSecretError(`role ${role}: no write secret scope`);
  }
  return loadSpecs(`write role ${role}`, [WRITE_SECRET], source, opts);
}

export async function loadSecretsForControl(
  service: ControlService,
  source: SecretSource,
  opts: { prefix: string },
): Promise<Record<string, string>> {
  const specs = CONTROL_SECRETS[service];
  if (!specs) throw new Error(`unknown control service: ${service}`);
  return loadSpecs(`control ${service}`, specs, source, opts);
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

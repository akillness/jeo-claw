// Least-privilege secret loader: pulls per-role and per-control-service credentials from gcloud Secret Manager.
// Invariants:
//  - Every runtime role gets only read-only startup credentials.
//  - Write-capable GitHub credentials are released separately for approved write actions.
//  - Control services receive only control-plane credentials, never role GitHub/OpenAI bundles.
//  - Missing or blank required secrets are a hard failure.
//  - Plaintext secret values and upstream secret-store messages are never logged or embedded in errors.
import { spawn } from "node:child_process";

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
const WRITE_ELIGIBLE_ROLES = new Set<Role>(["pr-creator", "merger"]);

export const ROLE_SECRETS: Record<Role, SecretSpec[]> = {
  "researcher-coder": [
    { name: "openai-api-key", scope: "read" },
    { name: "github-token-ro", scope: "read" },
  ],
  reviewer: [
    { name: "openai-api-key", scope: "read" },
    { name: "github-token-ro", scope: "read" },
  ],
  "pr-creator": [
    { name: "openai-api-key", scope: "read" },
    { name: "github-token-ro", scope: "read" },
  ],
  "pr-review-scheduler": [
    { name: "openai-api-key", scope: "read" },
    { name: "github-token-ro", scope: "read" },
  ],
  merger: [
    { name: "openai-api-key", scope: "read" },
    { name: "github-token-ro", scope: "read" },
  ],
};

export const CONTROL_SECRETS: Record<ControlService, SecretSpec[]> = {
  "glue-webhook": [
    { name: "github-webhook-secret", scope: "read" },
    { name: "control-event-secret", scope: "read" },
  ],
  "discord-bot": [
    { name: "discord-bot-token", scope: "read" },
    { name: "control-event-secret", scope: "read" },
  ],
};

export const ENV_FOR: Record<string, string> = {
  "openai-api-key": "OPENAI_API_KEY",
  "github-token-ro": "GITHUB_TOKEN",
  "github-token-rw": "GITHUB_TOKEN",
  "github-webhook-secret": "GITHUB_WEBHOOK_SECRET",
  "discord-bot-token": "DISCORD_BOT_TOKEN",
  "control-event-secret": "JEO_CONTROL_EVENT_SECRET",
};

export interface SecretSource {
  access(secretId: string): Promise<string>;
}

/** Reads secrets from gcloud Secret Manager via the gcloud CLI (Secret Manager use ONLY). */
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

export class MissingSecretError extends Error {}

function requireTrimmedSecret(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new MissingSecretError(`${label} resolved empty`);
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
    env[envVarName] = requireTrimmedSecret(`${label}: ${secretId}`, value);
  }
  return env;
}

/** Loads the read-only startup env for a role. */
export async function loadSecretsForRole(
  role: Role,
  source: SecretSource,
  opts: { prefix: string },
): Promise<Record<string, string>> {
  const specs = ROLE_SECRETS[role];
  if (!specs) throw new Error(`unknown role: ${role}`);
  return loadSpecs(`role ${role}`, specs, source, opts);
}

/** Loads write-capable GitHub credentials for an approved write role/action broker. */
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

/** Loads only control-plane credentials for a control service. */
export async function loadSecretsForControl(
  service: ControlService,
  source: SecretSource,
  opts: { prefix: string },
): Promise<Record<string, string>> {
  const specs = CONTROL_SECRETS[service];
  if (!specs) throw new Error(`unknown control service: ${service}`);
  return loadSpecs(`control ${service}`, specs, source, opts);
}

/** True if a role is eligible for mediated write-scope secrets. */
export function hasWriteScope(role: Role): boolean {
  return WRITE_ELIGIBLE_ROLES.has(role);
}

export function controlSecretNames(service: ControlService): string[] {
  return CONTROL_SECRETS[service].map((s) => s.name);
}

/** Redacts secret values from any string for safe logging. */
export function redact(s: string, secrets: string[]): string {
  let r = s;
  for (const v of secrets) if (v) r = r.split(v).join("***REDACTED***");
  return r;
}

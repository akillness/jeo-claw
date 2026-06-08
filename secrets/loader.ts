// Least-privilege secret loader: pulls per-role and per-control-service credentials from gcloud Secret Manager.
// Invariants:
//  - Each role receives ONLY the secrets its job requires (least privilege).
//  - Only pr-creator / merger receive a write-scoped GitHub token; all others get read-only.
//  - Control services receive only control-plane credentials, never role GitHub/OpenAI bundles.
//  - Missing required secrets are a hard failure (never silently empty).
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
    { name: "github-token-rw", scope: "write" },
  ],
  "pr-review-scheduler": [
    { name: "openai-api-key", scope: "read" },
    { name: "github-token-ro", scope: "read" },
  ],
  merger: [
    { name: "openai-api-key", scope: "read" },
    { name: "github-token-rw", scope: "write" },
  ],
};

export const CONTROL_SECRETS: Record<ControlService, SecretSpec[]> = {
  "glue-webhook": [
    { name: "github-webhook-secret", scope: "read" },
  ],
  "discord-bot": [
    { name: "discord-bot-token", scope: "read" },
  ],
};

export const ENV_FOR: Record<string, string> = {
  "openai-api-key": "OPENAI_API_KEY",
  "github-token-ro": "GITHUB_TOKEN",
  "github-token-rw": "GITHUB_TOKEN",
  "github-webhook-secret": "GITHUB_WEBHOOK_SECRET",
  "discord-bot-token": "DISCORD_BOT_TOKEN",
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
    if (!value) throw new MissingSecretError(`${label}: ${secretId} resolved empty`);
    const envVarName = ENV_FOR[spec.name];
    if (!envVarName) {
      throw new Error(`unknown secret spec name: ${spec.name}`);
    }
    env[envVarName] = value;
  }
  return env;
}

/** Loads the least-privilege secret env for a role. Returns env-var name -> value. */
export async function loadSecretsForRole(
  role: Role,
  source: SecretSource,
  opts: { prefix: string },
): Promise<Record<string, string>> {
  const specs = ROLE_SECRETS[role];
  if (!specs) throw new Error(`unknown role: ${role}`);
  return loadSpecs(`role ${role}`, specs, source, opts);
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

/** True if a role is permitted write-scope secrets. */
export function hasWriteScope(role: Role): boolean {
  return ROLE_SECRETS[role].some((s) => s.scope === "write");
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

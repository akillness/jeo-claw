import { secretSourceFromEnv, type SecretSource } from "../secrets/loader.ts";

export const REQUIRED_NON_SECRET_ENV = [
  "GCLOUD_PROJECT",
  "GCLOUD_SECRET_PREFIX",
  "TARGET_REPO",
  "TARGET_BRANCH",
] as const;

export const OPTIONAL_DISCORD_ENV = [
  "DISCORD_GUILD_ID",
  "DISCORD_REQUEST_CHANNEL_ID",
  "DISCORD_APPROVAL_CHANNEL_ID",
  "DISCORD_REQUEST_CHANNEL_NAME",
  "DISCORD_APPROVAL_CHANNEL_NAME",
  "DISCORD_APPROVER_ROLE_ID",
  "DISCORD_STATUS_CHANNEL_ID",
  "DISCORD_DASHBOARD_CHANNEL_ID",
] as const;

export const REQUIRED_SECRET_NAMES = [
  "openai-codex-oauth",
  "github-token-ro",
  "github-token-rw",
  "github-webhook-secret",
  "discord-bot-token",
  "control-event-secret",
  "runtime-dispatch-secret",
] as const;

const PLAINTEXT_SECRET_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_CODEX_AUTH",
  "GITHUB_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "DISCORD_BOT_TOKEN",
  "JEO_CONTROL_EVENT_SECRET",
  "JEO_RUNTIME_DISPATCH_SECRET",
] as const;

export interface LivePreflightResult {
  ok: boolean;
  missingEnv: string[];
  missingSecrets: string[];
  checkedSecrets: string[];
  warnings: string[];
}

function trimmed(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? "";
}

function secretSourceMode(env: NodeJS.ProcessEnv): "gcloud" | "file" {
  return env.JEO_SECRET_SOURCE?.trim().toLowerCase() === "file" ? "file" : "gcloud";
}

export function requiredSecretIds(prefix: string): string[] {
  return REQUIRED_SECRET_NAMES.map((name) => `${prefix}-${name}`);
}

export function checkLiveEnv(env: NodeJS.ProcessEnv): Pick<LivePreflightResult, "missingEnv" | "warnings"> {
  const mode = secretSourceMode(env);
  const requiredEnv = mode === "file" ? ["GCLOUD_SECRET_PREFIX", "TARGET_REPO", "TARGET_BRANCH"] : REQUIRED_NON_SECRET_ENV;
  const missingEnv = requiredEnv.filter((key) => trimmed(env, key).length === 0);
  const warnings: string[] = [];

  for (const key of PLAINTEXT_SECRET_ENV) {
    if (trimmed(env, key).length > 0) {
      warnings.push(`${key} is set in the process environment; live secrets should be loaded from Secret Manager, not committed .env files.`);
    }
  }

  if (mode === "file" && trimmed(env, "JEO_SECRETS_FILE").length === 0) {
    missingEnv.push("JEO_SECRETS_FILE");
  }

  if (trimmed(env, "DISCORD_GUILD_ID").length === 0) {
    warnings.push("DISCORD_GUILD_ID is empty; startup will auto-select the guild only when the bot is installed in exactly one guild.");
  }
  if (trimmed(env, "DISCORD_REQUEST_CHANNEL_ID").length === 0) {
    warnings.push("DISCORD_REQUEST_CHANNEL_ID is empty; startup will discover or create the request channel by name.");
  }
  if (trimmed(env, "DISCORD_APPROVAL_CHANNEL_ID").length === 0) {
    warnings.push("DISCORD_APPROVAL_CHANNEL_ID is empty; startup will discover or create the approval channel by name.");
  }
  if (trimmed(env, "DISCORD_APPROVER_ROLE_ID").length === 0) {
    warnings.push("DISCORD_APPROVER_ROLE_ID is empty; approval commands will still work for Discord Administrator/Manage Guild members only.");
  }

  return { missingEnv, warnings };
}

export async function runLivePreflight(
  env: NodeJS.ProcessEnv = process.env,
  sourceFactory: (project: string, env: NodeJS.ProcessEnv) => SecretSource = (project, sourceEnv) => secretSourceFromEnv(sourceEnv, project),
): Promise<LivePreflightResult> {
  const { missingEnv, warnings } = checkLiveEnv(env);
  const prefix = trimmed(env, "GCLOUD_SECRET_PREFIX");
  const project = trimmed(env, "GCLOUD_PROJECT");
  const checkedSecrets = prefix ? requiredSecretIds(prefix) : [];
  const missingSecrets: string[] = [];
  const mode = secretSourceMode(env);

  if (prefix && (mode === "file" || project)) {
    const source = sourceFactory(project || "local-file-source", env);
    for (const secretId of checkedSecrets) {
      try {
        const value = await source.access(secretId);
        if (value.trim().length === 0) missingSecrets.push(secretId);
      } catch {
        missingSecrets.push(secretId);
      }
    }
  }

  return {
    ok: missingEnv.length === 0 && missingSecrets.length === 0,
    missingEnv,
    missingSecrets,
    checkedSecrets,
    warnings,
  };
}

function printResult(result: LivePreflightResult): void {
  console.log("jeo-claw live preflight");
  if (result.missingEnv.length > 0) {
    console.log(`MISSING env: ${result.missingEnv.join(", ")}`);
  } else {
    console.log("PASS required non-secret env present");
  }

  if (result.checkedSecrets.length > 0) {
    console.log(`Checked secret ids: ${result.checkedSecrets.join(", ")}`);
  }
  if (result.missingSecrets.length > 0) {
    console.log(`MISSING/EMPTY secrets: ${result.missingSecrets.join(", ")}`);
  } else if (result.checkedSecrets.length > 0) {
    console.log("PASS required secret entries are readable and non-empty");
  }

  for (const warning of result.warnings) {
    console.log(`WARN ${warning}`);
  }

  console.log(result.ok ? "PASS live preflight" : "FAIL live preflight");
}

if (import.meta.main) {
  runLivePreflight()
    .then((result) => {
      printResult(result);
      process.exit(result.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(`FAIL live preflight: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}

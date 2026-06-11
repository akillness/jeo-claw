import { test, expect } from "bun:test";
import { checkLiveEnv, requiredSecretIds, runLivePreflight } from "./preflight-live.ts";
import type { SecretSource } from "../secrets/loader.ts";

class MockSource implements SecretSource {
  constructor(private readonly values: Record<string, string>) {}

  async access(secretId: string): Promise<string> {
    const value = this.values[secretId];
    if (value === undefined) throw new Error("missing");
    return value;
  }
}

const completeEnv: NodeJS.ProcessEnv = {
  GCLOUD_PROJECT: "project-1",
  GCLOUD_SECRET_PREFIX: "jeo-claw",
  TARGET_REPO: "akillness/jeo-claw",
  TARGET_BRANCH: "main",
};

test("checkLiveEnv reports missing required bootstrap inputs only", () => {
  const result = checkLiveEnv({ GCLOUD_PROJECT: "project-1" });

  expect(result.missingEnv).toContain("GCLOUD_SECRET_PREFIX");
  expect(result.missingEnv).toContain("TARGET_REPO");
  expect(result.missingEnv).not.toContain("DISCORD_GUILD_ID");
  expect(result.missingEnv).not.toContain("DISCORD_REQUEST_CHANNEL_ID");
  expect(result.missingEnv).not.toContain("DISCORD_APPROVAL_CHANNEL_ID");
});

test("checkLiveEnv in file mode drops the GCP project requirement but requires the file path", () => {
  const result = checkLiveEnv({
    GCLOUD_SECRET_PREFIX: "jeo-claw",
    TARGET_REPO: "akillness/jeo-claw",
    TARGET_BRANCH: "main",
    JEO_SECRET_SOURCE: "file",
  });

  expect(result.missingEnv).toContain("JEO_SECRETS_FILE");
  expect(result.missingEnv).not.toContain("GCLOUD_PROJECT");
});

test("checkLiveEnv warns on plaintext secret env and Discord auto-provisioning", () => {
  const result = checkLiveEnv({ ...completeEnv, DISCORD_BOT_TOKEN: "plain-token" });

  expect(result.missingEnv).toEqual([]);
  expect(result.warnings.some((warning) => warning.includes("DISCORD_BOT_TOKEN"))).toBe(true);
  expect(result.warnings.some((warning) => warning.includes("DISCORD_APPROVER_ROLE_ID"))).toBe(true);
  expect(result.warnings.some((warning) => warning.includes("DISCORD_GUILD_ID"))).toBe(true);
  expect(result.warnings.some((warning) => warning.includes("DISCORD_REQUEST_CHANNEL_ID"))).toBe(true);
  expect(result.warnings.some((warning) => warning.includes("DISCORD_APPROVAL_CHANNEL_ID"))).toBe(true);
});

test("requiredSecretIds derives the live Secret Manager manifest", () => {
  expect(requiredSecretIds("jeo-claw")).toEqual([
    "jeo-claw-openai-codex-oauth",
    "jeo-claw-github-token-ro",
    "jeo-claw-github-token-rw",
    "jeo-claw-github-webhook-secret",
    "jeo-claw-discord-bot-token",
    "jeo-claw-control-event-secret",
    "jeo-claw-runtime-dispatch-secret",
  ]);
});

test("runLivePreflight succeeds when env and all required secrets are present", async () => {
  const source = new MockSource(Object.fromEntries(requiredSecretIds("jeo-claw").map((id) => [id, `value-for-${id}`])));

  const result = await runLivePreflight(completeEnv, () => source);

  expect(result.ok).toBe(true);
  expect(result.missingEnv).toEqual([]);
  expect(result.missingSecrets).toEqual([]);
  expect(result.checkedSecrets).toHaveLength(7);
});

test("runLivePreflight fails closed on missing or empty secrets", async () => {
  const values = Object.fromEntries(requiredSecretIds("jeo-claw").map((id) => [id, `value-for-${id}`]));
  values["jeo-claw-github-token-rw"] = "   ";
  delete values["jeo-claw-runtime-dispatch-secret"];
  const source = new MockSource(values);

  const result = await runLivePreflight(completeEnv, () => source);

  expect(result.ok).toBe(false);
  expect(result.missingSecrets).toContain("jeo-claw-github-token-rw");
  expect(result.missingSecrets).toContain("jeo-claw-runtime-dispatch-secret");
});

test("runLivePreflight supports file-backed secrets without GCLOUD_PROJECT", async () => {
  const path = `${process.env.TEMP || process.cwd()}\\jeo-claw-preflight-secrets.json`;
  const payload = Object.fromEntries(requiredSecretIds("jeo-claw").map((id) => [id, `value-for-${id}`]));
  await Bun.write(path, JSON.stringify(payload));
  try {
    const result = await runLivePreflight({
      ...completeEnv,
      JEO_SECRET_SOURCE: "file",
      JEO_SECRETS_FILE: path,
    });
    expect(result.ok).toBe(true);
    expect(result.missingEnv).toEqual([]);
    expect(result.missingSecrets).toEqual([]);
  } finally {
    await Bun.file(path).delete();
  }
});

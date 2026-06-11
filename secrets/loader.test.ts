import { test, expect } from "bun:test";
import {
  FileSecretSource,
  loadSecretsForRole,
  loadWriteSecretsForRole,
  loadSecretsForControl,
  hasWriteScope,
  redact,
  secretSourceFromEnv,
  MissingSecretError,
  ROLE_SECRETS,
  CONTROL_SECRETS,
  type Role,
  type SecretSource,
} from "./loader.ts";

class MockSource implements SecretSource {
  constructor(private store: Record<string, string>) {}
  accessed: string[] = [];
  async access(id: string): Promise<string> {
    this.accessed.push(id);
    const value = this.store[id];
    if (value === undefined) throw new Error(`not found and value=secret-leak-${id}`);
    return value;
  }
}

const fullStore = {
  "jeo-claw-openai-codex-oauth": '{"tokens":{"access_token":"fake"}}',
  "jeo-claw-github-token-ro": "ghp_readonly",
  "jeo-claw-github-token-rw": "ghp_readwrite",
  "jeo-claw-github-webhook-secret": "whsec_generated_secret_value",
  "jeo-claw-discord-bot-token": "xoxb_fake_discord",
  "jeo-claw-control-event-secret": "control-event-secret-value",
  "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret-value",
};

test("all runtime roles receive only read-only startup github token", async () => {
  for (const role of Object.keys(ROLE_SECRETS) as Role[]) {
    const src = new MockSource(fullStore);
    const env = await loadSecretsForRole(role, src, { prefix: "jeo-claw" });
    expect(src.accessed).not.toContain("jeo-claw-github-token-rw");
    expect(env.GITHUB_TOKEN).toBe("ghp_readonly");
  }
});

test("write roles are eligible for mediated write secret release", async () => {
  for (const role of ["pr-creator", "merger"] as Role[]) {
    const src = new MockSource(fullStore);
    const env = await loadWriteSecretsForRole(role, src, { prefix: "jeo-claw" });
    expect(src.accessed).toEqual(["jeo-claw-github-token-rw"]);
    expect(env.GITHUB_TOKEN).toBe("ghp_readwrite");
    expect(hasWriteScope(role)).toBe(true);
  }
});

test("non-write roles cannot request mediated write secrets", async () => {
  for (const role of ["researcher-coder", "reviewer", "pr-review-scheduler"] as Role[]) {
    const src = new MockSource(fullStore);
    await expect(loadWriteSecretsForRole(role, src, { prefix: "jeo-claw" })).rejects.toBeInstanceOf(MissingSecretError);
    expect(hasWriteScope(role)).toBe(false);
  }
});

test("runtime roles never receive control-plane secrets", async () => {
  for (const role of Object.keys(ROLE_SECRETS) as Role[]) {
    const src = new MockSource(fullStore);
    const env = await loadSecretsForRole(role, src, { prefix: "jeo-claw" });
    expect(env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.JEO_CONTROL_EVENT_SECRET).toBeUndefined();
    expect(src.accessed).not.toContain("jeo-claw-github-webhook-secret");
    expect(src.accessed).not.toContain("jeo-claw-discord-bot-token");
    expect(src.accessed).not.toContain("jeo-claw-control-event-secret");
  }
});

test("control services receive only control-plane secrets", async () => {
  const glueSrc = new MockSource(fullStore);
  const glue = await loadSecretsForControl("glue-webhook", glueSrc, { prefix: "jeo-claw" });
  expect(glue.GITHUB_WEBHOOK_SECRET).toBe("whsec_generated_secret_value");
  expect(glue.JEO_CONTROL_EVENT_SECRET).toBe("control-event-secret-value");
  expect(glue.GITHUB_TOKEN).toBeUndefined();
  expect(glue.OPENAI_CODEX_AUTH).toBeUndefined();
  expect(glueSrc.accessed).toEqual(["jeo-claw-github-webhook-secret", "jeo-claw-control-event-secret", "jeo-claw-runtime-dispatch-secret"]);

  const discordSrc = new MockSource(fullStore);
  const discord = await loadSecretsForControl("discord-bot", discordSrc, { prefix: "jeo-claw" });
  expect(discord.DISCORD_BOT_TOKEN).toBe("xoxb_fake_discord");
  expect(discord.JEO_CONTROL_EVENT_SECRET).toBe("control-event-secret-value");
  expect(discord.GITHUB_TOKEN).toBeUndefined();
  expect(discord.OPENAI_CODEX_AUTH).toBeUndefined();
  expect(discordSrc.accessed).toEqual(["jeo-claw-discord-bot-token", "jeo-claw-control-event-secret"]);
});

test("missing required secret is a hard failure with sanitized upstream details", async () => {
  const src = new MockSource({ "jeo-claw-openai-codex-oauth": '{"tokens":{"access_token":"fake"}}' });
  await expect(loadSecretsForRole("pr-creator", src, { prefix: "jeo-claw" })).rejects.toBeInstanceOf(
    MissingSecretError,
  );
  try {
    await loadSecretsForRole("pr-creator", src, { prefix: "jeo-claw" });
    expect.unreachable();
  } catch (e: any) {
    expect(e.message).not.toContain("secret-leak");
  }
});

test("blank and whitespace-only secret values are rejected", async () => {
  await expect(
    loadSecretsForRole("reviewer", new MockSource({ ...fullStore, "jeo-claw-openai-codex-oauth": "" }), { prefix: "jeo-claw" }),
  ).rejects.toBeInstanceOf(MissingSecretError);

  await expect(
    loadSecretsForControl("glue-webhook", new MockSource({ ...fullStore, "jeo-claw-github-webhook-secret": "   " }), { prefix: "jeo-claw" }),
  ).rejects.toBeInstanceOf(MissingSecretError);
});

test("generated shared secrets enforce minimum length", async () => {
  await expect(
    loadSecretsForControl("glue-webhook", new MockSource({ ...fullStore, "jeo-claw-github-webhook-secret": "short-secret" }), { prefix: "jeo-claw" }),
  ).rejects.toThrow("must be at least 24 characters");

  await expect(
    loadSecretsForRole("reviewer", new MockSource({ ...fullStore, "jeo-claw-runtime-dispatch-secret": "tiny-secret" }), { prefix: "jeo-claw" }),
  ).rejects.toThrow("must be at least 24 characters");
});


test("redact masks every secret value", () => {
  const masked = redact('token=ghp_readwrite key={"tokens":{"access_token":"fake"}}', ["ghp_readwrite", '{"tokens":{"access_token":"fake"}}']);
  expect(masked).not.toContain("ghp_readwrite");
  expect(masked).not.toContain('{"tokens":{"access_token":"fake"}}');
  expect(masked).toContain("***REDACTED***");
});

test("redact masks overlapping secret values longest-first", () => {
  const masked = redact("short=abc long=abcdef", ["abc", "abcdef"]);
  expect(masked).not.toContain("abcdef");
  expect(masked).not.toContain("abc");
  expect(masked).toBe("short=***REDACTED*** long=***REDACTED***");
});


test("FileSecretSource and secretSourceFromEnv support local file-backed secrets", async () => {
  const path = `${process.env.TEMP || process.cwd()}\\jeo-claw-test-secrets.json`;
  await Bun.write(path, JSON.stringify(fullStore));
  try {
    const source = new FileSecretSource(path);
    expect(await source.access("jeo-claw-openai-codex-oauth")).toBe('{"tokens":{"access_token":"fake"}}');
    const selected = secretSourceFromEnv({ JEO_SECRET_SOURCE: "file", JEO_SECRETS_FILE: path }, "ignored-project");
    expect(await selected.access("jeo-claw-github-token-ro")).toBe("ghp_readonly");
  } finally {
    await Bun.file(path).delete();
  }
});
test("every runtime role requires the OpenAI Codex OAuth key and not the legacy API key, and control services do not require either", () => {
  const legacyKey = ["openai", "api", "key"].join("-");
  for (const role of Object.keys(ROLE_SECRETS) as Role[]) {
    expect(ROLE_SECRETS[role].some((s) => s.name === "openai-codex-oauth")).toBe(true);
    expect(ROLE_SECRETS[role].some((s) => s.name === legacyKey)).toBe(false);
  }
  for (const specs of Object.values(CONTROL_SECRETS)) {
    expect(specs.some((s) => s.name === "openai-codex-oauth")).toBe(false);
    expect(specs.some((s) => s.name === legacyKey)).toBe(false);
  }
});

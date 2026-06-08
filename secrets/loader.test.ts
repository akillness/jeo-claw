import { test, expect } from "bun:test";
import {
  loadSecretsForRole,
  loadSecretsForControl,
  hasWriteScope,
  redact,
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
  "jeo-claw-openai-api-key": "sk-fake-openai",
  "jeo-claw-github-token-ro": "ghp_readonly",
  "jeo-claw-github-token-rw": "ghp_readwrite",
  "jeo-claw-github-webhook-secret": "whsec_fake",
  "jeo-claw-discord-bot-token": "xoxb_fake_discord",
};

test("least privilege: read-only roles never receive the write token", async () => {
  for (const role of ["researcher-coder", "reviewer", "pr-review-scheduler"] as Role[]) {
    const src = new MockSource(fullStore);
    await loadSecretsForRole(role, src, { prefix: "jeo-claw" });
    expect(src.accessed).not.toContain("jeo-claw-github-token-rw");
    expect(hasWriteScope(role)).toBe(false);
  }
});

test("write roles (pr-creator, merger) receive the write token", async () => {
  for (const role of ["pr-creator", "merger"] as Role[]) {
    const src = new MockSource(fullStore);
    const env = await loadSecretsForRole(role, src, { prefix: "jeo-claw" });
    expect(src.accessed).toContain("jeo-claw-github-token-rw");
    expect(env.GITHUB_TOKEN).toBe("ghp_readwrite");
    expect(hasWriteScope(role)).toBe(true);
  }
});

test("runtime roles never receive control-plane secrets", async () => {
  for (const role of Object.keys(ROLE_SECRETS) as Role[]) {
    const src = new MockSource(fullStore);
    const env = await loadSecretsForRole(role, src, { prefix: "jeo-claw" });
    expect(env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(src.accessed).not.toContain("jeo-claw-github-webhook-secret");
    expect(src.accessed).not.toContain("jeo-claw-discord-bot-token");
  }
});

test("control services receive only control-plane secrets", async () => {
  const glueSrc = new MockSource(fullStore);
  const glue = await loadSecretsForControl("glue-webhook", glueSrc, { prefix: "jeo-claw" });
  expect(glue.GITHUB_WEBHOOK_SECRET).toBe("whsec_fake");
  expect(glue.GITHUB_TOKEN).toBeUndefined();
  expect(glue.OPENAI_API_KEY).toBeUndefined();
  expect(glueSrc.accessed).toEqual(["jeo-claw-github-webhook-secret"]);

  const discordSrc = new MockSource(fullStore);
  const discord = await loadSecretsForControl("discord-bot", discordSrc, { prefix: "jeo-claw" });
  expect(discord.DISCORD_BOT_TOKEN).toBe("xoxb_fake_discord");
  expect(discord.GITHUB_TOKEN).toBeUndefined();
  expect(discord.OPENAI_API_KEY).toBeUndefined();
  expect(discordSrc.accessed).toEqual(["jeo-claw-discord-bot-token"]);
});

test("missing required secret is a hard failure with sanitized upstream details", async () => {
  const src = new MockSource({ "jeo-claw-openai-api-key": "sk-fake" });
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

test("empty secret value is rejected", async () => {
  const src = new MockSource({ ...fullStore, "jeo-claw-openai-api-key": "" });
  await expect(loadSecretsForRole("reviewer", src, { prefix: "jeo-claw" })).rejects.toBeInstanceOf(
    MissingSecretError,
  );
});

test("redact masks every secret value", () => {
  const masked = redact("token=ghp_readwrite key=sk-fake-openai", ["ghp_readwrite", "sk-fake-openai"]);
  expect(masked).not.toContain("ghp_readwrite");
  expect(masked).not.toContain("sk-fake-openai");
  expect(masked).toContain("***REDACTED***");
});

test("every runtime role requires the OpenAI key and control services do not", () => {
  for (const role of Object.keys(ROLE_SECRETS) as Role[]) {
    expect(ROLE_SECRETS[role].some((s) => s.name === "openai-api-key")).toBe(true);
  }
  for (const specs of Object.values(CONTROL_SECRETS)) {
    expect(specs.some((s) => s.name === "openai-api-key")).toBe(false);
  }
});

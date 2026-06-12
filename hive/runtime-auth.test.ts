import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareRuntimeConfig, seedZeroclawProviderModel } from "./runtime-auth.ts";

test("prepareRuntimeConfig seeds zeroclaw Codex auth profile and runs OAuth refresh", () => {
  const root = join(process.env.TEMP || process.cwd(), "jeo-runtime-auth-zeroclaw");
  rmSync(root, { recursive: true, force: true });
  const stateDir = join(root, ".zeroclaw");
  const codexAuth = JSON.stringify({ refresh_token: "rt-live", access_token: "at-live" });
  const calls: Array<{ command: string; args: string[] }> = [];
  const runCommand = ((command: string, args: string[]) => {
    calls.push({ command, args });
    return { status: 0, stdout: "", stderr: "" };
  }) as any;

  const configDir = prepareRuntimeConfig(
    "zeroclaw",
    { OPENAI_CODEX_AUTH: codexAuth, LLM_MODEL: "gpt-5-codex" },
    stateDir,
    runCommand,
  );

  expect(configDir).toBeUndefined();
  expect(readFileSync(join(stateDir, "auth.json"), "utf8")).toBe(codexAuth);
  expect(calls).toEqual([
    {
      command: "zeroclaw",
      args: ["auth", "login", "--provider", "openai-codex", "--import", join(stateDir, "auth.json")],
    },
    { command: "zeroclaw", args: ["auth", "refresh", "--provider", "openai-codex"] },
  ]);

  const configToml = readFileSync(join(stateDir, "config.toml"), "utf8");
  expect(configToml).toContain('fallback = "openai-codex"');
  expect(configToml).toContain("[providers.models.openai-codex]");
  expect(configToml).toContain('model = "gpt-5-codex"');
  expect(configToml).toContain('wire_api = "responses"');
  expect(configToml).toContain("requires_openai_auth = true");
});

test("seedZeroclawProviderModel patches an existing empty providers table and is idempotent", () => {
  const root = join(process.env.TEMP || process.cwd(), "jeo-runtime-zeroclaw-seed");
  rmSync(root, { recursive: true, force: true });
  const stateDir = join(root, ".zeroclaw");
  mkdirSync(stateDir, { recursive: true });
  const configPath = join(stateDir, "config.toml");
  writeFileSync(configPath, "schema_version = 2\n\n[providers]\n\n[gateway]\nport = 42617\n");

  seedZeroclawProviderModel(stateDir, "gpt-5-codex", "responses");
  const seeded = readFileSync(configPath, "utf8");
  expect(seeded).toContain('[providers]\nfallback = "openai-codex"');
  expect(seeded).toContain("[providers.models.openai-codex]");
  expect(seeded).toContain("[gateway]");

  seedZeroclawProviderModel(stateDir, "gpt-5-codex", "responses");
  expect(readFileSync(configPath, "utf8")).toBe(seeded);
});

test("prepareRuntimeConfig seeds nullclaw Codex auth profile and imports it", () => {
  const root = join(process.env.TEMP || process.cwd(), "jeo-runtime-auth-nullclaw");
  rmSync(root, { recursive: true, force: true });
  const worktree = join(root, "workspace");
  const codexAuth = JSON.stringify({ refresh_token: "rt-live", access_token: "at-live" });
  const calls: Array<{ command: string; args: string[]; home?: string; xdgConfigHome?: string }> = [];
  const runCommand = ((command: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, home: opts.env.HOME, xdgConfigHome: opts.env.XDG_CONFIG_HOME });
    return { status: 0, stdout: "", stderr: "" };
  }) as any;

  const configDir = prepareRuntimeConfig(
    "nullclaw",
    { OPENAI_CODEX_AUTH: codexAuth, JEO_WORKTREE: worktree },
    join(root, ".config", "nullclaw"),
    runCommand,
  );

  expect(configDir).toBeUndefined();
  expect(readFileSync(join(worktree, ".codex", "auth.json"), "utf8")).toBe(codexAuth);
  expect(calls).toEqual([
    {
      command: "nullclaw",
      args: ["auth", "login", "openai-codex", "--import-codex"],
      home: worktree,
      xdgConfigHome: join(worktree, ".config"),
    },
    {
      command: "nullclaw",
      args: ["onboard", "--provider", "openai-codex", "--model", "gpt-5-codex", "--memory", "none"],
      home: worktree,
      xdgConfigHome: join(worktree, ".config"),
    },
  ]);
});

test("prepareRuntimeConfig redacts OAuth payloads from startup failures", () => {
  const root = join(process.env.TEMP || process.cwd(), "jeo-runtime-auth-redact");
  rmSync(root, { recursive: true, force: true });
  const codexAuth = JSON.stringify({ refresh_token: "rt-secret", access_token: "at-secret" });
  const runCommand = (() => ({ status: 1, stdout: "", stderr: `bad auth ${codexAuth}` })) as any;

  try {
    prepareRuntimeConfig("zeroclaw", { OPENAI_CODEX_AUTH: codexAuth }, join(root, ".zeroclaw"), runCommand);
    expect.unreachable();
  } catch (error: any) {
    expect(error.message).toContain("***REDACTED***");
    expect(error.message).not.toContain("rt-secret");
    expect(error.message).not.toContain("at-secret");
  }
});

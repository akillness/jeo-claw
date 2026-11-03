import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeConfig, seedZeroclawProviderModel } from "./runtime-auth.ts";

function fixture(): { root: string; bin: string; trace: string } {
  const root = mkdtempSync(join(tmpdir(), "jeo-runtime-auth-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  return { root, bin, trace: join(root, "trace") };
}

function executable(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
}

test("prepareRuntimeConfig seeds zeroclaw Codex auth profile and runs OAuth refresh", async () => {
  const { root, bin, trace } = fixture();
  try {
    const stateDir = join(root, ".zeroclaw");
    const authPath = join(stateDir, "auth.json");
    const codexAuth = JSON.stringify({ refresh_token: "rt-fixture", access_token: "at-fixture" });
    const rotatedAuth = JSON.stringify({ refresh_token: "rt-rotated", access_token: "at-rotated" });
    executable(bin, "zeroclaw", `
      printf '%s|' "$@" >> "$TRACE"
      printf '\\n' >> "$TRACE"
      if [ "$2" = login ]; then
        [ -s "$6" ] || exit 2
      elif [ "$2" = refresh ]; then
        printf '%s' "$ROTATED_AUTH" > "$AUTH_PATH"
      else
        exit 3
      fi
    `);

    const configDir = await prepareRuntimeConfig(
      "zeroclaw",
      { PATH: bin, TRACE: trace, AUTH_PATH: authPath, ROTATED_AUTH: rotatedAuth, OPENAI_CODEX_AUTH: codexAuth, LLM_MODEL: "gpt-6.1-terra" },
      stateDir,
    );

    expect(configDir).toBeUndefined();
    expect(readFileSync(authPath, "utf8")).toBe(rotatedAuth);
    expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual([
      `auth|login|--model-provider|openai-codex|--import|${authPath}|`,
      "auth|refresh|--model-provider|openai-codex|",
    ]);
    const configToml = readFileSync(join(stateDir, "config.toml"), "utf8");
    expect(configToml).toContain('fallback = "openai-codex"');
    expect(configToml).toContain("[providers.models.openai-codex]");
    expect(configToml).toContain('model = "gpt-6.1-terra"');
    expect(configToml).toContain('wire_api = "responses"');
    expect(configToml).toContain("requires_openai_auth = true");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedZeroclawProviderModel patches an existing empty providers table and is idempotent", () => {
  const { root } = fixture();
  try {
    const stateDir = join(root, ".zeroclaw");
    mkdirSync(stateDir, { recursive: true });
    const configPath = join(stateDir, "config.toml");
    writeFileSync(configPath, "schema_version = 2\n\n[providers]\n\n[gateway]\nport = 42617\n");

    seedZeroclawProviderModel(stateDir, "gpt-6.1-terra", "responses");
    const seeded = readFileSync(configPath, "utf8");
    expect(seeded).toContain('[providers]\nfallback = "openai-codex"');
    expect(seeded).toContain("[providers.models.openai-codex]");
    expect(seeded).toContain("[gateway]");

    seedZeroclawProviderModel(stateDir, "gpt-6.1-terra", "responses");
    expect(readFileSync(configPath, "utf8")).toBe(seeded);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRuntimeConfig seeds nullclaw Codex auth profile and imports it", async () => {
  const { root, bin, trace } = fixture();
  try {
    const worktree = join(root, "workspace");
    const codexAuth = JSON.stringify({ refresh_token: "rt-fixture", access_token: "at-fixture" });
    executable(bin, "nullclaw", `
      printf '%s|' "$@" >> "$TRACE"
      printf '%s|%s\\n' "$HOME" "$XDG_CONFIG_HOME" >> "$TRACE"
      if [ "$1" = auth ]; then [ -s "$HOME/.codex/auth.json" ] || exit 2; fi
    `);

    const configDir = await prepareRuntimeConfig(
      "nullclaw",
      { PATH: bin, TRACE: trace, OPENAI_CODEX_AUTH: codexAuth, JEO_WORKTREE: worktree },
      join(root, ".config", "nullclaw"),
    );

    expect(configDir).toBeUndefined();
    expect(readFileSync(join(worktree, ".codex", "auth.json"), "utf8")).toBe(codexAuth);
    expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual([
      `auth|login|openai-codex|--import-codex|${worktree}|${join(worktree, ".config")}`,
      `onboard|--provider|openai-codex|--model|gpt-6.1-terra|--memory|none|${worktree}|${join(worktree, ".config")}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRuntimeConfig does not expose OAuth payloads from startup failures", async () => {
  const { root, bin } = fixture();
  try {
    const codexAuth = JSON.stringify({ refresh_token: "rt-secret-fixture", access_token: "at-secret-fixture" });
    executable(bin, "zeroclaw", 'printf "%s\\n" "$OPENAI_CODEX_AUTH"; printf "%s\\n" "$OPENAI_CODEX_AUTH" >&2; exit 1');
    let failure: unknown;
    try {
      await prepareRuntimeConfig("zeroclaw", { PATH: bin, OPENAI_CODEX_AUTH: codexAuth }, join(root, ".zeroclaw"));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = String(failure);
    expect(message).toContain("zeroclaw auth import failed");
    expect(message).not.toContain("rt-secret-fixture");
    expect(message).not.toContain("at-secret-fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

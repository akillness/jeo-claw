import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeConfig } from "./start.ts";

const initialAuth = '{"tokens":{"access_token":"initial-access","refresh_token":"initial-refresh"}}';
const rotatedAuth = '{"openai-codex":{"access_token":"rotated-access","refresh_token":"rotated-refresh","expires_at":4102444800,"token_type":"Bearer"}}';
const config = '{"agents":{"defaults":{"model":{"primary":"openai-codex/test-model"}}}}';

test("NullClaw imports once and preserves rotated authentication and configuration on restart", () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-null-restart-"));
  try {
    const bin = join(root, "bin");
    const home = join(root, "home");
    const state = join(root, "private-state");
    mkdirSync(bin);
    mkdirSync(home);
    const executable = join(bin, "nullclaw");
    writeFileSync(executable, `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$JEO_TEST_LOG"
state="$HOME/.nullclaw"
[ -z "\${NULLCLAW_HOME:-}" ] || state="$NULLCLAW_HOME"
case "$1" in
  auth)
    [ "$2 $3 $4" = "login openai-codex --import-codex" ] || exit 21
    [ "$(/bin/cat "$HOME/.codex/auth.json")" = '${initialAuth}' ] || exit 22
    /bin/mkdir -p "$state"
    printf '%s' '{"openai-codex":{"access_token":"initial-access","refresh_token":"initial-refresh","expires_at":4102444800,"token_type":"Bearer"}}' > "$state/auth.json"
    ;;
  onboard)
    /bin/mkdir -p "$state"
    printf '%s' '${config}' > "$state/config.json"
    ;;
  *) exit 23 ;;
esac
`);
    chmodSync(executable, 0o700);
    const log = join(root, "invocations");
    const env = { HOME: home, PATH: bin, JEO_TEST_LOG: log, OPENAI_CODEX_AUTH: initialAuth, LLM_MODEL: "test-model" };
    prepareRuntimeConfig("nullclaw", env, state);
    expect(existsSync(join(home, ".codex", "auth.json"))).toBe(false);
    expect(readFileSync(join(state, "auth.json"), "utf8")).toContain('"initial-access"');
    expect(readFileSync(join(state, "config.json"), "utf8")).toBe(config);
    const initialCalls = readFileSync(log, "utf8");
    expect(initialCalls).toContain("auth login openai-codex --import-codex\n");
    expect(initialCalls).toContain("onboard ");

    writeFileSync(join(state, "auth.json"), rotatedAuth);
    const customizedConfig = '{"agents":{"defaults":{"model":{"primary":"openai-codex/test-model"}}},"custom":"preserved"}';
    writeFileSync(join(state, "config.json"), customizedConfig);
    const codexPath = join(home, ".codex", "auth.json");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const existingCodexAuth = '{"tokens":{"access_token":"unrelated-access"}}';
    writeFileSync(codexPath, existingCodexAuth);
    prepareRuntimeConfig("nullclaw", env, state);
    expect(readFileSync(join(state, "auth.json"), "utf8")).toBe(rotatedAuth);
    expect(readFileSync(join(state, "config.json"), "utf8")).toBe(customizedConfig);
    expect(readFileSync(codexPath, "utf8")).toBe(existingCodexAuth);
    expect(readFileSync(log, "utf8")).toBe(initialCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ["malformed auth", "not-json", config],
  ["missing access token", '{"openai-codex":{"refresh_token":"rotated-refresh"}}', config],
  ["malformed config", rotatedAuth, "not-json"],
  ["incompatible model", rotatedAuth, '{"agents":{"defaults":{"model":{"primary":"openai-codex/other-model"}}}}'],
  ["missing config", rotatedAuth, undefined],
  ["missing auth", undefined, config],
])("NullClaw fails closed for %s without changing persisted state", (_name, auth, persistedConfig) => {
  const root = mkdtempSync(join(tmpdir(), "jeo-null-invalid-"));
  try {
    const home = join(root, "home");
    const state = join(home, ".nullclaw");
    const bin = join(root, "bin");
    mkdirSync(state, { recursive: true });
    mkdirSync(bin);
    const executable = join(bin, "nullclaw");
    writeFileSync(executable, '#!/bin/sh\nprintf invoked > "$HOME/invoked"\nexit 1\n');
    chmodSync(executable, 0o700);
    if (auth !== undefined) writeFileSync(join(state, "auth.json"), auth);
    if (persistedConfig !== undefined) writeFileSync(join(state, "config.json"), persistedConfig);
    expect(() => prepareRuntimeConfig("nullclaw", { HOME: home, PATH: bin, OPENAI_CODEX_AUTH: initialAuth, LLM_MODEL: "test-model" }, state)).toThrow();
    expect(existsSync(join(home, "invoked"))).toBe(false);
    expect(existsSync(join(state, "auth.json"))).toBe(auth !== undefined);
    expect(existsSync(join(state, "config.json"))).toBe(persistedConfig !== undefined);
    if (auth !== undefined) expect(readFileSync(join(state, "auth.json"), "utf8")).toBe(auth);
    if (persistedConfig !== undefined) expect(readFileSync(join(state, "config.json"), "utf8")).toBe(persistedConfig);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed onboarding preserves imported auth, removes raw credentials, and resumes after config recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-null-recovery-"));
  try {
    const home = join(root, "home");
    const bin = join(root, "bin");
    const state = join(home, ".nullclaw");
    const log = join(root, "import-home");
    mkdirSync(home);
    mkdirSync(bin);
    const executable = join(bin, "nullclaw");
    writeFileSync(executable, `#!/bin/sh
set -eu
case "$1" in
  auth)
    printf '%s' "$HOME" > "$JEO_TEST_LOG"
    [ "$(/bin/cat "$HOME/.codex/auth.json")" = '${initialAuth}' ] || exit 22
    /bin/mkdir -p "$NULLCLAW_HOME"
    printf '%s' '${rotatedAuth}' > "$NULLCLAW_HOME/auth.json"
    ;;
  onboard) exit 19 ;;
  *) exit 23 ;;
esac
`);
    chmodSync(executable, 0o700);
    const env = { HOME: home, PATH: bin, JEO_TEST_LOG: log, OPENAI_CODEX_AUTH: initialAuth, LLM_MODEL: "test-model" };
    expect(() => prepareRuntimeConfig("nullclaw", env, state)).toThrow("nullclaw onboard failed");
    const importHome = readFileSync(log, "utf8");
    expect(existsSync(importHome)).toBe(false);
    expect(existsSync(join(home, ".codex", "auth.json"))).toBe(false);
    expect(readFileSync(join(state, "auth.json"), "utf8")).toBe(rotatedAuth);
    expect(() => prepareRuntimeConfig("nullclaw", env, state)).toThrow();
    expect(readFileSync(join(state, "auth.json"), "utf8")).toBe(rotatedAuth);
    writeFileSync(join(state, "config.json"), config);
    prepareRuntimeConfig("nullclaw", env, state);
    expect(readFileSync(join(state, "auth.json"), "utf8")).toBe(rotatedAuth);
    expect(readFileSync(log, "utf8")).toBe(importHome);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ["NullClaw authentication", ".nullclaw", "auth.json", rotatedAuth],
  ["NullClaw configuration", ".nullclaw", "config.json", config],
  ["Codex authentication", ".codex", "auth.json", initialAuth],
])("legacy %s blocks bootstrap without reimport or overwrite", (_name, directory, filename, credential) => {
  const root = mkdtempSync(join(tmpdir(), "jeo-null-legacy-"));
  try {
    const home = join(root, "workspace");
    const state = join(root, "private-state");
    const bin = join(root, "bin");
    const legacy = join(home, directory, filename);
    mkdirSync(join(home, directory), { recursive: true });
    mkdirSync(bin);
    writeFileSync(legacy, credential);
    const executable = join(bin, "nullclaw");
    writeFileSync(executable, '#!/bin/sh\nprintf invoked > "$JEO_TEST_LOG"\nexit 1\n');
    chmodSync(executable, 0o700);
    const log = join(root, "invoked");
    expect(() => prepareRuntimeConfig("nullclaw", {
      HOME: home, JEO_WORKTREE: home, PATH: bin, JEO_TEST_LOG: log,
      OPENAI_CODEX_AUTH: initialAuth, LLM_MODEL: "test-model",
    }, state)).toThrow(/legacy|migrat/i);
    expect(readFileSync(legacy, "utf8")).toBe(credential);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(state, "auth.json"))).toBe(false);
    expect(existsSync(join(state, "config.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

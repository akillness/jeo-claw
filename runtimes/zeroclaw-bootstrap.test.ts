import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareRuntimeConfig, seedZeroclawProviderModel } from "./start.ts";

test("ZeroClaw bootstrap imports credentials in the requested state directory without forced refresh", () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-bootstrap-"));
  try {
    const bin = join(root, "bin");
    const state = join(root, "state");
    mkdirSync(bin);
    const executable = join(bin, "zeroclaw");
    writeFileSync(executable, `#!/bin/sh
[ "$1" = "--config-dir" ] && [ "$3" = "auth" ] && [ "$5" = "--model-provider" ] && [ "$6" = "openai-codex" ] || exit 21
case "$4" in
  login) [ "$#" -eq 8 ] && [ "$7" = "--import" ] && [ -f "$8" ] || exit 22; printf '%s' "$8" > "$2/import-path"; printf imported > "$2/login.ok" ;;
  *) exit 24 ;;
esac
`);
    chmodSync(executable, 0o700);
    const result = prepareRuntimeConfig("zeroclaw", { PATH: bin, OPENAI_CODEX_AUTH: '{"access_token":"fake-access"}', LLM_MODEL: "test-model" }, state);
    expect(result).toBe(state);
    expect(readFileSync(join(state, "login.ok"), "utf8")).toBe("imported");
    expect(existsSync(readFileSync(join(state, "import-path"), "utf8"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap failure never exposes individual credentials from child diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-bootstrap-error-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const executable = join(bin, "zeroclaw");
    writeFileSync(executable, '#!/bin/sh\nprintf "fake-access fake-refresh" >&2\nexit 1\n');
    chmodSync(executable, 0o700);
    let message = "";
    try {
      prepareRuntimeConfig("zeroclaw", { PATH: bin, OPENAI_CODEX_AUTH: '{"access_token":"fake-access","refresh_token":"fake-refresh"}', LLM_MODEL: "test-model" }, join(root, "state"));
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("zeroclaw auth import failed");
    expect(message).not.toContain("fake-access");
    expect(message).not.toContain("fake-refresh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ["existing provider fallback", 'schema_version = 2\n[providers]\nfallback = "another-provider"\n'],
  ["schema v3 config", 'schema_version = 3\n[agent]\nmodel = "preserved"\n'],
])("rejects %s without modifying the config", (_name, original) => {
  const root = mkdtempSync(join(tmpdir(), "jeo-seed-conflict-"));
  try {
    const path = join(root, "config.toml");
    writeFileSync(path, original);
    expect(() => seedZeroclawProviderModel(root, "test-model", "responses")).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config read errors are propagated rather than treated as missing config", () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-seed-read-error-"));
  try {
    mkdirSync(join(root, "config.toml"));
    expect(() => seedZeroclawProviderModel(root, "test-model", "responses")).toThrow(/read/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a valid persisted OAuth profile is reused without credential import or refresh", () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-auth-reuse-"));
  try {
    const state = join(root, "state");
    const bin = join(root, "bin");
    mkdirSync(state); mkdirSync(bin);
    const profile = JSON.stringify({ active_profiles: { "openai-codex": "openai-codex:default" }, profiles: { "openai-codex:default": { model_provider: "openai-codex", kind: "oauth", access_token: "encrypted" } } });
    writeFileSync(join(state, "auth-profiles.json"), profile);
    writeFileSync(join(bin, "zeroclaw"), "#!/bin/sh\nexit 51\n");
    chmodSync(join(bin, "zeroclaw"), 0o700);
    prepareRuntimeConfig("zeroclaw", { PATH: bin, LLM_MODEL: "test-model" }, state);
    expect(readFileSync(join(state, "auth-profiles.json"), "utf8")).toBe(profile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed persisted auth store fails without overwriting it", () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-auth-malformed-"));
  try {
    const state = join(root, "state");
    mkdirSync(state);
    const path = join(state, "auth-profiles.json");
    writeFileSync(path, "not-json");
    expect(() => prepareRuntimeConfig("zeroclaw", { OPENAI_CODEX_AUTH: '{"access_token":"fake"}', LLM_MODEL: "test-model" }, state)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("not-json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed credential import cleans its temporary input and allows retry without replacing user auth", () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-auth-retry-"));
  try {
    const state = join(root, "state");
    const bin = join(root, "bin");
    mkdirSync(state); mkdirSync(bin);
    const savedAuth = join(state, "auth.json");
    writeFileSync(savedAuth, "user data");
    const executable = join(bin, "zeroclaw");
    writeFileSync(executable, '#!/bin/sh\nprintf "%s" "$8" > "$2/import-path"\nexit 1\n');
    chmodSync(executable, 0o700);
    const env = { PATH: bin, OPENAI_CODEX_AUTH: '{"access_token":"fake"}', LLM_MODEL: "test-model" };
    expect(() => prepareRuntimeConfig("zeroclaw", env, state)).toThrow("auth import failed");
    expect(existsSync(readFileSync(join(state, "import-path"), "utf8"))).toBe(false);
    expect(readFileSync(savedAuth, "utf8")).toBe("user data");
    writeFileSync(executable, '#!/bin/sh\nprintf "%s" "$8" > "$2/import-path"\nexit 0\n');
    prepareRuntimeConfig("zeroclaw", env, state);
    expect(existsSync(readFileSync(join(state, "import-path"), "utf8"))).toBe(false);
    expect(readFileSync(savedAuth, "utf8")).toBe("user data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ["commented header", 'schema_version = 2\n# [providers]\n[gateway]\nport = 1234\n'],
  ["indented provider", 'schema_version = 2\n [providers]\n fallback = "custom"\n'],
])("existing %s is not rewritten", (_name, original) => {
  const root = mkdtempSync(join(tmpdir(), "jeo-seed-existing-"));
  try {
    const path = join(root, "config.toml");
    writeFileSync(path, original);
    expect(() => seedZeroclawProviderModel(root, "test-model", "responses")).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Runtime } from "../glue/contract.ts";

function requireTrimmed(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is missing or empty`);
  }
  return trimmed;
}

// Ensures the ZeroClaw gateway has a usable default provider/model entry.
// `zeroclaw onboard --quick` cannot seed OAuth providers (it requires a legacy
// api-key), so after the auth profile import we write the providers block that
// the gateway expects (`providers.fallback` + `[providers.models.openai-codex]`)
// directly into <stateDir>/config.toml. Without this the gateway boots in
// `503 needs_onboarding` mode and chat endpoints are unusable.
export function seedZeroclawProviderModel(stateDir: string, model: string, wireApi: string): void {
  const configPath = join(stateDir, "config.toml");
  let configText = "";
  try {
    configText = readFileSync(configPath, "utf8");
  } catch {
    configText = "schema_version = 2\n";
  }
  if (configText.includes("[providers.models.openai-codex]")) return;

  if (/^\[providers\]\s*$/m.test(configText)) {
    configText = configText.replace(/^\[providers\]\s*$/m, '[providers]\nfallback = "openai-codex"');
  } else {
    configText += '\n[providers]\nfallback = "openai-codex"\n';
  }
  configText += [
    "",
    "[providers.models.openai-codex]",
    'provider = "openai-codex"',
    `model = "${model}"`,
    `wire_api = "${wireApi}"`,
    "requires_openai_auth = true",
    "",
  ].join("\n");
  writeFileSync(configPath, configText, { mode: 0o600 });
}

type SpawnSyncRunner = typeof spawnSync;

export function prepareRuntimeConfig(
  runtime: Runtime,
  env: NodeJS.ProcessEnv,
  stateDir: string,
  runCommand: SpawnSyncRunner = spawnSync,
): string | undefined {
  const codexAuth = requireTrimmed("OPENAI_CODEX_AUTH", env.OPENAI_CODEX_AUTH);
  const model = env.LLM_MODEL?.trim() || "gpt-5-codex";

  const redactError = (errStr: string): string => {
    let safe = errStr;
    const normalizedAuth = codexAuth.trim();
    if (normalizedAuth) {
      safe = safe.replaceAll(normalizedAuth, "***REDACTED***");
    }
    return safe;
  };

  const runChecked = (
    label: string,
    command: string,
    args: string[],
    commandEnv: NodeJS.ProcessEnv,
  ): void => {
    const result = runCommand(command, args, {
      env: commandEnv,
      stdio: "pipe",
      encoding: "utf8",
    });

    if (result.status !== 0) {
      const err = redactError(String(result.stderr || result.stdout || "unknown error"));
      throw new Error(`${label} failed: ${err.trim()}`);
    }
  };

  if (runtime === "zeroclaw") {
    mkdirSync(stateDir, { recursive: true });
    const authPath = join(stateDir, "auth.json");
    writeFileSync(authPath, codexAuth, { mode: 0o600 });

    runChecked("zeroclaw auth import", "zeroclaw", ["auth", "login", "--provider", "openai-codex", "--import", authPath], env);
    runChecked("zeroclaw auth refresh", "zeroclaw", ["auth", "refresh", "--provider", "openai-codex"], env);

    seedZeroclawProviderModel(stateDir, model, env.OPENAI_WIRE_API?.trim() || "responses");

    return undefined;
  }

  if (runtime === "nullclaw") {
    const home = env.HOME || env.JEO_WORKTREE || "/workspace";
    mkdirSync(join(home, ".config", "nullclaw"), { recursive: true });
    mkdirSync(join(home, ".local", "share"), { recursive: true });
    const runtimeEnv = {
      ...env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    };

    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "auth.json"), codexAuth, { mode: 0o600 });

    runChecked("nullclaw auth login", "nullclaw", ["auth", "login", "openai-codex", "--import-codex"], runtimeEnv);
    runChecked(
      "nullclaw onboard",
      "nullclaw",
      [
        "onboard",
        "--provider",
        "openai-codex",
        "--model",
        model,
        "--memory",
        "none",
      ],
      runtimeEnv,
    );
  }

  return undefined;
}

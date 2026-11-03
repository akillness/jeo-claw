import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Runtime } from "../glue/contract.ts";

function requireTrimmed(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is missing or empty`);
  }
  return trimmed;
}
function writePrivateAuth(path: string, auth: string): void {
  const temporaryDirectory = mkdtempSync(join(dirname(path), ".auth-"));
  try {
    const temporaryFile = join(temporaryDirectory, "auth.json");
    writeFileSync(temporaryFile, auth, { mode: 0o600, flag: "wx" });
    renameSync(temporaryFile, path);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function authSeedChanged(markerPath: string, seedHash: string): boolean {
  try {
    return readFileSync(markerPath, "utf8") !== seedHash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function requirePrivateAuth(path: string): void {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error();
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error("Persisted authentication file is not private");
  }
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

export class RuntimeAuthAbortedError extends Error {
  constructor() { super("Runtime authentication aborted"); }
}

export class RuntimeAuthCleanupError extends Error {
  constructor() { super("Runtime authentication subprocess cleanup failed"); }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RuntimeAuthAbortedError();
}

async function runChecked(
  label: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      env,
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
  } catch {
    throw new Error(`${label} could not start`);
  }
  await new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const expireCleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new RuntimeAuthCleanupError());
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      cleanupTimer ??= setTimeout(expireCleanup, 5_000);
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch { /* close or cleanup deadline decides */ }
    };
    const abort = () => stop(new RuntimeAuthAbortedError());
    const timer = setTimeout(() => stop(new Error(`${label} timed out`)), 30_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", () => stop(new Error(`${label} could not start`)));
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener("abort", abort);
      if ((failure && child.pid !== undefined) || signal?.aborted) reject(new RuntimeAuthCleanupError());
      else if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`${label} failed (exit ${code})`));
    });
  });
}

export async function prepareRuntimeConfig(
  runtime: Runtime,
  env: NodeJS.ProcessEnv,
  stateDir: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  throwIfAborted(signal);
  const codexAuth = requireTrimmed("OPENAI_CODEX_AUTH", env.OPENAI_CODEX_AUTH);
  const model = env.LLM_MODEL?.trim() || "gpt-6.1-terra";
  const seedHash = createHash("sha256").update(codexAuth).digest("hex");

  if (runtime === "zeroclaw") {
    mkdirSync(stateDir, { recursive: true });
    const authPath = join(stateDir, "auth.json");
    const markerPath = join(stateDir, ".auth-seed-sha256");
    if (authSeedChanged(markerPath, seedHash)) {
      rmSync(markerPath, { force: true });
      writePrivateAuth(authPath, codexAuth);
      await runChecked("zeroclaw auth import", "zeroclaw", ["auth", "login", "--model-provider", "openai-codex", "--import", authPath], env, signal);
      throwIfAborted(signal);
      writePrivateAuth(markerPath, seedHash);
    }
    else requirePrivateAuth(authPath);
    await runChecked("zeroclaw auth refresh", "zeroclaw", ["auth", "refresh", "--model-provider", "openai-codex"], env, signal);
    throwIfAborted(signal);

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
    const markerPath = join(codexDir, ".auth-seed-sha256");
    if (authSeedChanged(markerPath, seedHash)) {
      rmSync(markerPath, { force: true });
      writePrivateAuth(join(codexDir, "auth.json"), codexAuth);
      await runChecked("nullclaw auth login", "nullclaw", ["auth", "login", "openai-codex", "--import-codex"], runtimeEnv, signal);
      throwIfAborted(signal);
      writePrivateAuth(markerPath, seedHash);
    }
    else requirePrivateAuth(join(codexDir, "auth.json"));
    await runChecked(
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
      signal,
    );
    throwIfAborted(signal);
  }

  return undefined;
}

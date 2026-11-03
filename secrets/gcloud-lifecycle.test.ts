import { expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareRuntimeConfig } from "../hive/runtime-auth.ts";
import { loadSecretsForRole, ROLE_SECRETS, SecretAccessAbortedError } from "./loader.ts";

const loaderUrl = pathToFileURL(resolve(import.meta.dir, "loader.ts")).href;
const startUrl = pathToFileURL(resolve(import.meta.dir, "../hive/start.ts")).href;
const authUrl = pathToFileURL(resolve(import.meta.dir, "../hive/runtime-auth.ts")).href;
const supervisorPath = resolve(import.meta.dir, "../hive/start.ts");
const syntheticSecret = "synthetic-secret-never-log-this";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jeo-gcloud-lifecycle-"));
  const pidFile = join(dir, "gcloud.pid");
  writeFileSync(join(dir, "gcloud"), `#!/bin/sh
case "$FAKE_MODE" in
  success) printf '%s\\n' '${syntheticSecret}'; exit 0 ;;
  failure) printf '%s\\n' '${syntheticSecret}' >&2; exit 7 ;;
  excessive) printf '%s' "$$" > "$TMPDIR/gcloud.pid.tmp"; /bin/mv "$TMPDIR/gcloud.pid.tmp" "$TMPDIR/gcloud.pid"; printf '%s' '${syntheticSecret}'; exec /usr/bin/yes x ;;
  inherited) /bin/cat "$TMPDIR/release" >&2 & printf '%s' "$!" > "$TMPDIR/descendant.pid"; printf '%s' "$$" > "$TMPDIR/gcloud.pid.tmp"; /bin/mv "$TMPDIR/gcloud.pid.tmp" "$TMPDIR/gcloud.pid"; exec /bin/sleep 300 ;;
  stall) printf '%s' "$$" > "$TMPDIR/gcloud.pid.tmp"; /bin/mv "$TMPDIR/gcloud.pid.tmp" "$TMPDIR/gcloud.pid"; exec /bin/sleep 300 ;;
esac
exit 9
`, { mode: 0o700 });
  writeFileSync(join(dir, "zeroclaw"), `#!/bin/sh
if [ "$1" = "--help" ]; then stage=probe; elif [ "$2" = "login" ]; then stage=import; else stage=refresh; fi
if [ "$stage" = "$FAKE_STAGE" ]; then
  printf '%s' "$$" > "$TMPDIR/auth.pid.tmp"; /bin/mv "$TMPDIR/auth.pid.tmp" "$TMPDIR/auth.pid"
  printf '%s' 'synthetic-secret-never' >&2
  if [ "$FAKE_FAILURE" = "yes" ]; then exit 7; fi
  exec /bin/sleep 300
fi
exit 0
`, { mode: 0o700 });
  return { dir, pidFile, env: { PATH: dir, HOME: dir, TMPDIR: dir } };
}

function run(command: string[], env: Record<string, string>) {
  const child = spawn(command[0]!, command.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr!.on("data", (data: Buffer) => { output += data.toString(); });
  const closed = once(child, "close").then(([code, signal]) => ({ code, signal, output }));
  return { child, closed };
}

async function awaitPid(path: string): Promise<number> {
  if (!existsSync(path)) {
    await new Promise<void>((resolveReady, reject) => {
      const watcher = watch(join(path, ".."), () => {
        if (existsSync(path) && readFileSync(path, "utf8").length > 0) {
          clearTimeout(deadline);
          watcher.close();
          resolveReady();
        }
      });
      // Safety deadline for the real subprocess readiness handshake, not a settling delay.
      const deadline = setTimeout(() => { watcher.close(); reject(new Error("fake gcloud did not start")); }, 5000);
      if (existsSync(path) && readFileSync(path, "utf8").length > 0) {
        clearTimeout(deadline);
        watcher.close();
        resolveReady();
      }
    });
  }
  const pid = Number(readFileSync(path, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid owned child PID");
  return pid;
}

function expectReaped(pid: number) {
  try {
    process.kill(pid, 0);
    throw new Error(`owned fake gcloud ${pid} remains alive`);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "close").catch(() => undefined);
  }
}

const harness = `
import { GcloudSecretSource, SecretAccessAbortedError } from ${JSON.stringify(loaderUrl)};
const controller = new AbortController();
process.stdin.on('data', () => controller.abort());
try {
  const value = await new GcloudSecretSource('synthetic-project', Number(process.env.TEST_TIMEOUT)).access('synthetic-id', controller.signal);
  console.log(JSON.stringify({ result: value === ${JSON.stringify(syntheticSecret)} ? 'success' : 'wrong-value' }));
} catch (error) {
  console.log(JSON.stringify({ result: 'error', aborted: error instanceof SecretAccessAbortedError, message: error.message }));
}
process.stdin.destroy();
`;

test("gcloud reads synthetic output and sanitizes a failed secret lookup", async () => {
  const f = fixture();
  try {
    for (const mode of ["success", "failure"]) {
      const runResult = run([process.execPath, "-e", harness], { ...f.env, FAKE_MODE: mode, TEST_TIMEOUT: "5000" });
      const result = await runResult.closed;
      expect(result.code).toBe(0);
      expect(result.output).not.toContain(syntheticSecret);
      const parsed = JSON.parse(result.output);
      expect(parsed.result).toBe(mode === "success" ? "success" : "error");
      if (mode === "failure") expect(parsed.message).toContain("gcloud access failed");
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("oversized gcloud output is rejected without leaking the partial secret", async () => {
  const f = fixture();
  const runner = run([process.execPath, "-e", harness], { ...f.env, FAKE_MODE: "excessive", TEST_TIMEOUT: "5000" });
  try {
    const pid = await awaitPid(f.pidFile);
    const result = await runner.closed;
    expect(result.code).toBe(0);
    expect(result.output).not.toContain(syntheticSecret);
    const parsed = JSON.parse(result.output);
    expect(parsed.result).toBe("error");
    expect(parsed.message.toLowerCase()).not.toContain("timed out");
    expectReaped(pid);
  } finally {
    await stop(runner.child);
    rmSync(f.dir, { recursive: true, force: true });
  }
}, 10000);

for (const mode of ["abort", "timeout", "supervisor"] as const) {
  test(`${mode} stops and reaps only its stalled gcloud child`, async () => {
    const f = fixture();
    const sentinel = spawn("/bin/sleep", ["300"], { stdio: "ignore", env: f.env });
    const command = mode === "supervisor" ? [process.execPath, supervisorPath] : [process.execPath, "-e", harness];
    const runner = run(command, { ...f.env, FAKE_MODE: "stall", TEST_TIMEOUT: mode === "timeout" ? "1500" : "10000", GCLOUD_PROJECT: "synthetic-project", GCLOUD_SECRET_PREFIX: "synthetic" });
    try {
      const pid = await awaitPid(f.pidFile);
      if (mode === "abort") runner.child.stdin!.write("abort");
      if (mode === "supervisor") runner.child.kill("SIGTERM");
      const result = await runner.closed;
      expect(result.output).not.toContain(syntheticSecret);
      if (mode !== "supervisor") {
        expect(result.code).toBe(0);
        const parsed = JSON.parse(result.output);
        expect(parsed.result).toBe("error");
        if (mode === "abort") expect(parsed.aborted).toBe(true);
        else expect(parsed.message.toLowerCase()).toContain("timed out");
      } else {
        expect(result.code).toBe(0);
      }
      expectReaped(pid);
      expect(sentinel.exitCode).toBeNull();
      expect(sentinel.signalCode).toBeNull();
      expect(sentinel.kill(0)).toBe(true);
    } finally {
      await stop(runner.child);
      await stop(sentinel);
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 15000);
}

test("timeout is bounded when an owned descendant holds gcloud pipes open", async () => {
  const f = fixture();
  const fifo = join(f.dir, "release");
  expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
  const sentinel = spawn("/bin/sleep", ["300"], { stdio: "ignore", env: f.env });
  const runner = run([process.execPath, "-e", harness], { ...f.env, FAKE_MODE: "inherited", TEST_TIMEOUT: "1500" });
  let deadline: Timer | undefined;
  try {
    const pid = await awaitPid(f.pidFile);
    expect(Number(readFileSync(join(f.dir, "descendant.pid"), "utf8"))).toBeGreaterThan(1);
    // This real deadline checks the platform subprocess/pipe behavior itself.
    const result = await Promise.race([
      runner.closed,
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("timeout remained blocked by inherited pipes")), 3000); }),
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).message.toLowerCase()).toContain("timed out");
    expect(result.output).not.toContain(syntheticSecret);
    expectReaped(pid);
    expect(sentinel.kill(0)).toBe(true);
  } finally {
    clearTimeout(deadline);
    // A FIFO lets only our fake descendant exit if a broken implementation left it alive.
    try { closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
    }
    await stop(runner.child);
    await stop(sentinel);
    rmSync(f.dir, { recursive: true, force: true });
  }
}, 10000);

test("binary probe checks an executable without running its potentially hanging help command", async () => {
  const f = fixture();
  const script = `import { isBinaryOnPath } from ${JSON.stringify(startUrl)}; console.log(JSON.stringify(await isBinaryOnPath('zeroclaw')));`;
  try {
    const runner = run([process.execPath, "-e", script], { ...f.env, FAKE_STAGE: "probe" });
    const result = await runner.closed;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toBe(true);
    expect(existsSync(join(f.dir, "auth.pid"))).toBe(false);
    chmodSync(join(f.dir, "zeroclaw"), 0o600);
    const inaccessible = await run([process.execPath, "-e", script], { ...f.env, FAKE_STAGE: "probe" }).closed;
    expect(inaccessible.code).toBe(0);
    expect(JSON.parse(inaccessible.output)).toBe(false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

const authHarness = `
import { prepareRuntimeConfig } from ${JSON.stringify(authUrl)};
const controller = new AbortController();
process.stdin.on('data', () => controller.abort());
try {
  await prepareRuntimeConfig('zeroclaw', { ...process.env, OPENAI_CODEX_AUTH: ${JSON.stringify(syntheticSecret)} }, process.env.TMPDIR + '/state', controller.signal);
  console.log(JSON.stringify({ result: 'success' }));
} catch (error) {
  console.log(JSON.stringify({ result: 'error', message: error.message }));
}
process.stdin.destroy();
`;

for (const stage of ["import", "refresh"] as const) {
  test(`auth ${stage} cancels its owned child without exposing partial secrets`, async () => {
    const f = fixture();
    const sentinel = spawn("/bin/sleep", ["300"], { stdio: "ignore", env: f.env });
    const runner = run([process.execPath, "-e", authHarness], { ...f.env, FAKE_STAGE: stage });
    try {
      const pid = await awaitPid(join(f.dir, "auth.pid"));
      runner.child.stdin!.write("abort");
      const result = await runner.closed;
      expect(result.code).toBe(0);
      expect(result.output).not.toContain("synthetic-secret-never");
      const parsed = JSON.parse(result.output);
      expect(parsed.result).toBe("error");
      expect(parsed.message).toBe("Runtime authentication subprocess cleanup failed");
      expectReaped(pid);
      expect(sentinel.kill(0)).toBe(true);
    } finally {
      await stop(runner.child);
      await stop(sentinel);
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 10000);
}

test("auth failure does not surface partial credential bytes from stderr", async () => {
  const f = fixture();
  const runner = run([process.execPath, "-e", authHarness], { ...f.env, FAKE_STAGE: "import", FAKE_FAILURE: "yes" });
  try {
    const result = await runner.closed;
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("synthetic-secret-never");
    const parsed = JSON.parse(result.output);
    expect(parsed.result).toBe("error");
    expect(parsed.message).toContain("auth import");
  } finally {
    await stop(runner.child);
    rmSync(f.dir, { recursive: true, force: true });
  }
});

for (const outcome of ["aborted", "cleanup"] as const) {
  test(`supervisor reports auth ${outcome} shutdown correctly`, async () => {
    const f = fixture();
    const names = ["github-webhook-secret", "control-event-secret", "status-relay-secret", "runtime-dispatch-secret", "discord-bot-token", "openai-codex-oauth", "github-token-ro"];
    const secrets = Object.fromEntries(names.map((name) => [`synthetic-${name}`, `synthetic-only-credential-${name}`]));
    const secretsPath = join(f.dir, "secrets.json");
    writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
    const script = `
      import { writeFileSync, renameSync } from 'node:fs';
      import { main } from ${JSON.stringify(startUrl)};
      import { RuntimeAuthAbortedError, RuntimeAuthCleanupError } from ${JSON.stringify(authUrl)};
      await main({ prepareRuntimeConfig: async (_runtime, _env, _dir, signal) => {
        const gate = Promise.withResolvers();
        signal.addEventListener('abort', () => gate.reject(process.env.OUTCOME === 'cleanup' ? new RuntimeAuthCleanupError() : new RuntimeAuthAbortedError()), { once: true });
        writeFileSync(process.env.TMPDIR + '/ready.tmp', String(process.pid));
        renameSync(process.env.TMPDIR + '/ready.tmp', process.env.TMPDIR + '/ready');
        return gate.promise;
      }});
    `;
    const runner = run([process.execPath, "-e", script], { ...f.env, GCLOUD_PROJECT: "synthetic", GCLOUD_SECRET_PREFIX: "synthetic", JEO_SECRET_SOURCE: "file", JEO_SECRETS_FILE: secretsPath, OUTCOME: outcome });
    try {
      await awaitPid(join(f.dir, "ready"));
      runner.child.kill("SIGTERM");
      const result = await runner.closed;
      expect(result.code).toBe(outcome === "aborted" ? 0 : 1);
      expect(result.output).not.toContain("synthetic-only-credential-");
      expect(result.output).toContain(outcome === "aborted" ? "Shutdown complete" : "Startup cleanup failed");
    } finally {
      await stop(runner.child);
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 10000);
}

for (const runtime of ["zeroclaw", "nullclaw"] as const) {
  test(`${runtime} tightens permissions on a pre-existing credential file`, async () => {
    const f = fixture();
    const stateDir = join(f.dir, "state");
    const authPath = runtime === "zeroclaw" ? join(stateDir, "auth.json") : join(f.dir, ".codex", "auth.json");
    mkdirSync(runtime === "zeroclaw" ? stateDir : join(f.dir, ".codex"), { recursive: true });
    writeFileSync(authPath, "old-synthetic-credential", { mode: 0o644 });
    chmodSync(authPath, 0o644);
    writeFileSync(join(f.dir, "nullclaw"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    try {
      expect(statSync(authPath).mode & 0o777).toBe(0o644);
      await prepareRuntimeConfig(runtime, { ...f.env, OPENAI_CODEX_AUTH: syntheticSecret }, stateDir);
      expect(statSync(authPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(authPath, "utf8")).toBe(syntheticSecret);
      chmodSync(authPath, 0o644);
      await prepareRuntimeConfig(runtime, { ...f.env, OPENAI_CODEX_AUTH: syntheticSecret }, stateDir);
      expect(statSync(authPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(authPath, "utf8")).toBe(syntheticSecret);
      const target = join(f.dir, "unrelated-target");
      writeFileSync(target, "unrelated-synthetic-data");
      unlinkSync(authPath);
      symlinkSync(target, authPath);
      await expect(prepareRuntimeConfig(runtime, { ...f.env, OPENAI_CODEX_AUTH: syntheticSecret }, stateDir)).rejects.toThrow("Persisted authentication file is not private");
      expect(readFileSync(target, "utf8")).toBe("unrelated-synthetic-data");
      await prepareRuntimeConfig(runtime, { ...f.env, OPENAI_CODEX_AUTH: `${syntheticSecret}-changed` }, stateDir);
      expect(readFileSync(target, "utf8")).toBe("unrelated-synthetic-data");
      expect(lstatSync(authPath).isSymbolicLink()).toBe(false);
      expect(statSync(authPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(authPath, "utf8")).toBe(`${syntheticSecret}-changed`);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

for (const runtime of ["zeroclaw", "nullclaw"] as const) {
  test(`${runtime} preserves rotated credentials on restart and imports a changed seed`, async () => {
    const f = fixture();
    const stateDir = join(f.dir, "state");
    const authPath = runtime === "zeroclaw" ? join(stateDir, "auth.json") : join(f.dir, ".codex", "auth.json");
    const trace = join(f.dir, "imports");
    const executable = `#!/bin/sh
if [ "$2" = login ]; then
  /bin/cat "$AUTH_PATH" >> "$TRACE"
  printf '\\n' >> "$TRACE"
  if [ "$FAKE_RUNTIME" = nullclaw ] && [ ! -f "$TMPDIR/rotated" ]; then
    printf '%s' 'synthetic-rotated-token' > "$AUTH_PATH"
    /usr/bin/touch "$TMPDIR/rotated"
  fi
elif [ "$2" = refresh ] && [ ! -f "$TMPDIR/rotated" ]; then
  printf '%s' 'synthetic-rotated-token' > "$AUTH_PATH"
  /usr/bin/touch "$TMPDIR/rotated"
fi
exit 0
`;
    writeFileSync(join(f.dir, runtime), executable, { mode: 0o700 });
    const env = { ...f.env, AUTH_PATH: authPath, TRACE: trace, FAKE_RUNTIME: runtime, OPENAI_CODEX_AUTH: "synthetic-seed-one" };
    try {
      await prepareRuntimeConfig(runtime, env, stateDir);
      expect(readFileSync(authPath, "utf8")).toBe("synthetic-rotated-token");
      await prepareRuntimeConfig(runtime, env, stateDir);
      expect(readFileSync(authPath, "utf8")).toBe("synthetic-rotated-token");
      expect(readFileSync(trace, "utf8")).toBe("synthetic-seed-one\n");
      await prepareRuntimeConfig(runtime, { ...env, OPENAI_CODEX_AUTH: "synthetic-seed-two" }, stateDir);
      expect(readFileSync(trace, "utf8")).toBe("synthetic-seed-one\nsynthetic-seed-two\n");
      expect(readFileSync(authPath, "utf8")).toBe("synthetic-seed-two");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 10000);
}

test("supervisor fails closed on auth failure without spawning services or disclosing credentials", async () => {
  const f = fixture();
  const names = ["github-webhook-secret", "control-event-secret", "status-relay-secret", "runtime-dispatch-secret", "discord-bot-token", "openai-codex-oauth", "github-token-ro"];
  const secretsPath = join(f.dir, "secrets.json");
  writeFileSync(secretsPath, JSON.stringify(Object.fromEntries(names.map((name) => [`synthetic-${name}`, `synthetic-only-credential-${name}`]))), { mode: 0o600 });
  const script = `
    import { writeFileSync } from 'node:fs';
    import { main } from ${JSON.stringify(startUrl)};
    await main({
      prepareRuntimeConfig: async () => { throw new Error('synthetic-only-credential-sensitive'); },
      spawnChild: () => { writeFileSync(process.env.TMPDIR + '/spawned', 'unexpected'); throw new Error('unexpected service spawn'); },
    });
  `;
  const runner = run([process.execPath, "-e", script], { ...f.env, GCLOUD_PROJECT: "synthetic", GCLOUD_SECRET_PREFIX: "synthetic", JEO_SECRET_SOURCE: "file", JEO_SECRETS_FILE: secretsPath });
  try {
    const result = await runner.closed;
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Failed to prepare ZeroClaw config");
    expect(result.output).not.toContain("synthetic-only-credential-sensitive");
    expect(existsSync(join(f.dir, "spawned"))).toBe(false);
  } finally {
    await stop(runner.child);
    rmSync(f.dir, { recursive: true, force: true });
  }
}, 10000);

for (const runtime of ["zeroclaw", "nullclaw"] as const) {
  test(`${runtime} reimports original seed after changed seed import fails`, async () => {
    const f = fixture();
    const stateDir = join(f.dir, "state");
    const authPath = runtime === "zeroclaw" ? join(stateDir, "auth.json") : join(f.dir, ".codex", "auth.json");
    const trace = join(f.dir, "imports");
    writeFileSync(join(f.dir, runtime), `#!/bin/sh
if [ "$2" = login ]; then
  value=$(/bin/cat "$AUTH_PATH")
  printf '%s\\n' "$value" >> "$TRACE"
  if [ "$value" = 'synthetic-seed-two' ]; then exit 7; fi
fi
exit 0
`, { mode: 0o700 });
    const env = { ...f.env, AUTH_PATH: authPath, TRACE: trace, OPENAI_CODEX_AUTH: "synthetic-seed-one" };
    try {
      await prepareRuntimeConfig(runtime, env, stateDir);
      await expect(prepareRuntimeConfig(runtime, { ...env, OPENAI_CODEX_AUTH: "synthetic-seed-two" }, stateDir)).rejects.toThrow();
      await prepareRuntimeConfig(runtime, env, stateDir);
      expect(readFileSync(trace, "utf8")).toBe("synthetic-seed-one\nsynthetic-seed-two\nsynthetic-seed-one\n");
      expect(readFileSync(authPath, "utf8")).toBe("synthetic-seed-one");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 10000);
}

test("role loading rejects cancellation during the final secret access", async () => {
  const controller = new AbortController();
  let count = 0;
  const total = ROLE_SECRETS.reviewer.length;
  const source = {
    async access() {
      count++;
      if (count === total) controller.abort();
      return "synthetic-only-credential-with-sufficient-length";
    },
  };
  await expect(loadSecretsForRole("reviewer", source, { prefix: "synthetic", signal: controller.signal })).rejects.toBeInstanceOf(SecretAccessAbortedError);
  expect(count).toBe(total);
});

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTestProcess } from "./safe-bun-test.ts";

const posixTest = process.platform === "win32" ? test.skip : test;

// The parent reports a live grandchild only after its ready message, before
// it exits normally or waits for the runner's timeout.
const fixture = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'console.log("ready"); process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'inherit'] });
child.stdout.once('data', () => {
  console.log('descendant:' + child.pid);
  if (process.argv[1] === 'complete') process.exit(0);
});
`;

async function exercise(mode: "complete" | "timeout") {
  const sentinel = spawn(process.execPath, ["-e", "console.log('ready'); process.stdin.resume()"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    await once(sentinel.stdout, "data");
    const result = await runTestProcess(process.execPath, ["-e", fixture, mode], mode === "timeout" ? 2000 : 10000);
    const match = result.stdout.match(/descendant:(\d+)/);
    expect(match).not.toBeNull();
    expect(result.timedOut).toBe(mode === "timeout");
    expect(result.code).toBe(mode === "complete" ? 0 : 1);
    expect(sentinel.exitCode).toBeNull();
    expect(sentinel.signalCode).toBeNull();
    expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
    expect(() => process.kill(Number(match![1]), 0)).toThrow();
  } finally {
    sentinel.kill("SIGKILL");
    await once(sentinel, "close");
  }
}

posixTest("normal completion cleans the owned descendant without signaling an unrelated Bun process", async () => {
  await exercise("complete");
}, 15000);

posixTest("timeout cleans the owned descendant without signaling an unrelated Bun process", async () => {
  await exercise("timeout");
}, 15000);

for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  posixTest(`${signal} cleans the owned process group and preserves an unrelated Bun process`, async () => {
    const root = await mkdtemp(join(tmpdir(), "safe-runner-signal-"));
    const marker = join(root, "ready");
    const sentinel = spawn(process.execPath, ["-e", "console.log('ready'); process.stdin.resume()"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const { promise: ready, resolve } = Promise.withResolvers<void>();
    const watcher = watch(root, (_event, name) => { if (name === "ready") resolve(); });
    const childFixture = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      // Keep the runner's stderr pipe open until the descendant is actually gone.
      const child = spawn(process.execPath, ['-e', 'console.log("ready"); process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'inherit'] });
      child.stdout.once('data', () => {
        fs.writeFileSync(${JSON.stringify(marker + ".tmp")}, JSON.stringify([process.pid, child.pid]));
        fs.renameSync(${JSON.stringify(marker + ".tmp")}, ${JSON.stringify(marker)});
      });
    `;
    const runnerScript = `
      import { runTestProcess } from ${JSON.stringify(fileURLToPath(new URL("./safe-bun-test.ts", import.meta.url)))};
      await runTestProcess(process.execPath, ['-e', ${JSON.stringify(childFixture)}], 30000);
    `;
    const runner = spawn(process.execPath, ["-e", runnerScript], { stdio: "ignore" });
    let owned: number[] = [];
    try {
      await once(sentinel.stdout, "data");
      // The fixture atomically renames the marker after its descendant is ready.
      await ready;
      owned = JSON.parse(await readFile(marker, "utf8"));
      const closed = once(runner, "close");
      runner.kill(signal);
      const [code] = await closed;
      expect(code).toBe(exitCode);
      expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
      for (const pid of owned) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      watcher.close();
      if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
      sentinel.kill("SIGKILL");
      await once(sentinel, "close");
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
}

for (const stream of ["stdout", "stderr"] as const) {
  test(`oversized ${stream} fails with bounded captured output`, async () => {
    const script = `process.${stream}.write('x'.repeat(2 * 1024 * 1024))`;
    const result = await runTestProcess(process.execPath, ["-e", script], 10000);
    expect(result.code).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("output exceeded buffer limit");
    const output = stream === "stdout" ? result.stdout : result.stderr.split("\nsafe-bun-test:")[0]!;
    expect(Buffer.byteLength(output)).toBe(1024 * 1024);
    expect(output).toBe("x".repeat(1024 * 1024));
  }, 15000);
}

posixTest("timeout returns when an escaped descendant holds a pipe open", async () => {
  const root = await mkdtemp(join(tmpdir(), "safe-runner-escape-"));
  const marker = join(root, "pid");
  // This real external process must stay alive beyond its parent's exit to test
  // the platform pipe timeout; the fixture owns and kills it in finally.
  const escaped = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); console.log('ready'); setInterval(() => {}, 1000)`;
  const parent = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(escaped)}], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.once('data', () => { console.log('escaped:' + child.pid); process.exit(0); });
  `;
  try {
    const result = await runTestProcess(process.execPath, ["-e", parent], 2000);
    const pid = Number(await readFile(marker, "utf8"));
    expect(result.stdout).toContain(`escaped:${pid}`);
    expect(result.code).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
  } finally {
    const pidText = await readFile(marker, "utf8").catch(() => "");
    if (pidText) {
      try { process.kill(Number(pidText), "SIGKILL"); } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

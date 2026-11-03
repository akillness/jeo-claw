import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeAuthRefused, nativeInvocationCompleted, runNativeCommand, type NativeResult } from "./native-probe-evidence";

const refused: NativeResult = { argv: [], exit: 1, signal: null, stdout: "", stderr: "Missing OAuth credentials", timedOut: false, overflow: false };
test("SEC-1 an ordinary completed authentication-specific rejection is required", () => {
  expect(nativeAuthRefused(refused, 0)).toBe(true);
  for (const override of [
    { exit: null }, { exit: 0 }, { signal: "SIGKILL" }, { timedOut: true }, { overflow: true },
    { stderr: "Segmentation fault" }, { stderr: "File not found" }, { stderr: "Resource not available" },
  ]) expect(nativeAuthRefused({ ...refused, ...override }, 0)).toBe(false);
  expect(nativeAuthRefused(refused, 1)).toBe(false);
});
test("SEC-1 completion gate used by TLS negatives rejects every abnormal termination", () => {
  expect(nativeInvocationCompleted(refused)).toBe(true);
  for (const override of [{ exit: null }, { exit: -1 }, { signal: "SIGTERM" }, { timedOut: true }, { overflow: true }]) {
    expect(nativeInvocationCompleted({ ...refused, ...override })).toBe(false);
  }
});
// These process-boundary integrations deliberately use the platform clock:
// fake timers cannot drive child exit, pipe lifetime or process-group signals.
test("SEC-5 ordinary command completion retains bounded output", async () => {
  const result = await runNativeCommand(process.execPath, ["-e", 'process.stdout.write("done"); process.exitCode = 7'], {}, 2000, 100);
  expect(result.stdout).toBe("done");
  expect(result.exit).toBe(7);
  expect(nativeInvocationCompleted(result)).toBe(true);
});
test("SEC-5 timeout and overflow settle without accepting refusal evidence", async () => {
  const timeout = await runNativeCommand(process.execPath, ["-e", 'process.stderr.write("Missing OAuth credentials"); setInterval(() => {}, 1000)'], {}, 100, 100);
  expect(timeout.timedOut).toBe(true);
  expect(nativeAuthRefused(timeout, 0)).toBe(false);
  const overflow = await runNativeCommand(process.execPath, ["-e", 'process.stdout.write("x".repeat(2 * 1048576)); setInterval(() => {}, 1000)'], {}, 2000, 100);
  expect(overflow.overflow).toBe(true);
  expect(overflow.stdout.length + overflow.stderr.length).toBeLessThanOrEqual(1048576);
  expect(nativeInvocationCompleted(overflow)).toBe(false);
});
test("SEC-5 escaped descendant holding descriptors cannot keep invocation pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-probe-drain-test-"));
  const pidPath = join(directory, "descendant.pid");
  let descendantPid: number | undefined;
  try {
    const descendant = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const parent = `import { spawn } from 'node:child_process'; const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(descendant)}], { detached: true, stdio: ['ignore', 'pipe', 'inherit'], env: {} }); child.stdout.once('data', data => { process.stdout.write(data); process.exit(0); });`;
    const started = performance.now();
    const result = await runNativeCommand(process.execPath, ["-e", parent], {}, 2000, 100);
    descendantPid = Number(await readFile(pidPath, "utf8"));
    expect(result.stdout).toBe("ready");
    expect(performance.now() - started).toBeLessThan(1500);
    expect(result.timedOut).toBe(true);
    expect(nativeInvocationCompleted(result)).toBe(false);
  } finally {
    descendantPid ??= Number(await readFile(pidPath, "utf8").catch(() => "0"));
    if (descendantPid > 0) {
      try { process.kill(-descendantPid, "SIGKILL"); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 5000);

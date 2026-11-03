import { expect, test } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodingAgent } from "./repo-work.ts";

test("noisy agent output stays bounded while an evicted failure marker remains visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-output-"));
  try {
    const script = `process.stdout.write("Rate "); process.stdout.write("limited"); process.stdout.write("x".repeat(100000)); process.stderr.write("y".repeat(100000));`;
    const result = await runCodingAgent([process.execPath, "-e", script], { cwd: root, timeoutMs: 10000, maxOutputBytes: 128 });
    expect(result.exitCode).toBe(0);
    expect(result.marker).toBe("Rate limited");
    expect(result.stdout).toBe("x".repeat(128));
    expect(result.stderr).toBe("y".repeat(128));
    expect(result.timedOut).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a cancelled request never runs the child", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-output-"));
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await runCodingAgent([join(root, "missing-executable")], { cwd: root, timeoutMs: 10000, signal: controller.signal });
    expect(result).toEqual({ exitCode: -1, stdout: "", stderr: "", marker: null, timedOut: false, cancelled: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancellation terminates an active coding agent after it reports ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-output-"));
  const controller = new AbortController();
  const watcher = watch(root, (_event, name) => { if (name === "ready") controller.abort(); });
  try {
    const script = `process.stdout.write("ready\\n"); require("node:fs").writeFileSync(${JSON.stringify(join(root, "ready"))}, "ready"); Bun.serve({port: 0, fetch: () => new Response("alive")});`;
    const result = await runCodingAgent([process.execPath, "-e", script], { cwd: root, timeoutMs: 5000, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("ready");
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a hung agent is terminated and reported as timed out", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-output-"));
  try {
    // This exercises the actual process deadline, so a real timeout is necessary.
    const script = `Bun.serve({port: 0, fetch: () => new Response("alive")});`;
    const result = await runCodingAgent([process.execPath, "-e", script], { cwd: root, timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.exitCode).not.toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32").each([
  { name: "same process group", detached: false },
  { name: "escaped process group", detached: true },
])("timeout completes when a $name descendant ignores SIGTERM and holds stdout", async ({ detached }) => {
  const root = await mkdtemp(join(tmpdir(), "agent-output-"));
  const parentPidFile = join(root, "parent.pid");
  const descendantPidFile = join(root, "descendant.pid");
  let watchdog: NodeJS.Timeout | undefined;
  try {
    const descendant = `
      const { writeFileSync } = require("node:fs");
      process.on("SIGTERM", () => {});
      writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid));
      process.stdout.write("DESCENDANT_READY\\n");
      Bun.serve({port: 0, fetch: () => new Response("alive")});
    `;
    const parent = `
      const { spawn } = require("node:child_process");
      require("node:fs").writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));
      spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { detached: ${detached}, stdio: ["ignore", "inherit", "inherit"] });
      Bun.serve({port: 0, fetch: () => new Response("alive")});
    `;
    // Real deadlines are the behavior under test; the watchdog also prevents leaked fixtures on failure.
    const result = await Promise.race([
      runCodingAgent([process.execPath, "-e", parent], { cwd: root, timeoutMs: 1000 }),
      new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("agent did not complete after timeout")), 7000); }),
    ]);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain("DESCENDANT_READY");
    expect(result.exitCode).not.toBe(0);
  } finally {
    clearTimeout(watchdog);
    for (const [path, group] of [[parentPidFile, true], [descendantPidFile, false]] as const) {
      const pid = Number(await readFile(path, "utf8").catch(() => ""));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(group ? -pid : pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test.skipIf(process.platform === "win32")("a successful agent cannot leave a same-group background process running", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-output-"));
  const pidFile = join(root, "descendant.pid");
  let pid = 0;
  try {
    const descendant = `
      process.on("SIGTERM", () => {});
      process.send("ready");
      Bun.serve({port: 0, fetch: () => new Response("alive")});
    `;
    const parent = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child.on("message", () => {
        require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        child.disconnect();
        process.exit(0);
      });
    `;
    const result = await runCodingAgent([process.execPath, "-e", parent], { cwd: root, timeoutMs: 5000 });
    pid = Number(await readFile(pidFile, "utf8"));
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(pid).toBeGreaterThan(0);
    // A killed orphan can briefly remain as a zombie until its adopter reaps it.
    const deadline = Date.now() + 5000;
    let state = "";
    do {
      const ps = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)]);
      state = ps.stdout.toString().trim();
      if (!state || state.startsWith("Z")) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    } while (Date.now() < deadline);
    expect(state === "" || state.startsWith("Z")).toBe(true);
  } finally {
    if (!pid) pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

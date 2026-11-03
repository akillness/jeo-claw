import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildSupervisor } from "./start.ts";

test("supervisor terminates an unresponsive child and waits for its exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jeo-supervisor-shutdown-"));
  let child: ChildProcess | undefined;
  let spawned = 0;
  const timers = new Map<object, { callback: () => void; delay: number }>();
  const supervisor = new ChildSupervisor({
    id: "discord",
    command: [process.execPath, "-e", 'process.on("SIGTERM", () => console.log("term")); process.stdin.resume(); console.log("ready")'],
    env: { HOME: dir, TMPDIR: dir, PATH: process.env.PATH ?? "" },
  }, {
    spawnChild: ((command, args, options) => {
      spawned++;
      child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
      return child;
    }) as typeof spawn,
    schedule: ((callback: () => void, delay: number) => {
      const handle = {};
      timers.set(handle, { callback, delay });
      return handle;
    }) as unknown as typeof setTimeout,
    cancel: ((handle: object) => { timers.delete(handle); }) as unknown as typeof clearTimeout,
  });
  try {
    supervisor.start();
    supervisor.start();
    if (!child?.stdout) throw new Error("child was not spawned");
    const ownedChild = child;
    const closed = once(ownedChild, "close");
    const [ready] = await once(ownedChild.stdout!, "data");
    expect(String(ready)).toBe("ready\n");
    expect(spawned).toBe(1);
    const term = once(ownedChild.stdout!, "data");
    const shutdown = supervisor.shutdown();
    const secondShutdown = supervisor.shutdown();
    const [message] = await term;
    expect(String(message)).toBe("term\n");
    const escalation = [...timers.values()].find((timer) => timer.delay === 10000);
    expect(escalation).toBeDefined();
    escalation!.callback();
    const results = await Promise.allSettled([shutdown, secondShutdown]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    const [code, signal] = await closed;
    expect({ code, signal }).toEqual({ code: null, signal: "SIGKILL" });
    supervisor.start();
    expect(spawned).toBe(1);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "close");
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test("spawn failure schedules one restart and shutdown prevents a queued restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jeo-supervisor-error-"));
  const timers = new Map<object, () => void>();
  let child: ChildProcess | undefined;
  let attempts = 0;
  const supervisor = new ChildSupervisor({ id: "discord", command: [join(dir, "missing-command")], env: { HOME: dir, TMPDIR: dir } }, {
    spawnChild: ((command, args, options) => {
      attempts++;
      child = spawn(command, args ?? [], options ?? {});
      return child;
    }) as typeof spawn,
    schedule: ((callback: () => void) => {
      const handle = {};
      timers.set(handle, callback);
      return handle;
    }) as unknown as typeof setTimeout,
    cancel: ((handle: object) => { timers.delete(handle); }) as unknown as typeof clearTimeout,
  });
  try {
    supervisor.start();
    if (!child) throw new Error("spawn was not attempted");
    const [error] = await once(child, "error");
    expect(error.code).toBe("ENOENT");
    expect(timers.size).toBe(1);
    const restart = [...timers.values()][0]!;
    await supervisor.shutdown();
    restart();
    expect(attempts).toBe(1);
    expect(timers.size).toBe(0);
  } finally {
    await supervisor.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdown rejects when an unkillable child never exits", async () => {
  const timers = new Map<object, { callback: () => void; delay: number }>();
  const child = Object.assign(new EventEmitter(), { pid: 42, kill: () => false });
  const supervisor = new ChildSupervisor({ id: "discord", command: ["synthetic"], env: {} }, {
    spawnChild: (() => child as unknown as ChildProcess) as typeof spawn,
    schedule: ((callback: () => void, delay: number) => {
      const handle = {};
      timers.set(handle, { callback, delay });
      return handle;
    }) as unknown as typeof setTimeout,
    cancel: ((handle: object) => { timers.delete(handle); }) as unknown as typeof clearTimeout,
  });
  supervisor.start();
  const shutdown = supervisor.shutdown();
  const outcome = shutdown.then(() => "resolved", () => "rejected");
  const escalation = [...timers.values()].find((timer) => timer.delay === 10000);
  expect(escalation).toBeDefined();
  escalation!.callback();
  const deadline = [...timers.values()].find((timer) => timer.delay === 5000);
  expect(deadline).toBeDefined();
  deadline!.callback();
  expect(await outcome).toBe("rejected");
});

test("shutdown reports a child failure during SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jeo-supervisor-exit-"));
  let child: ChildProcess | undefined;
  const supervisor = new ChildSupervisor({
    id: "discord",
    command: [process.execPath, "-e", 'process.on("SIGTERM", () => process.exit(7)); process.stdin.resume(); console.log("ready")'],
    env: { HOME: dir, TMPDIR: dir, PATH: process.env.PATH ?? "" },
  }, {
    spawnChild: ((command, args, options) => {
      child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
      return child;
    }) as typeof spawn,
  });
  try {
    supervisor.start();
    if (!child?.stdout) throw new Error("child was not spawned");
    const closed = once(child, "close");
    const [ready] = await once(child.stdout, "data");
    expect(String(ready)).toBe("ready\n");
    await expect(supervisor.shutdown()).rejects.toThrow();
    const [code, signal] = await closed;
    expect({ code, signal }).toEqual({ code: 7, signal: null });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "close");
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

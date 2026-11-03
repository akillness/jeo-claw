import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mocks are installed in the child before loading the entry point, preventing network access.
const fixture = `
  import { mock } from "bun:test";
  process.once("SIGTERM", () => console.log("signal observed"));
  mock.module("./discord/proxy-transport.ts", () => ({ installDiscordGatewayProxy() {} }));
  mock.module("./discord/bot.ts", () => ({
    async start() {
      const client = { destroy() {
        console.log("destroy called");
        return process.env.TEST_MODE === "repeat" ? Promise.withResolvers().promise : Promise.resolve();
      } };
      if (process.env.TEST_MODE !== "repeat") {
        console.log("startup pending");
        const gate = Promise.withResolvers();
        process.stdin.once("data", () => gate.resolve());
        await gate.promise;
      } else {
        setImmediate(() => console.log("ready"));
      }
      return client;
    },
  }));
  // A retained resource makes stalled cleanup observable as a live process.
  setInterval(() => {}, 1000);
  // This dynamic import deliberately loads the entry point after installing mocks.
  await import("./discord/proxy-main.ts");
`;

for (const [mode, expectedCode] of [["repeat", 1], ["startup-stalled", 1], ["startup-resumes", 0]] as const) {
  test(`Discord child handles SIGTERM during ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeo-proxy-signal-"));
    const child = spawn(process.execPath, ["--smol", "-e", fixture], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HTTPS_PROXY: "http://127.0.0.1:1", TEST_MODE: mode },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    // This watchdog bounds real child-process behavior, not fixture synchronization.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 8000);
    const closed = once(child, "close");
    async function waitFor(text: string, count = 1) {
      while (stdout.split(text).length - 1 < count && child.exitCode === null && child.signalCode === null) {
        await Promise.race([once(child.stdout, "data"), closed]);
      }
      expect(stdout.split(text).length - 1).toBeGreaterThanOrEqual(count);
    }
    try {
      await waitFor(mode === "repeat" ? "ready" : "startup pending");
      timer.refresh();
      child.kill("SIGTERM");
      await waitFor("signal observed");
      if (mode === "repeat") {
        await waitFor("destroy called");
        child.kill("SIGTERM");
      } else if (mode === "startup-resumes") {
        child.stdin.write("resume\n");
      }
      const [code, signal] = await closed;
      expect(timedOut).toBe(false);
      expect(signal).toBeNull();
      expect(code).toBe(expectedCode);
      expect(stdout.split("destroy called").length - 1).toBe(mode === "startup-stalled" ? 0 : 1);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 12000);
}

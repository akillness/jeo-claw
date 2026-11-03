import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real entry point is loaded only after both network-facing imports are replaced
// inside a separate process. An active handle models a Discord client that cannot close.
const fixture = `
  import { mock } from "bun:test";
  mock.module("./discord/proxy-transport.ts", () => ({ installDiscordGatewayProxy() {} }));
  mock.module("./discord/bot.ts", () => ({
    async start() {
      setImmediate(() => console.log("ready"));
      return { destroy() {
        console.log("destroy called");
        if (process.env.TEST_MODE === "stalled") return Promise.withResolvers().promise;
        if (process.env.TEST_MODE === "failure") return Promise.reject(new Error("synthetic cleanup failure"));
        return Promise.resolve();
      } };
    },
  }));
  // This active handle models resources left open by a stalled client.
  setInterval(() => {}, 1000);
  // Dynamic import is required to install the isolated mocks before entry-point evaluation.
  await import("./discord/proxy-main.ts");
`;

for (const [mode, expectedCode] of [["success", 0], ["failure", 1], ["stalled", 1]] as const) {
  test(`Discord child exits after SIGTERM when cleanup is ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeo-proxy-shutdown-"));
    const child = spawn(process.execPath, ["--smol", "-e", fixture], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HTTPS_PROXY: "http://127.0.0.1:1", TEST_MODE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    // Real clocks are required to bound an independently running child process.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 8000);
    const closed = once(child, "close");
    try {
      await Promise.race([once(child.stdout, "data"), closed]);
      expect(stdout).toContain("ready");
      timer.refresh();
      child.kill("SIGTERM");
      const [code, signal] = await closed;
      expect(timedOut).toBe(false);
      expect(signal).toBeNull();
      expect(code).toBe(expectedCode);
      expect(stdout).toContain("destroy called");
      if (mode === "failure") expect(stderr).toContain("synthetic cleanup failure");
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 12000);
}

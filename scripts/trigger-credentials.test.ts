import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const scripts = ["trigger-final.ts", "trigger-jeo.ts", "trigger-ping.ts", "trigger-user.ts"];
const syntheticSecret = "synthetic-control-secret-for-test";

async function runTrigger(script: string, secret: string | undefined) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (secret !== undefined) env.JEO_CONTROL_EVENT_SECRET = secret;
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      globalThis.fetch = async (_url, init) => {
        if (init?.headers?.["x-control-event-secret"] !== ${JSON.stringify(syntheticSecret)}) {
          throw new Error("unexpected request credential");
        }
        return new Response("offline request accepted");
      };
      // The script is runtime-selected so each entry point runs in its own process.
      await import(process.argv[1]);
    `, resolve("scripts", script)],
    cwd: tmpdir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

for (const script of scripts) {
  for (const [label, secret] of [["unset", undefined], ["empty", ""]] as const) {
    test(`${script} rejects ${label} control secret without issuing a request`, async () => {
      const result = await runTrigger(script, secret);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("JEO_CONTROL_EVENT_SECRET is required");
      expect(result.stdout).not.toContain("offline request accepted");
      expect(result.stderr).not.toContain("unexpected request credential");
    });
  }

  test(`${script} authenticates its request with the supplied control secret`, async () => {
    const result = await runTrigger(script, syntheticSecret);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("offline request accepted");
    expect(result.stderr).toBe("");
  });
}

import { test, expect } from "bun:test";

test("a wrong HTTP status makes the smoke check process fail without reporting PASS", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", 'import { assertStatus } from "./scripts/smoke-status.ts"; assertStatus("health", new Response("", { status: 503 }), 200);'],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).not.toBe(0);
  expect(stdout).not.toContain("PASS health");
  expect(stderr).toContain("health: expected 200, got 503");
});

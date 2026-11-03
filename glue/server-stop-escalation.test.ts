import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("forcing stop after graceful stop closes an in-flight connection and settles both stops", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-stop-escalation-"));
  const program = `
    import { connect } from "node:net";
    import { start } from "./glue/server.ts";
    const server = start();
    const connected = Promise.withResolvers();
    const closed = Promise.withResolvers();
    const flushed = Promise.withResolvers();
    const health = Promise.withResolvers();
    let response = "";
    const socket = connect(server.port, "127.0.0.1");
    socket.once("connect", connected.resolve);
    socket.once("close", closed.resolve);
    socket.once("error", closed.resolve);
    await connected.promise;
    const onData = (chunk) => { response += chunk.toString(); if (response.includes('"ok":true')) health.resolve(); };
    socket.on("data", onData);
    socket.write("GET /health HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: keep-alive\\r\\n\\r\\n");
    await health.promise;
    socket.off("data", onData);
    socket.write("POST /control-event HTTP/1.1\\r\\nHost: localhost\\r\\nx-control-event-secret: control\\r\\nContent-Length: 100\\r\\n\\r\\n{", flushed.resolve);
    await flushed.promise;
    const graceful = server.stop(false);
    const forced = server.stop(true);
    await Promise.all([graceful, forced, closed.promise]);
    console.log("connection closed");
  `;
  try {
    const child = spawn(process.execPath, ["-e", program], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "test", GLUE_PORT: "0", SQLITE_DB_PATH: join(root, "test.sqlite"),
        GITHUB_WEBHOOK_SECRET: "webhook", JEO_CONTROL_EVENT_SECRET: "control", GCLOUD_PROJECT: "test",
        GCLOUD_SECRET_PREFIX: "test", TARGET_REPO: "acme/repo", TARGET_BRANCH: "main",
        JEO_RUNTIME_DISPATCH_SECRET: "dispatch", JEO_STATUS_ENDPOINT: "" },
      signal: AbortSignal.timeout(3000),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const finished = Promise.withResolvers<number | null>();
    child.on("error", (error) => { stderr += String(error); });
    child.on("close", (code) => finished.resolve(code));
    expect(await finished.promise).toBe(0);
    expect(stdout).toContain("connection closed");
    expect(stderr).not.toContain("AbortError");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

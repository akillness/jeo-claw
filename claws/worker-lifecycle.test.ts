import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function startWorker(root: string, statusEndpoint?: string) {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  if (port === undefined) throw new Error("No TCP port allocated");
  await reservation.stop(true);
  const moduleUrl = pathToFileURL(join(import.meta.dir, "worker.ts")).href;
  // Dynamic import is necessary to set the worker's real CLI role before module startup.
  const script = `process.argv[2] = "reviewer"; await import(${JSON.stringify(moduleUrl)}); console.log("TEST_WORKER_READY");`;
  const child = spawn(process.execPath, ["-e", script], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TEMP: root, TMP: root, JEO_CLAW_PORT: String(port), JEO_RUNTIME_DISPATCH_SECRET: "test-secret", ...(statusEndpoint ? { JEO_STATUS_ENDPOINT: statusEndpoint } : {}) },
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("TEST_WORKER_READY")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`worker exited before ready: ${stderr}`)));
    });
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  }
  return { child, port, exited };
}

function dispatch(port: number) {
  return fetch(`http://127.0.0.1:${port}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runtime-dispatch-secret": "test-secret" },
    body: JSON.stringify({ workflowId: "wf-test", repo: "example/repo", runtime: "nullclaw", stage: "review", request: "review" }),
  });
}

test("unsupported worker stage fails instead of reporting success", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-lifecycle-"));
  try {
    const worker = await startWorker(root);
    try {
      const response = await dispatch(worker.port);
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({ success: false, error: "Unsupported worker role/stage: reviewer/review" });
    } finally {
      worker.child.kill("SIGTERM");
      await worker.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SIGTERM aborts a blocked status relay and lets the worker exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-lifecycle-"));
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { received(); return new Promise<Response>(() => {}); } });
  try {
    const worker = await startWorker(root, `http://127.0.0.1:${relay.port}/`);
    try {
      const request = dispatch(worker.port).catch(() => undefined);
      await requestReceived;
      worker.child.kill("SIGTERM");
      // The real deadline distinguishes shutdown cancellation from the relay's five-second timeout.
      let watchdog: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          worker.exited,
          new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("worker did not stop after SIGTERM")), 2500); }),
        ]);
        expect(result).toEqual({ code: 0, signal: null });
      } finally { clearTimeout(watchdog); }
      await request;
    } finally {
      worker.child.kill("SIGKILL");
      await worker.exited;
    }
  } finally {
    await relay.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

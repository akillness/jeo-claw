import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("server stop waits for request-driven secret cleanup and reports cleanup failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-request-cleanup-"));
  const program = `
    import { start, store } from "./glue/server.ts";
    import { createWorkflow, advanceStage } from "./glue/state-machine.ts";
    import { SecretAccessCleanupError } from "./secrets/loader.ts";
    const entered = Promise.withResolvers();
    const aborted = Promise.withResolvers();
    const release = Promise.withResolvers();
    let cleaned = false;
    let wf = createWorkflow("wf-request-secret", "zeroclaw", "request work", "acme/repo");
    wf = advanceStage(advanceStage(advanceStage(wf)));
    store.set(wf.id, wf);
    const server = start({ sourceFactory: () => ({ access: async (_id, signal) => {
      entered.resolve();
      if (!signal) throw new Error("missing cancellation signal");
      signal.addEventListener("abort", aborted.resolve, { once: true });
      await release.promise;
      cleaned = true;
      throw new SecretAccessCleanupError();
    } }) });
    const request = fetch(server.url.origin + "/control-event", {
      method: "POST", headers: { "x-control-event-secret": "control", "content-type": "application/json" },
      body: JSON.stringify({ type: "approve", source: "discord", workflowId: wf.id, action: "pr.create", user: "alice" }),
    }).catch(() => undefined);
    await entered.promise;
    const stopping = server.stop(true);
    await aborted.promise;
    release.resolve();
    let failure;
    try { await stopping; } catch (error) { failure = error; }
    await request;
    if (!cleaned) throw new Error("stop completed before request cleanup");
    if (!(failure instanceof AggregateError)) throw new Error("request cleanup failure was not surfaced");
    console.log("request cleanup accounted for");
  `;
  try {
    const child = spawn(process.execPath, ["-e", program], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "test", GLUE_PORT: "0", SQLITE_DB_PATH: join(root, "test.sqlite"),
        GITHUB_WEBHOOK_SECRET: "webhook", JEO_CONTROL_EVENT_SECRET: "control", GCLOUD_PROJECT: "test", GCLOUD_SECRET_PREFIX: "test",
        TARGET_REPO: "acme/repo", TARGET_BRANCH: "main", JEO_RUNTIME_DISPATCH_SECRET: "dispatch", JEO_STATUS_ENDPOINT: "" },
      signal: AbortSignal.timeout(3000), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const finished = Promise.withResolvers<number | null>();
    child.on("error", (error) => { stderr += String(error); });
    child.on("close", (code) => finished.resolve(code));
    const code = await finished.promise;
    if (code !== 0) throw new Error(`child exited ${code}: ${stderr}`);
    expect(stdout).toContain("request cleanup accounted for");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

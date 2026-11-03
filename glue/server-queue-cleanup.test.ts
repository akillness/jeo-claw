import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test.each([false, true])("server stop awaits queued secret cleanup; cleanup failure=%s", async (failCleanup) => {
  const root = mkdtempSync(join(tmpdir(), "jeo-queue-cleanup-"));
  const program = `
    import { start, store, enqueueWorkflow } from "./glue/server.ts";
    import { createWorkflow, advanceStage, applyEvent } from "./glue/state-machine.ts";
    import { SecretAccessCleanupError } from "./secrets/loader.ts";
    const entered = Promise.withResolvers();
    const aborted = Promise.withResolvers();
    const release = Promise.withResolvers();
    let cleaned = false;
    let wf = createWorkflow("wf-queued-secret", "zeroclaw", "first work", "acme/repo");
    wf = advanceStage(advanceStage(advanceStage(wf)));
    wf = applyEvent(wf, { type: "approve", action: "pr.create", user: "alice" });
    wf.status = "queued";
    store.set(wf.id, wf);
    enqueueWorkflow(wf.id, wf.repo);
    const server = start({ sourceFactory: () => ({ access: async (_id, signal) => {
      entered.resolve();
      if (!signal) throw new Error("missing cancellation signal");
      signal.addEventListener("abort", aborted.resolve, { once: true });
      await release.promise;
      cleaned = true;
      if (${failCleanup}) throw new SecretAccessCleanupError();
      throw new Error("aborted");
    } }) });
    const response = await fetch(server.url.origin + "/control-event", {
      method: "POST", headers: { "x-control-event-secret": "control", "content-type": "application/json" },
      body: JSON.stringify({ type: "request", runtime: "zeroclaw", request: "trigger queue", repo: "acme/repo" }),
    });
    if (response.status !== 201) throw new Error("queue trigger rejected: " + response.status);
    await entered.promise;
    const stopping = server.stop(true);
    await aborted.promise;
    release.resolve();
    let failure;
    try { await stopping; } catch (error) { failure = error; }
    if (!cleaned) throw new Error("stop completed before secret cleanup");
    if (${failCleanup} && !(failure instanceof AggregateError)) throw new Error("cleanup failure was not surfaced");
    if (!${failCleanup} && failure) throw failure;
    console.log("cleanup accounted for");
  `;
  try {
    const child = spawn(process.execPath, ["-e", program], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "test", GLUE_PORT: "0", MAX_CONCURRENT_WORKFLOWS: "1", SQLITE_DB_PATH: join(root, "test.sqlite"),
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
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("cleanup accounted for");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

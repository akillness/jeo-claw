import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function snapshot(root: string) {
  return readdirSync(root).filter((name) => ["workflows.sqlite", "ordinary.sqlite"].some((dbName) => name === dbName || name.startsWith(dbName + "-"))).sort().map((name) => {
    const path = join(root, name);
    return { name, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), mtime: statSync(path, { bigint: true }).mtimeNs.toString() };
  });
}

for (const configuredPath of [false, true]) {
  for (const existingDatabase of [false, true]) {
    for (const injectedStore of [true, false]) {
    test(`probe-only import, ${injectedStore ? "injected-store startup" : "startup without injected store"}, and authenticated status leave ${existingDatabase ? "existing" : "absent"} ordinary SQLite untouched (${configuredPath ? "configured path" : "working-directory path"})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "jeo-probe-sqlite-isolation-"));
      const path = join(root, configuredPath ? "ordinary.sqlite" : "workflows.sqlite");
      try {
        if (existingDatabase) {
          // A valid, closed DELETE-journal DB exposes schema initialization and WAL conversion,
          // even when no workflow row is changed.
          const db = new Database(path);
          try {
            db.run("PRAGMA journal_mode = DELETE");
            db.run("CREATE TABLE sentinel (value TEXT NOT NULL)");
            db.run("INSERT INTO sentinel VALUES ('ordinary database must remain untouched')");
          } finally {
            db.close();
          }
        }
        const before = snapshot(root);
        const program = `
          import { createHash } from "node:crypto";
          import { readFileSync, readdirSync, statSync } from "node:fs";
          import { join } from "node:path";
          ${injectedStore ? `import { SQLiteWorkflowStore } from ${JSON.stringify(fileURLToPath(new URL("./store.ts", import.meta.url)))};` : ""}
          const snapshot = () => readdirSync(process.cwd()).filter((name) => ["workflows.sqlite", "ordinary.sqlite"].some((dbName) => name === dbName || name.startsWith(dbName + "-"))).sort().map((name) => {
            const path = join(process.cwd(), name);
            return { name, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), mtime: statSync(path, { bigint: true }).mtimeNs.toString() };
          });
          // Dynamic import is intentional: observe the module-loading boundary before startup.
          const { start } = await import(${JSON.stringify(fileURLToPath(new URL("./server.ts", import.meta.url)))});
          const imported = snapshot();
          const server = start({ controlMode: "probe-only"${injectedStore ? ', store: new SQLiteWorkflowStore(":memory:")' : ""} });
          let started;
          let queried;
          try {
            const health = await fetch(server.url.origin + "/health");
            if (health.status !== 200 || (await health.json()).ok !== true) throw new Error("probe server did not become healthy");
            started = snapshot();
            const status = await fetch(server.url.origin + "/debug/workflows", {
              headers: { "x-control-event-secret": "synthetic-control" },
            });
            const body = await status.json();
            if (status.status !== 200 || JSON.stringify(body) !== JSON.stringify({ workflows: [] })) {
              throw new Error("authenticated workflow status failed: " + status.status + " " + JSON.stringify(body));
            }
            queried = snapshot();
          } finally {
            await server.stop(true);
          }
          console.log(JSON.stringify({ imported, started, queried, stopped: snapshot() }));
        `;
        const child = spawn(process.execPath, ["--smol", "-e", program], {
          cwd: root,
          env: {
            PATH: process.env.PATH, HOME: root, TMPDIR: root,
            NODE_ENV: "test", JEO_CONTROL_MODE: "probe-only", GLUE_PORT: "0",
            GITHUB_WEBHOOK_SECRET: "synthetic-webhook", JEO_CONTROL_EVENT_SECRET: "synthetic-control",
            ...(configuredPath ? { SQLITE_DB_PATH: path } : {}),
          },
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
        if (code !== 0) throw new Error(`probe child exited ${code}: ${stderr}\n${stdout}`);
        const observed = JSON.parse(stdout.trim());
        expect(observed).toEqual({ imported: before, started: before, queried: before, stopped: before });
        expect(snapshot(root)).toEqual(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    }
  }
}

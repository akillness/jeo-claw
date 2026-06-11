import { spawnSync } from "node:child_process";

export interface BrowserStatusContainer {
  service: string;
  state: string;
  health: string;
}

export interface BrowserStatusWorkflow {
  id: string;
  runtime: string;
  request: string;
  stage: string;
  status: string;
  pendingAction?: string;
  headRef?: string;
}

export interface BrowserStatusPayload {
  generatedAt: string;
  containers: BrowserStatusContainer[];
  workflows: BrowserStatusWorkflow[];
}

function runDocker(args: string[]): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `docker ${args.join(" ")} failed`).trim());
  }
  return result.stdout;
}

export function renderStatusHtml(payload: BrowserStatusPayload): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>jeo-claw runtime browser status</title>
  <link rel="icon" href="data:,">
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
    code { background: #f3f3f3; padding: 2px 4px; }
  </style>
</head>
<body>
  <h1>jeo-claw runtime browser status</h1>
  <p>Generated: ${escape(payload.generatedAt)}</p>
  <h2>Container health</h2>
  <table>
    <tr><th>Service</th><th>State</th><th>Health</th></tr>
    ${payload.containers.map((c) => `<tr><td>${escape(c.service)}</td><td>${escape(c.state)}</td><td>${escape(c.health)}</td></tr>`).join("")}
  </table>
  <h2>Current workflows</h2>
  <table>
    <tr><th>ID</th><th>Runtime</th><th>Request</th><th>Stage</th><th>Status</th><th>Pending</th><th>HeadRef</th></tr>
    ${payload.workflows.map((w) => `<tr><td><code>${escape(w.id)}</code></td><td>${escape(w.runtime)}</td><td>${escape(w.request)}</td><td>${escape(w.stage)}</td><td>${escape(w.status)}</td><td>${escape(w.pendingAction ?? "")}</td><td><code>${escape(w.headRef ?? "")}</code></td></tr>`).join("")}
  </table>
</body>
</html>`;
}

export function collectBrowserStatus(): BrowserStatusPayload {
  const psOut = runDocker(["compose", "-f", "docker-compose.yml", "-f", "docker-compose.live.yml", "ps", "--format", "json"]);
  const containers = psOut.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const row = JSON.parse(line) as { Service: string; State: string; Health?: string };
    return {
      service: row.Service,
      state: row.State,
      health: row.Health ?? "",
    } satisfies BrowserStatusContainer;
  });

  const workflowsOut = runDocker([
    "exec",
    "jeo-glue-webhook",
    "bun",
    "-e",
    "const res = await fetch('http://127.0.0.1:8787/debug/workflows'); console.log(await res.text())",
  ]);
  const workflows = (JSON.parse(workflowsOut.trim()) as { workflows: BrowserStatusWorkflow[] }).workflows;

  return {
    generatedAt: new Date().toISOString(),
    containers,
    workflows,
  };
}

export interface BrowserStatusSnapshot {
  payload: BrowserStatusPayload | null;
  error: string | null;
  refreshedAt: string | null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function startBrowserStatusServer(
  port = Number(process.env.BROWSER_STATUS_PORT ?? 18888),
  refreshMs = Number(process.env.BROWSER_STATUS_REFRESH_MS ?? 2000),
) {
  const snapshot: BrowserStatusSnapshot = {
    payload: null,
    error: null,
    refreshedAt: null,
  };

  const refresh = () => {
    try {
      snapshot.payload = collectBrowserStatus();
      snapshot.error = null;
      snapshot.refreshedAt = new Date().toISOString();
    } catch (error) {
      snapshot.error = error instanceof Error ? error.message : String(error);
      snapshot.refreshedAt = new Date().toISOString();
    }
  };

  refresh();
  const interval = setInterval(refresh, refreshMs);
  interval.unref?.();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return json(snapshot.error ? 503 : 200, {
          ok: !snapshot.error,
          containers: snapshot.payload?.containers.length ?? 0,
          workflows: snapshot.payload?.workflows.length ?? 0,
          refreshedAt: snapshot.refreshedAt,
          error: snapshot.error,
        });
      }
      if (snapshot.error || !snapshot.payload) {
        return json(500, { error: snapshot.error ?? "No browser status snapshot yet" });
      }
      if (url.pathname === "/data") {
        return json(200, snapshot.payload);
      }
      return new Response(renderStatusHtml(snapshot.payload), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });

  console.log(`[browser-status] listening on ${server.url.origin}`);
  return { server, snapshot };
}

if (import.meta.main) {
  startBrowserStatusServer();
}

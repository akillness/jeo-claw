import { verifySignature, parseWebhook } from "./github-webhook";
import { applyEvent, advanceStage, createWorkflow } from "./state-machine";
import type { WorkflowState, ControlEvent } from "./contract";

export const store = new Map<string, WorkflowState>();

const FORBIDDEN_RUNTIME_DISPATCH_FIELDS = new Set([
  "url",
  "uri",
  "command",
  "cmd",
  "shell",
  "docker",
  "path",
  "hostPath",
  "token",
  "secret",
  "env",
  "mount",
  "volume",
]);

export function validateRuntimeDispatchPayload(payload: unknown): { ok: boolean; reason?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "dispatch payload must be an object" };
  }

  const obj = payload as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_RUNTIME_DISPATCH_FIELDS.has(key)) {
      return { ok: false, reason: `forbidden dispatch field: ${key}` };
    }
  }

  const required = ["workflowId", "runtime", "role", "stage", "action"];
  for (const key of required) {
    if (typeof obj[key] !== "string" || (obj[key] as string).trim() === "") {
      return { ok: false, reason: `missing dispatch field: ${key}` };
    }
  }

  return { ok: true };
}

export async function handleControlDispatchRequest(req: Request): Promise<Response> {
  return new Response(JSON.stringify({ error: "Runtime dispatch is not implemented in this control plane" }), {
    status: 501,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleControlEventRequest(
  req: Request,
  opts: { store: Map<string, WorkflowState> }
): Promise<Response> {
  let event: ControlEvent;
  try {
    event = (await req.json()) as ControlEvent;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (event.type === "request") {
    const wfId = `wf-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const wf = createWorkflow(wfId, event.runtime, event.request);
    opts.store.set(wfId, wf);
    return new Response(JSON.stringify({ success: true, workflow: wf }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (event.type === "approve" || event.type === "reject") {
    const wf = opts.store.get(event.workflowId);
    if (!wf) {
      return new Response(JSON.stringify({ error: "Workflow not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const updated = applyEvent(wf, event);
    opts.store.set(event.workflowId, updated);
    return new Response(JSON.stringify({ success: true, workflow: updated }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (event.type === "config-set") {
    return new Response(JSON.stringify({ success: true, config: { key: event.key, value: event.value } }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "Unknown control event" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleWebhookRequest(
  req: Request,
  opts: { secret: string; store: Map<string, WorkflowState> }
): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.pathname === "/dispatch") {
    return handleControlDispatchRequest(req);
  }

  if (url.pathname === "/control-event") {
    return handleControlEventRequest(req, { store: opts.store });
  }

  const signatureHeader = req.headers.get("x-hub-signature-256") || req.headers.get("x-hub-signature") || "";
  const rawBody = await req.text();

  if (!verifySignature(rawBody, signatureHeader, opts.secret)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let parsed;
  try {
    parsed = parseWebhook(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let workflowState: WorkflowState | undefined;
  const queryId = url.searchParams.get("workflowId") || url.searchParams.get("id");
  if (queryId) {
    workflowState = opts.store.get(queryId);
  }

  if (!workflowState) {
    try {
      const payloadObj = JSON.parse(rawBody);
      const bodyId = payloadObj.workflowId ?? payloadObj.id;
      if (bodyId && typeof bodyId === "string") {
        workflowState = opts.store.get(bodyId);
      }
    } catch (_) {}
  }

  if (!workflowState && parsed.prNumber !== undefined) {
    for (const state of opts.store.values()) {
      if (state.prNumber === parsed.prNumber) {
        workflowState = state;
        break;
      }
    }
  }

  if (workflowState) {
    let nextState = applyEvent(workflowState, parsed);
    nextState = advanceStage(nextState);
    opts.store.set(nextState.id, nextState);
    return new Response(JSON.stringify({ success: true, workflow: nextState }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ success: false, message: "No matching workflow found" }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}

export function start() {
  const port = parseInt(process.env.GLUE_PORT || "8787", 10);
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("GITHUB_WEBHOOK_SECRET is missing or empty");
  }

  return Bun.serve({
    port,
    async fetch(req) {
      return handleWebhookRequest(req, { secret, store });
    },
  });
}

if (import.meta.main) {
  start();
}

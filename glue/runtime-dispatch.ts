import { DISPATCHABLE_STAGES, STAGE_TO_ROLE, CLAW_PORTS, type Role, type Stage, type Runtime, type WorkflowState } from "./contract.ts";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RuntimeDispatchDeps {
  runtimeDispatchSecret: string;
  fetchImpl?: FetchLike;
  port?: number;
  shutdownSignal?: AbortSignal;
}

export interface RuntimeDispatchResult {
  ok: true;
  artifact: string;
  output: string;
  nativeCommand: string;
  model: string;
  runtime: Runtime;
  role: Role;
  stage: Stage;
}

export function dispatchServiceName(runtime: Runtime, role: Role): string {
  return `${runtime}-${role}`;
}

export function dispatchableStage(stage: Stage): boolean {
  return (DISPATCHABLE_STAGES as readonly Stage[]).includes(stage);
}

export async function dispatchStageWork(
  workflow: WorkflowState,
  deps: RuntimeDispatchDeps,
): Promise<RuntimeDispatchResult> {
  if (!dispatchableStage(workflow.stage)) {
    throw new Error(`Stage ${workflow.stage} is not runtime-dispatchable`);
  }
  const role = STAGE_TO_ROLE[workflow.stage];
  const service = dispatchServiceName(workflow.runtime, role);
  const port = CLAW_PORTS[role] ?? deps.port ?? 8787;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(`http://${service}:${port}/dispatch`, {
      signal: deps.shutdownSignal
        ? AbortSignal.any([deps.shutdownSignal, AbortSignal.timeout(1000 * 60 * 30)])
        : AbortSignal.timeout(1000 * 60 * 30),

    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-runtime-dispatch-secret": deps.runtimeDispatchSecret,
    },
    body: JSON.stringify({
      workflowId: workflow.id,
            runtime: workflow.runtime,
            role,
            stage: workflow.stage,
            request: workflow.request,
            headRef: workflow.headRef,
            repo: workflow.repo || "akillness/jeo-claw",
    }),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const error = data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error : text.slice(0, 500);
    throw new Error(`Runtime dispatch failed for ${workflow.runtime}/${role}/${workflow.stage} (${res.status}): ${error}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      !("ok" in data) || data.ok !== true ||
      !("artifact" in data) || typeof data.artifact !== "string" || !data.artifact.trim() ||
      !("output" in data) || typeof data.output !== "string" || !data.output.trim() ||
      !("nativeCommand" in data) || typeof data.nativeCommand !== "string" || !data.nativeCommand.trim() ||
      !("model" in data) || typeof data.model !== "string" || !data.model.trim() ||
      !("runtime" in data) || data.runtime !== workflow.runtime ||
      !("role" in data) || data.role !== role ||
      !("stage" in data) || data.stage !== workflow.stage) {
    throw new Error(`Invalid runtime dispatch result for ${workflow.runtime}/${role}/${workflow.stage}`);
  }
  return data as RuntimeDispatchResult;
}

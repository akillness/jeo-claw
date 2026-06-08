import { STAGE_TO_ROLE, type Role, type Stage, type Runtime, type WorkflowState } from "./contract.ts";

export interface RuntimeDispatchDeps {
  runtimeDispatchSecret: string;
  fetchImpl?: typeof fetch;
  port?: number;
}

export interface RuntimeDispatchResult {
  success: true;
  receiptPath: string;
  runtime: Runtime;
  role: Role;
  stage: Stage;
}

export function dispatchServiceName(runtime: Runtime, role: Role): string {
  return `${runtime}-${role}`;
}

export function dispatchableStage(stage: Stage): boolean {
  return stage === "research-code" || stage === "review" || stage === "pr-review-schedule";
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
  const port = deps.port ?? 8787;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(`http://${service}:${port}/dispatch`, {
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
    }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`Runtime dispatch failed for ${workflow.runtime}/${role}/${workflow.stage} (${res.status}): ${data.error ?? text}`);
  }
  return data as RuntimeDispatchResult;
}

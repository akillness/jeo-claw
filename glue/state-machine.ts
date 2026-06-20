import type { Runtime, WorkflowState, Stage, HighRiskAction, ApprovalSnapshot } from "./contract";
import { MERGE_ACTIONS, PR_CREATE_ACTIONS, STAGES } from "./contract";
import { evaluateMergeGate } from "./merge-gate";

function now(): string {
  return new Date().toISOString();
}

function terminal(state: WorkflowState): boolean {
  return state.status === "merged" || state.status === "rejected" || state.status === "failed";
}

function hasApprovedAction(state: WorkflowState, action: HighRiskAction): boolean {
  return state.actionApprovals?.[action]?.status === "approved";
}

function acceptsActionDecision(state: WorkflowState, action: HighRiskAction): boolean {
  return state.status === "awaiting-approval" && state.pendingAction === action;
}

function markAction(state: WorkflowState, action: HighRiskAction, status: ApprovalSnapshot["status"], user?: string): WorkflowState {
  const previous = state.actionApprovals?.[action];
  return {
    ...state,
    actionApprovals: {
      ...(state.actionApprovals ?? {}),
      [action]: {
        requestedAt: previous?.requestedAt ?? now(),
        status,
        user: user ?? previous?.user,
        decidedAt: status === "approved" || status === "rejected" ? now() : previous?.decidedAt,
        consumedAt: status === "consumed" ? now() : previous?.consumedAt,
      },
    },
  };
}

function consumeActions(state: WorkflowState, actions: readonly HighRiskAction[]): WorkflowState {
  let next = state;
  for (const action of actions) {
    next = markAction(next, action, "consumed");
  }
  return next;
}

function blockForAction(state: WorkflowState, action: HighRiskAction): WorkflowState {
  const pending = state.actionApprovals?.[action];
  const withPending = pending ? state : markAction(state, action, "pending");
  return {
    ...withPending,
    pendingAction: action,
    status: "awaiting-approval",
    history: [...withPending.history, { stage: withPending.stage, at: now(), action, status: "awaiting-approval" }],
  };
}

export function createWorkflow(id: string, runtime: Runtime, request: string, repo?: string): WorkflowState {
  const initialStage: Stage = "research-code";
  return {
    id,
    runtime,
    request,
    repo,
    stage: initialStage,
    status: "running",
    history: [{ stage: initialStage, at: now(), status: "running" }],
    headRef: `jeo/${runtime}/pr-creator/${id}`,
  };
}

export function advanceStage(state: WorkflowState): WorkflowState {
  if (terminal(state)) {
    return state;
  }

  const currentIndex = STAGES.indexOf(state.stage);
  if (currentIndex === -1) {
    throw new Error(`Invalid stage: ${state.stage}`);
  }

  if (state.stage === "pr-create") {
    for (const action of PR_CREATE_ACTIONS) {
      if (!hasApprovedAction(state, action)) {
        return blockForAction(state, action);
      }
    }
  }

  if (state.stage === "merge") {
    const discordApproved = MERGE_ACTIONS.every((action) => hasApprovedAction(state, action));
    const gateInput = {
      ciPassed: state.ciPassed === true,
      reviewPassed: state.reviewPassed === true,
      discordApproved,
    };
    const gateResult = evaluateMergeGate(gateInput);

    if (!gateResult.allowed) {
      const missingApproval = MERGE_ACTIONS.find((action) => !hasApprovedAction(state, action));
      const blocked = missingApproval ? blockForAction(state, missingApproval) : state;
      return {
        ...blocked,
        status: "awaiting-approval",
        pendingAction: missingApproval ?? blocked.pendingAction,
        history: [...blocked.history, { stage: "merge", at: now(), action: missingApproval, status: "awaiting-approval" }],
      };
    }

    const consumed = consumeActions(state, MERGE_ACTIONS);
    return {
      ...consumed,
      status: "merged",
      pendingAction: undefined,
      approved: true,
      history: [...consumed.history, { stage: "merge", at: now(), action: "pr.merge", status: "merged" }],
    };
  }

  const nextStage = STAGES[currentIndex + 1];
  if (!nextStage) {
    throw new Error(`No next stage available after ${state.stage}`);
  }

  const approvedPrCreate = state.stage === "pr-create" ? consumeActions(state, PR_CREATE_ACTIONS) : state;
  return {
    ...approvedPrCreate,
    stage: nextStage,
    status: "running",
    pendingAction: undefined,
    history: [...approvedPrCreate.history, { stage: nextStage, at: now(), status: "running" }],
  };
}

export function applyEvent(
  state: WorkflowState,
  event: Partial<Pick<WorkflowState, "prNumber" | "ciPassed" | "reviewPassed">> &
    { type?: string; action?: HighRiskAction; user?: string }
): WorkflowState {
  let nextState = { ...state };

  if (terminal(nextState)) {
    return nextState;
  }

  if (event && typeof event === "object") {
    if (event.type === "approve" && event.action) {
      if (acceptsActionDecision(nextState, event.action)) {
        nextState = markAction(nextState, event.action, "approved", event.user);
        nextState.approved = event.action === "pr.merge" ? true : nextState.approved;
        if (nextState.pendingAction === event.action) nextState.pendingAction = undefined;
      }
    } else if (event.type === "reject" && event.action) {
      if (acceptsActionDecision(nextState, event.action)) {
        nextState = markAction(nextState, event.action, "rejected", event.user);
        nextState.approved = false;
        nextState.status = "rejected";
        nextState.pendingAction = event.action;
      }
    }

    if (event.prNumber !== undefined) {
      nextState.prNumber = event.prNumber;
    }
    if (event.ciPassed !== undefined) {
      nextState.ciPassed = event.ciPassed === true;
    }
    if (event.reviewPassed !== undefined) {
      nextState.reviewPassed = event.reviewPassed === true;
    }
  }

  return nextState;
}

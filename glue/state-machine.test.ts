import { test, expect } from "bun:test";
import { createWorkflow, advanceStage, applyEvent } from "./state-machine";

function moveToPendingPrCreate(state: ReturnType<typeof createWorkflow>) {
  state = advanceStage(state); // review
  state = advanceStage(state); // pr-create
  return advanceStage(state); // awaiting pr.create approval
}

function approveAndAdvancePrCreate(state: ReturnType<typeof createWorkflow>) {
  state = moveToPendingPrCreate(state);
  state = applyEvent(state, { type: "approve", action: "pr.create", user: "alice" });
  return advanceStage(state); // pr-review-schedule
}

function moveToMerge(state: ReturnType<typeof createWorkflow>) {
  state = approveAndAdvancePrCreate(state);
  return advanceStage(state); // merge
}

test("createWorkflow sets up initial state", () => {
  const state = createWorkflow("wf-1", "zeroclaw", "fix bug");
  expect(state.id).toBe("wf-1");
  expect(state.runtime).toBe("zeroclaw");
  expect(state.request).toBe("fix bug");
  expect(state.stage).toBe("research-code");
  expect(state.status).toBe("running");
  expect(state.history.length).toBe(1);
  const h0 = state.history[0];
  expect(h0).toBeDefined();
  expect(h0!.stage).toBe("research-code");
  expect(typeof h0!.at).toBe("string");
  expect(state.headRef).toBe("jeo/zeroclaw/pr-creator/wf-1");
});

test("advanceStage walks automatic stages until PR creation approval is required", () => {
  let state = createWorkflow("wf-1", "zeroclaw", "fix bug");

  state = advanceStage(state);
  expect(state.stage).toBe("review");
  expect(state.history.at(-1)!.stage).toBe("review");

  state = advanceStage(state);
  expect(state.stage).toBe("pr-create");

  state = advanceStage(state);
  expect(state.stage).toBe("pr-create");
  expect(state.status).toBe("awaiting-approval");
  expect(state.pendingAction).toBe("pr.create");
});

test("pr-create requires pr.create approval before scheduling review", () => {
  let state = moveToPendingPrCreate(createWorkflow("wf-1", "zeroclaw", "fix bug"));

  state = applyEvent(state, { type: "approve", action: "pr.create", user: "alice" });
  state = advanceStage(state);
  expect(state.stage).toBe("pr-review-schedule");
  expect(state.status).toBe("running");
  expect(state.actionApprovals?.["pr.create"]?.status).toBe("consumed");
});

test("merge stage blocks and stays awaiting-approval if conditions not met", () => {
  let state = moveToMerge(createWorkflow("wf-1", "zeroclaw", "fix bug"));

  expect(state.stage).toBe("merge");

  state = advanceStage(state);
  expect(state.stage).toBe("merge");
  expect(state.status).toBe("awaiting-approval");

  state = applyEvent(state, { ciPassed: true });
  state = advanceStage(state);
  expect(state.status).toBe("awaiting-approval");

  state = applyEvent(state, { reviewPassed: true });
  state = advanceStage(state);
  expect(state.status).toBe("awaiting-approval");
  expect(state.pendingAction).toBe("pr.merge");
});

test("merge stage merges when CI, review, and pr.merge approval are true", () => {
  let state = moveToMerge(createWorkflow("wf-1", "zeroclaw", "fix bug"));

  state = applyEvent(state, { ciPassed: true, reviewPassed: true });
  state = advanceStage(state); // awaiting pr.merge approval
  state = applyEvent(state, { type: "approve", action: "pr.merge", user: "alice" });

  state = advanceStage(state);
  expect(state.stage).toBe("merge");
  expect(state.status).toBe("merged");
  expect(state.actionApprovals?.["pr.merge"]?.status).toBe("consumed");
});

test("applyEvent sets fields and matching pending action approvals correctly", () => {
  let state = createWorkflow("wf-1", "zeroclaw", "fix bug");
  state = applyEvent(state, { prNumber: 123, ciPassed: true, reviewPassed: true });
  expect(state.prNumber).toBe(123);
  expect(state.ciPassed).toBe(true);
  expect(state.reviewPassed).toBe(true);
  expect(state.actionApprovals?.["pr.create"]?.status).toBeUndefined();

  state = moveToPendingPrCreate(createWorkflow("wf-1", "zeroclaw", "fix bug"));
  state = applyEvent(state, { type: "approve", action: "pr.create", user: "alice" });
  expect(state.actionApprovals?.["pr.create"]?.status).toBe("approved");

  let mergeState = moveToMerge(createWorkflow("wf-2", "zeroclaw", "fix bug"));
  mergeState = applyEvent(mergeState, { ciPassed: true, reviewPassed: true });
  mergeState = advanceStage(mergeState);
  mergeState = applyEvent(mergeState, { type: "reject", action: "pr.merge", user: "bob" });
  expect(mergeState.actionApprovals?.["pr.merge"]?.status).toBe("rejected");
  expect(mergeState.approved).toBe(false);
  expect(mergeState.status).toBe("rejected");
});

test("advanceStage does not resurrect rejected or merged states", () => {
  let state = moveToPendingPrCreate(createWorkflow("wf-1", "zeroclaw", "fix bug"));
  state = applyEvent(state, { type: "reject", action: "pr.create", user: "bob" });
  expect(state.status).toBe("rejected");

  const advancedReject = advanceStage(state);
  expect(advancedReject.status).toBe("rejected");

  let state2 = moveToMerge(createWorkflow("wf-2", "zeroclaw", "fix bug"));
  state2 = applyEvent(state2, { ciPassed: true, reviewPassed: true });
  state2 = advanceStage(state2);
  state2 = applyEvent(state2, { type: "approve", action: "pr.merge", user: "alice" });
  state2 = advanceStage(state2);
  expect(state2.status).toBe("merged");

  const advancedMerge = advanceStage(state2);
  expect(advancedMerge.status).toBe("merged");
});

test("legacy approved boolean cannot synthesize merge approvals", () => {
  let state = moveToMerge(createWorkflow("wf-legacy", "zeroclaw", "fix bug"));
  state = applyEvent(state, { ciPassed: true, reviewPassed: true });
  state = applyEvent(state, { approved: true } as any);
  state = advanceStage(state);
  expect(state.status).toBe("awaiting-approval");
  expect(state.actionApprovals?.["pr.merge"]?.status).not.toBe("approved");
});

test("applyEvent ignores early approvals before matching pending action", () => {
  let state = createWorkflow("wf-early", "zeroclaw", "fix bug");

  state = applyEvent(state, { type: "approve", action: "pr.merge", user: "mallory" });
  state = moveToMerge(state);
  state = applyEvent(state, { ciPassed: true, reviewPassed: true });
  state = advanceStage(state);

  expect(state.status).toBe("awaiting-approval");
  expect(state.pendingAction).toBe("pr.merge");
  expect(state.actionApprovals?.["pr.merge"]?.status).not.toBe("approved");
});

test("applyEvent does not mutate terminal workflows", () => {
  let state = moveToMerge(createWorkflow("wf-terminal", "zeroclaw", "fix bug"));
  state = applyEvent(state, { ciPassed: true, reviewPassed: true });
  state = advanceStage(state);
  state = applyEvent(state, { type: "approve", action: "pr.merge", user: "alice" });
  state = advanceStage(state);
  expect(state.status).toBe("merged");

  const afterReject = applyEvent(state, { type: "reject", action: "pr.merge", user: "mallory" });
  const afterWebhook = applyEvent(state, { ciPassed: false, reviewPassed: false, prNumber: 999 });

  expect(afterReject).toEqual(state);
  expect(afterWebhook).toEqual(state);
});

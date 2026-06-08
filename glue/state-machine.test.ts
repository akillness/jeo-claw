import { test, expect } from "bun:test";
import { createWorkflow, advanceStage, applyEvent } from "./state-machine";

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

test("pr-create requires pr.create and git.push approvals before scheduling review", () => {
  let state = createWorkflow("wf-1", "zeroclaw", "fix bug");
  state = advanceStage(state); // review
  state = advanceStage(state); // pr-create

  state = applyEvent(state, { type: "approve", action: "pr.create", user: "alice" });
  state = advanceStage(state);
  expect(state.stage).toBe("pr-create");
  expect(state.status).toBe("awaiting-approval");
  expect(state.pendingAction).toBe("git.push");

  state = applyEvent(state, { type: "approve", action: "git.push", user: "alice" });
  state = advanceStage(state);
  expect(state.stage).toBe("pr-review-schedule");
  expect(state.status).toBe("running");
  expect(state.actionApprovals?.["pr.create"]?.status).toBe("consumed");
  expect(state.actionApprovals?.["git.push"]?.status).toBe("consumed");
});

test("merge stage blocks and stays awaiting-approval if conditions not met", () => {
  let state = createWorkflow("wf-1", "zeroclaw", "fix bug");
  state = advanceStage(state); // review
  state = advanceStage(state); // pr-create
  state = applyEvent(state, { type: "approve", action: "pr.create", user: "alice" });
  state = applyEvent(state, { type: "approve", action: "git.push", user: "alice" });
  state = advanceStage(state); // pr-review-schedule
  state = advanceStage(state); // merge

  expect(state.stage).toBe("merge");

  state = advanceStage(state);
  expect(state.stage).toBe("merge");
  expect(state.status).toBe("awaiting-approval");

  state = applyEvent(state, { ciPassed: true });
  state = advanceStage(state);
  expect(state.status).toBe("awaiting-approval");

  state = applyEvent(state, { reviewPassed: true });
  state = applyEvent(state, { type: "approve", action: "git.merge", user: "alice" });
  state = advanceStage(state);
  expect(state.status).toBe("awaiting-approval");
  expect(state.pendingAction).toBe("pr.merge");
});

test("merge stage merges when CI, review, git.merge approval, and pr.merge approval are true", () => {
  let state = createWorkflow("wf-1", "zeroclaw", "fix bug");
  state = advanceStage(state); // review
  state = advanceStage(state); // pr-create
  state = applyEvent(state, { type: "approve", action: "pr.create", user: "alice" });
  state = applyEvent(state, { type: "approve", action: "git.push", user: "alice" });
  state = advanceStage(state); // pr-review-schedule
  state = advanceStage(state); // merge

  state = applyEvent(state, { ciPassed: true, reviewPassed: true });
  state = applyEvent(state, { type: "approve", action: "git.merge", user: "alice" });
  state = applyEvent(state, { type: "approve", action: "pr.merge", user: "alice" });

  state = advanceStage(state);
  expect(state.stage).toBe("merge");
  expect(state.status).toBe("merged");
  expect(state.actionApprovals?.["git.merge"]?.status).toBe("consumed");
  expect(state.actionApprovals?.["pr.merge"]?.status).toBe("consumed");
});

test("applyEvent sets fields and action approvals correctly", () => {
  let state = createWorkflow("wf-1", "zeroclaw", "fix bug");
  state = applyEvent(state, { prNumber: 123, ciPassed: true, reviewPassed: true });
  expect(state.prNumber).toBe(123);
  expect(state.ciPassed).toBe(true);
  expect(state.reviewPassed).toBe(true);

  state = applyEvent(state, { type: "approve", action: "pr.create", user: "alice" });
  expect(state.actionApprovals?.["pr.create"]?.status).toBe("approved");

  state = applyEvent(state, { type: "reject", action: "pr.merge", user: "bob" });
  expect(state.actionApprovals?.["pr.merge"]?.status).toBe("rejected");
  expect(state.approved).toBe(false);
  expect(state.status).toBe("rejected");
});

test("advanceStage does not resurrect rejected or merged states", () => {
  let state = createWorkflow("wf-1", "zeroclaw", "fix bug");
  state = applyEvent(state, { type: "reject", action: "pr.create", user: "bob" });
  expect(state.status).toBe("rejected");

  const advancedReject = advanceStage(state);
  expect(advancedReject.status).toBe("rejected");

  let state2 = createWorkflow("wf-2", "zeroclaw", "fix bug");
  state2 = advanceStage(state2); // review
  state2 = advanceStage(state2); // pr-create
  state2 = applyEvent(state2, { type: "approve", action: "pr.create", user: "alice" });
  state2 = applyEvent(state2, { type: "approve", action: "git.push", user: "alice" });
  state2 = advanceStage(state2); // pr-review-schedule
  state2 = advanceStage(state2); // merge
  state2 = applyEvent(state2, { ciPassed: true, reviewPassed: true });
  state2 = applyEvent(state2, { type: "approve", action: "git.merge", user: "alice" });
  state2 = applyEvent(state2, { type: "approve", action: "pr.merge", user: "alice" });
  state2 = advanceStage(state2);
  expect(state2.status).toBe("merged");

  const advancedMerge = advanceStage(state2);
  expect(advancedMerge.status).toBe("merged");
});
test("legacy approved boolean cannot synthesize merge approvals", () => {
  let state = createWorkflow("wf-legacy", "zeroclaw", "fix bug");
  state = advanceStage(state); // review
  state = advanceStage(state); // pr-create
  state = applyEvent(state, { type: "approve", action: "pr.create", user: "alice" });
  state = applyEvent(state, { type: "approve", action: "git.push", user: "alice" });
  state = advanceStage(state); // pr-review-schedule
  state = advanceStage(state); // merge
  state = applyEvent(state, { ciPassed: true, reviewPassed: true });
  state = applyEvent(state, { approved: true } as any);
  state = advanceStage(state);
  expect(state.status).toBe("awaiting-approval");
  expect(state.actionApprovals?.["git.merge"]?.status).not.toBe("approved");
  expect(state.actionApprovals?.["pr.merge"]?.status).not.toBe("approved");
});

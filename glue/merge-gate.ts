import type { MergeGateInput, MergeGateResult } from "./contract";

export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
  const reasons: string[] = [];
  if (input.ciPassed !== true) {
    reasons.push("CI not passed");
  }
  if (input.reviewPassed !== true) {
    reasons.push("review not passed");
  }
  if (input.discordApproved !== true) {
    reasons.push("Discord approval missing");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

import type { MergeGateInput, MergeGateResult } from "./contract";

export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
  const reasons: string[] = [];
  
  // Edge case defense: Ensure input is an object
  if (!input || typeof input !== "object") {
    return { allowed: false, reasons: ["Invalid input"] };
  }

  // 1. CI must pass
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


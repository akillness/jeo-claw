import { HIGH_RISK_ACTIONS, type HighRiskAction } from "../glue/contract.ts";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed";
export interface ApprovalRecord {
  status: ApprovalStatus;
  user?: string;
  requestedAt: string;
  decidedAt?: string;
  consumedAt?: string;
}

const HIGH_RISK_SET = new Set<string>(HIGH_RISK_ACTIONS);

function keyFor(workflowId: string, action: HighRiskAction): string {
  return `${workflowId}:${action}`;
}

export function isHighRiskAction(action: string): action is HighRiskAction {
  return HIGH_RISK_SET.has(action);
}

export class ApprovalRegistry {
  private states = new Map<string, ApprovalRecord>();

  requirePending(workflowId: string, action: HighRiskAction): void {
    const key = keyFor(workflowId, action);
    if (!this.states.has(key)) {
      this.states.set(key, { status: "pending", requestedAt: new Date().toISOString() });
    }
  }

  approve(workflowId: string, action: HighRiskAction, user: string): void {
    const current = this.record(workflowId, action);
    this.states.set(keyFor(workflowId, action), {
      requestedAt: current?.requestedAt ?? new Date().toISOString(),
      status: "approved",
      user,
      decidedAt: new Date().toISOString(),
    });
  }

  reject(workflowId: string, action: HighRiskAction, user: string): void {
    const current = this.record(workflowId, action);
    this.states.set(keyFor(workflowId, action), {
      requestedAt: current?.requestedAt ?? new Date().toISOString(),
      status: "rejected",
      user,
      decidedAt: new Date().toISOString(),
    });
  }

  isApproved(workflowId: string, action: HighRiskAction): boolean {
    return this.record(workflowId, action)?.status === "approved";
  }

  consume(workflowId: string, action: HighRiskAction): boolean {
    const current = this.record(workflowId, action);
    if (current?.status !== "approved") return false;
    this.states.set(keyFor(workflowId, action), {
      ...current,
      status: "consumed",
      consumedAt: new Date().toISOString(),
    });
    return true;
  }

  status(workflowId: string, action: HighRiskAction): ApprovalStatus | undefined {
    return this.record(workflowId, action)?.status;
  }

  getApprover(workflowId: string, action: HighRiskAction): string | undefined {
    return this.record(workflowId, action)?.user;
  }

  record(workflowId: string, action: HighRiskAction): ApprovalRecord | undefined {
    return this.states.get(keyFor(workflowId, action));
  }
}

/**
 * Guards high-risk actions. High-risk actions (pr.create, git.push, git.merge, pr.merge)
 * are allowed ONLY when registry has a matching unconsumed Discord approval for the same
 * workflow id and the same action. The approval is consumed on allow so it cannot authorize
 * another write action or a later retry.
 */
export function guardHighRisk(
  action: string,
  workflowId: string,
  registry: ApprovalRegistry
): { allowed: boolean; reason?: string } {
  if (!isHighRiskAction(action)) {
    return { allowed: true };
  }

  if (registry.consume(workflowId, action)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `High-risk action ${action} requires unconsumed Discord approval for workflow ${workflowId}`,
  };
}

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

const DEFAULT_MAX_APPROVAL_RECORDS = 1000;
const DEFAULT_APPROVAL_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface ApprovalRegistryOptions {
  maxRecords?: number;
  retentionMs?: number;
  now?: () => number;
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordLastTouchedMs(record: ApprovalRecord): number {
  return Math.max(timestampMs(record.requestedAt), timestampMs(record.decidedAt), timestampMs(record.consumedAt));
}

function recordEvictionRank(record: ApprovalRecord): number {
  if (record.status === "consumed" || record.status === "rejected") return 0;
  if (record.status === "pending") return 1;
  return 2;
}

function keyFor(workflowId: string, action: HighRiskAction): string {
  return `${workflowId}:${action}`;
}

export function isHighRiskAction(action: string): action is HighRiskAction {
  return HIGH_RISK_SET.has(action);
}

export class ApprovalRegistry {
  private states = new Map<string, ApprovalRecord>();

  constructor(private readonly options: ApprovalRegistryOptions = {}) {}

  private nowIso(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }


  private remember(key: string, record: ApprovalRecord): void {
    this.states.set(key, record);
    this.prune();
  }

  prune(): void {
    const now = this.options.now?.() ?? Date.now();
    const retentionMs = this.options.retentionMs ?? DEFAULT_APPROVAL_RETENTION_MS;
    for (const [key, record] of this.states) {
      if ((record.status === "consumed" || record.status === "rejected") && now - recordLastTouchedMs(record) > retentionMs) {
        this.states.delete(key);
      }
    }

    const maxRecords = Math.max(1, this.options.maxRecords ?? DEFAULT_MAX_APPROVAL_RECORDS);
    if (this.states.size <= maxRecords) return;

    const candidates = [...this.states.entries()].sort(([, a], [, b]) => {
      const rankDelta = recordEvictionRank(a) - recordEvictionRank(b);
      if (rankDelta !== 0) return rankDelta;
      return recordLastTouchedMs(a) - recordLastTouchedMs(b);
    });
    while (this.states.size > maxRecords) {
      const candidate = candidates.shift();
      if (!candidate) break;
      this.states.delete(candidate[0]);
    }
  }

  requirePending(workflowId: string, action: HighRiskAction): void {
    const key = keyFor(workflowId, action);
    if (!this.states.has(key)) {
      this.remember(key, { status: "pending", requestedAt: this.nowIso() });
    }
  }

  approve(workflowId: string, action: HighRiskAction, user: string): void {
    const current = this.record(workflowId, action);
    this.remember(keyFor(workflowId, action), {
      requestedAt: current?.requestedAt ?? this.nowIso(),
      status: "approved",
      user,
      decidedAt: this.nowIso(),
    });
  }

  reject(workflowId: string, action: HighRiskAction, user: string): void {
    const current = this.record(workflowId, action);
    this.remember(keyFor(workflowId, action), {
      requestedAt: current?.requestedAt ?? this.nowIso(),
      status: "rejected",
      user,
      decidedAt: this.nowIso(),
    });
  }

  isApproved(workflowId: string, action: HighRiskAction): boolean {
    return this.record(workflowId, action)?.status === "approved";
  }

  consume(workflowId: string, action: HighRiskAction): boolean {
    const current = this.record(workflowId, action);
    if (current?.status !== "approved") return false;
    this.remember(keyFor(workflowId, action), {
      ...current,
      status: "consumed",
      consumedAt: this.nowIso(),
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
 * Guards high-risk actions. High-risk actions (pr.create, pr.merge)
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

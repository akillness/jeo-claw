// Shared contract for the orchestration glue, Discord control, and A/B comparison.
// All three modules (glue/, discord/, compare/) import types from here so they stay consistent.

export type Runtime = "zeroclaw" | "nullclaw";

export const ORCHESTRATOR_STATUS_PORT = 9100;
export const ORCHESTRATOR_WEBHOOK_PORT = 8787;

export const RUNTIMES = ["zeroclaw", "nullclaw"] as const satisfies readonly Runtime[];

// LLM provider identity shared by both runtimes. A/B fairness requires one identical
// provider per comparison, so the union only contains providers BOTH runtimes support.
// Phase 1: ChatGPT subscription OAuth ("openai-codex"). A future "gemini" (Antigravity)
// entry is deferred until NullClaw gains Google/Gemini OAuth support upstream.
export type LLMProvider = "openai-codex";

export const LLM_PROVIDERS = ["openai-codex"] as const satisfies readonly LLMProvider[];

export const DEFAULT_LLM_PROVIDER: LLMProvider = "openai-codex";

export function parseLLMProvider(value: unknown): LLMProvider | undefined {
  return typeof value === "string" && (LLM_PROVIDERS as readonly string[]).includes(value)
    ? (value as LLMProvider)
    : undefined;
}

export type Role =
  | "researcher-coder"
  | "reviewer"
  | "pr-creator"
  | "pr-review-scheduler"
  | "merger";

export const ROLES = [
  "researcher-coder",
  "reviewer",
  "pr-creator",
  "pr-review-scheduler",
  "merger",
] as const satisfies readonly Role[];

export const WRITE_ROLES = ["pr-creator", "merger"] as const satisfies readonly Role[];

export const CLAW_PORTS: Record<Role, number> = {
  "researcher-coder": 9201,
  "reviewer": 9202,
  "pr-creator": 9203,
  "pr-review-scheduler": 9204,
  "merger": 9205
};

// Ordered pipeline stages. Each stage maps 1:1 to a role.
export const STAGES = [
  "research-code",
  "review",
  "pr-create",
  "pr-review-schedule",
  "merge",
] as const;
export const DISPATCHABLE_STAGES = ["research-code", "review", "pr-review-schedule"] as const satisfies readonly Stage[];
export type Stage = (typeof STAGES)[number];

export const STAGE_TO_ROLE = {
  "research-code": "researcher-coder",
  review: "reviewer",
  "pr-create": "pr-creator",
  "pr-review-schedule": "pr-review-scheduler",
  merge: "merger",
} as const satisfies Record<Stage, Role>;

export const HIGH_RISK_ACTIONS = ["pr.create", "pr.merge"] as const;
export type HighRiskAction = (typeof HIGH_RISK_ACTIONS)[number];
export type WorkflowAction = HighRiskAction | "research-code" | "review" | "pr-review-schedule" | "ci.update" | "review.update";

export const PR_CREATE_ACTIONS = ["pr.create"] as const satisfies readonly HighRiskAction[];
export const MERGE_ACTIONS = ["pr.merge"] as const satisfies readonly HighRiskAction[];

export type WorkflowStatus = "queued" | "pending" | "running" | "awaiting-approval" | "merged" | "rejected" | "failed";

export interface ApprovalSnapshot {
  status: "pending" | "approved" | "rejected" | "consumed";
  user?: string;
  requestedAt?: string;
  decidedAt?: string;
  consumedAt?: string;
}

export interface WorkflowState {
  id: string;
  runtime: Runtime;
  request: string;
  stage: Stage;
  status: WorkflowStatus;
  prNumber?: number;
  ciPassed?: boolean;
  reviewPassed?: boolean;
  /** @deprecated Use actionApprovals keyed by HighRiskAction. */
  approved?: boolean;
  pendingAction?: HighRiskAction;
  actionApprovals?: Partial<Record<HighRiskAction, ApprovalSnapshot>>;
  history: { stage: Stage; at: string; action?: WorkflowAction; status?: WorkflowStatus }[];
  headRef?: string;
  prUrl?: string;
  mergedAt?: string;
}

// Inputs to the merge policy gate. Merge is allowed ONLY when all three are boolean true.
export interface MergeGateInput {
  ciPassed: boolean;
  reviewPassed: boolean;
  discordApproved: boolean;
}

export interface MergeGateResult {
  allowed: boolean;
  reasons: string[]; // why blocked (empty when allowed)
}

// Events the Discord control surface emits to the glue.
export type ControlEvent =
  | { type: "request"; runtime: Runtime; request: string }
  | { type: "request"; source: "discord"; runtime: Runtime; request: string; repo?: string; baseBranch?: string; flow?: "direct" | "scheduled"; scheduledAt?: string }
  | { type: "approve"; workflowId: string; action: HighRiskAction; user: string }
  | { type: "approve"; source: "discord"; workflowId: string; action: HighRiskAction; user: string }
  | { type: "reject"; workflowId: string; action: HighRiskAction; user: string }
  | { type: "reject"; source: "discord"; workflowId: string; action: HighRiskAction; user: string }
  | { type: "config-set"; key: ConfigKey; value: string };

export type ConfigKey = "provider" | "model" | "autonomy" | "scaleout";

// Status notifications the glue emits back to Discord.
export interface StatusNotification {
  workflowId: string;
  runtime: Runtime;
  stage: Stage;
  status: WorkflowStatus;
  action?: WorkflowAction;
  message: string;
}

// One A/B comparison metric sample for a single E2E run.
export interface MetricSample {
  runtime: Runtime;
  run: number;
  latencyMs: number; // 응답시간
  ramMb: number; // 자원 (RAM)
  cpuPct: number; // 자원 (CPU)
  ciPassed: boolean; // PR 품질 (CI 통과)
  tokenCost: number; // 비용
  failed: boolean; // 안정성 (실패)
}

export const METRIC_KEYS = ["latencyMs", "ramMb", "cpuPct", "ciPassRate", "tokenCost", "failureRate"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface RuntimeMetricSummary {
  runtime: Runtime;
  runs: number;
  latencyMs: number; // avg
  ramMb: number; // avg
  cpuPct: number; // avg
  ciPassRate: number; // 0..1
  tokenCost: number; // avg
  failureRate: number; // 0..1
}

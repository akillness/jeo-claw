import { HIGH_RISK_ACTIONS, parseLLMProvider, type ControlEvent, type Runtime, type ConfigKey, type HighRiskAction } from "../glue/contract.ts";

const VALID_ACTIONS = new Set<string>(HIGH_RISK_ACTIONS);

function parseAction(value: string | undefined): HighRiskAction | undefined {
  if (!value) return undefined;
  return VALID_ACTIONS.has(value) ? (value as HighRiskAction) : undefined;
}

export function validateConfigValue(key: ConfigKey, value: string): { ok: boolean; reason?: string } {
  const trimmed = value.trim();
  if (key === "autonomy") {
    if (trimmed !== "supervised") {
      return { ok: false, reason: "Autonomy must be 'supervised'." };
    }
  } else if (key === "scaleout") {
    const num = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || isNaN(num) || num < 1 || num > 3) {
      return { ok: false, reason: "Scaleout must be an integer between 1 and 3." };
    }
  } else if (key === "provider") {
    if (!parseLLMProvider(trimmed)) {
      return { ok: false, reason: "Invalid LLM provider." };
    }
  } else if (key === "model") {
    if (trimmed.length === 0) {
      return { ok: false, reason: "Value for model cannot be empty." };
    }
  }
  return { ok: true };
}

export function parseRepoRef(input: string): { owner: string; repo: string; branch?: string; rest?: string } | undefined {
  const match = input.match(/(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/@\s]+)(?:@([^\s]+))?/i);
  if (match) {
    const [, owner, repo, branch] = match;
    const rest = input.replace(match[0], "").trim();
    return { owner, repo, branch: branch || undefined, rest };
  }
  return undefined;
}

export function parseCommand(
  input: string,
  user?: string,
  mentioned?: boolean
): ControlEvent | { type: "unknown"; raw: string } {
  const trimmed = input.trim();
  const normalized = trimmed.startsWith("/") ? trimmed.slice(1).trim() : trimmed;

  const requestRegex = /^request\s+(\S+)\s+(.+)$/i;
  const requestMatch = normalized.match(requestRegex);
  if (requestMatch) {
    const runtimeStr = requestMatch[1]?.toLowerCase();
    const reqStr = requestMatch[2];
    if (reqStr && (runtimeStr === "zeroclaw" || runtimeStr === "nullclaw")) {
      return {
        type: "request",
        source: "discord",
        runtime: runtimeStr as Runtime,
        request: reqStr.trim(),
      };
    }
    return { type: "unknown", raw: input };
  }

  const approveRegex = /^approve\s+(\S+)\s+(\S+)$/i;
  const approveMatch = normalized.match(approveRegex);
  if (approveMatch) {
    const wfId = approveMatch[1];
    const action = parseAction(approveMatch[2]);
    if (wfId && action) {
      return {
        type: "approve",
        source: "discord",
        workflowId: wfId,
        action,
        user: user || "unknown",
      };
    }
    return { type: "unknown", raw: input };
  }

  const rejectRegex = /^reject\s+(\S+)\s+(\S+)$/i;
  const rejectMatch = normalized.match(rejectRegex);
  if (rejectMatch) {
    const wfId = rejectMatch[1];
    const action = parseAction(rejectMatch[2]);
    if (wfId && action) {
      return {
        type: "reject",
        source: "discord",
        workflowId: wfId,
        action,
        user: user || "unknown",
      };
    }
    return { type: "unknown", raw: input };
  }

  const configRegex = /^config\s+set\s+(\S+)\s+(.+)$/i;
  const configMatch = normalized.match(configRegex);
  if (configMatch) {
    const keyStr = configMatch[1]?.toLowerCase();
    const valStr = configMatch[2];
    const validKeys: ConfigKey[] = ["provider", "model", "autonomy", "scaleout"];
    if (keyStr && valStr && validKeys.includes(keyStr as ConfigKey)) {
      return {
        type: "config-set",
        key: keyStr as ConfigKey,
        value: valStr.trim(),
      };
    }
    return { type: "unknown", raw: input };
  }

  if (mentioned) {
    return {
      type: "request",
      source: "discord",
      runtime: "zeroclaw",
      request: normalized,
    };
  }

  return { type: "unknown", raw: input };
}

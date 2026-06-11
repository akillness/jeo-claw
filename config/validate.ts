// Validates that the two runtime configs are A/B-fair and secret-safe:
//  - identical OpenAI model + wire API across ZeroClaw and NullClaw
//  - OpenAI auth is required through env-referenced Secret Manager injection
//  - autonomy=supervised in both
//  - all 5 roles present in both
//  - SOP agent keys map exactly to the canonical glue stage contract
//  - write gates are Discord-approved and configs contain no static write access
//  - every secret value is an ${ENV} reference (no inline plaintext)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HIGH_RISK_ACTIONS, ROLES, STAGES, STAGE_TO_ROLE, WRITE_ROLES, LLM_PROVIDERS } from "../glue/contract.ts";
export const CFG_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_KEY_TO_STAGE: Record<string, string> = {
  researcher_coder: "research-code",
  reviewer: "review",
  pr_creator: "pr-create",
  pr_review_scheduler: "pr-review-schedule",
  merger: "merge",
};
const WRITE_ROLE_SET = new Set<string>(WRITE_ROLES);
const ENV_REF = /^\$\{[A-Z_]+\}$/;

export type Check = { name: string; ok: boolean; detail: string };

// Bun parses TOML natively via import; we read+parse with Bun.TOML for testability.
export function loadZeroclaw(dir = CFG_DIR): any {
  return Bun.TOML.parse(readFileSync(join(dir, "zeroclaw.config.toml"), "utf8"));
}
export function loadNullclaw(dir = CFG_DIR): any {
  return JSON.parse(readFileSync(join(dir, "nullclaw.config.json"), "utf8"));
}

function collectSecretValues(obj: any, out: string[] = []): string[] {
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && /(api_key|token|secret)/i.test(k)) out.push(v);
      else if (v && typeof v === "object") collectSecretValues(v, out);
    }
  }
  return out;
}

export function rolesOf(cfg: any): string[] {
  return Object.values<any>(cfg.agents ?? {}).map((a) => a.role).filter(Boolean);
}

function sopStagesOf(label: "zeroclaw" | "nullclaw", cfg: any): string[] {
  return label === "zeroclaw" ? (cfg.sop?.pipelines?.pr_flow?.stages ?? []) : (cfg.sop?.pr_flow?.stages ?? []);
}

function canonicalStagesFor(agentKeys: string[]): string[] {
  return agentKeys.map((key) => AGENT_KEY_TO_STAGE[key] ?? `unknown:${key}`);
}

function unknownWriteKeys(obj: any, path = "$", out: string[] = []): string[] {
  if (!obj || typeof obj !== "object") return out;
  for (const [key, value] of Object.entries(obj)) {
    const current = `${path}.${key}`;
    if (/write_access|write_token|github_token_rw/i.test(key)) out.push(current);
    if (value && typeof value === "object") unknownWriteKeys(value, current, out);
  }
  return out;
}

export function validateConfigs(dir = CFG_DIR): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

  const zc = loadZeroclaw(dir);
  const nc = loadNullclaw(dir);

  const provider = nc.provider?.type;
  const zcModel = provider ? zc.providers?.models?.[provider]?.coding?.model : undefined;
  const ncModel = nc.provider?.model;
  add("identical model (A/B fairness)", zcModel === ncModel && !!zcModel, `${zcModel} vs ${ncModel}`);

  const zcProviders = Object.keys(zc.providers?.models ?? {});
  const isIdenticalProvider = zcProviders.length === 1 && zcProviders[0] === provider;
  const isSupportedProvider = provider && (LLM_PROVIDERS as readonly string[]).includes(provider);
  add("identical provider type", !!isIdenticalProvider && !!isSupportedProvider, `nullclaw=${provider}, zeroclaw=${zcProviders.join(",")}`);

  const zcWireApi = provider ? zc.providers?.models?.[provider]?.coding?.wire_api : undefined;
  const ncWireApi = nc.provider?.wire_api;
  add("identical wire API", zcWireApi === ncWireApi && !!zcWireApi, `${zcWireApi} vs ${ncWireApi}`);

  const zcRequiresAuth = provider ? zc.providers?.models?.[provider]?.coding?.requires_openai_auth : undefined;
  add("zeroclaw requires OpenAI auth", zcRequiresAuth === true, String(zcRequiresAuth));

  const zcProviderBlock = provider ? zc.providers?.models?.[provider]?.coding : undefined;
  const ncProviderBlock = nc.provider;
  const zcHasApiKey = zcProviderBlock ? ("api_key" in zcProviderBlock) : false;
  const ncHasApiKey = ncProviderBlock ? ("api_key" in ncProviderBlock) : false;
  add("zeroclaw provider lacks api_key", !zcHasApiKey, zcHasApiKey ? "present" : "absent");
  add("nullclaw provider lacks api_key", !ncHasApiKey, ncHasApiKey ? "present" : "absent");

  add("zeroclaw autonomy supervised", zc.risk?.profiles?.default?.autonomy === "supervised", "");
  add("nullclaw autonomy supervised", nc.autonomy === "supervised", "");

  const zcRoles = rolesOf(zc).sort();
  const ncRoles = rolesOf(nc).sort();
  add("zeroclaw has all 5 roles", JSON.stringify(zcRoles) === JSON.stringify([...ROLES].sort()), zcRoles.join(","));
  add("nullclaw has all 5 roles", JSON.stringify(ncRoles) === JSON.stringify([...ROLES].sort()), ncRoles.join(","));

  for (const [label, cfg] of [["zeroclaw", zc], ["nullclaw", nc]] as const) {
    const agentKeys = sopStagesOf(label, cfg);
    const canonicalStages = canonicalStagesFor(agentKeys);
    const approvalAgents = label === "zeroclaw" ? (cfg.sop?.pipelines?.pr_flow?.approval_required ?? []) : (cfg.sop?.pr_flow?.approval_required ?? []);
    add(`${label} SOP maps to canonical stages`, JSON.stringify(canonicalStages) === JSON.stringify(STAGES), canonicalStages.join(","));
    add(`${label} SOP roles match stage contract`, canonicalStages.every((stage) => STAGE_TO_ROLE[stage as keyof typeof STAGE_TO_ROLE] !== undefined), canonicalStages.join(","));
    add(`${label} approval agents map to write stages`, JSON.stringify(canonicalStagesFor(approvalAgents).sort()) === JSON.stringify(["merge", "pr-create"].sort()), JSON.stringify(approvalAgents));
  }

  for (const [label, cfg] of [["zeroclaw", zc], ["nullclaw", nc]] as const) {
    const offenders = Object.values<any>(cfg.agents ?? {})
      .filter((a) => a.write_access && !WRITE_ROLE_SET.has(a.role))
      .map((a) => a.role);
    const writeKeys = unknownWriteKeys(cfg);
    add(`${label} no static write authority`, offenders.length === 0 && writeKeys.length === 0, [...offenders, ...writeKeys].join(",") || "ok");
  }
  for (const [label, cfg] of [["zeroclaw", zc], ["nullclaw", nc]] as const) {
    const highRisk = label === "zeroclaw" ? cfg.risk?.profiles?.default?.high_risk : cfg.high_risk;
    add(
      `${label} high-risk action parity`,
      JSON.stringify([...(highRisk ?? [])].sort()) === JSON.stringify([...HIGH_RISK_ACTIONS].sort()),
      JSON.stringify(highRisk ?? []),
    );
  }

  // All secret-bearing values are ${ENV} refs.
  for (const [label, cfg] of [["zeroclaw", zc], ["nullclaw", nc]] as const) {
    const secrets = collectSecretValues(cfg);
    const bad = secrets.filter((s) => !ENV_REF.test(s));
    add(`${label} secrets are env-refs only`, bad.length === 0, bad.join(",") || `${secrets.length} refs ok`);
  }


  // PR creator and merger require approval in SOP (both); PR create and merge are the write gates.
  const requiredApprovalAgents = ["pr_creator", "merger"];
  for (const agent of requiredApprovalAgents) {
    add(`zeroclaw ${agent} requires approval`, (zc.sop?.pipelines?.pr_flow?.approval_required ?? []).includes(agent), "");
    add(`nullclaw ${agent} requires approval`, (nc.sop?.pr_flow?.approval_required ?? []).includes(agent), "");
  }

  return checks;
}

if (import.meta.main) {
  const checks = validateConfigs();
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

// Validates that the two runtime configs are A/B-fair and secret-safe:
//  - identical provider type + model across ZeroClaw and NullClaw
//  - autonomy=supervised in both
//  - all 5 roles present in both
//  - only pr-creator/merger carry write access
//  - every secret value is an ${ENV} reference (no inline plaintext)
//  - a Discord channel is configured in both
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HIGH_RISK_ACTIONS } from "../glue/contract.ts";

export const CFG_DIR = dirname(fileURLToPath(import.meta.url));
const ROLES = ["researcher-coder", "reviewer", "pr-creator", "pr-review-scheduler", "merger"];
const WRITE_ROLES = new Set(["pr-creator", "merger"]);
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

export function validateConfigs(dir = CFG_DIR): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

  const zc = loadZeroclaw(dir);
  const nc = loadNullclaw(dir);

  const zcModel = zc.providers?.models?.openai?.coding?.model;
  const ncModel = nc.provider?.model;
  add("identical model (A/B fairness)", zcModel === ncModel && !!zcModel, `${zcModel} vs ${ncModel}`);
  add("identical provider type", nc.provider?.type === "openai", `nullclaw=${nc.provider?.type}`);

  add("zeroclaw autonomy supervised", zc.risk?.profiles?.default?.autonomy === "supervised", "");
  add("nullclaw autonomy supervised", nc.autonomy === "supervised", "");

  const zcRoles = rolesOf(zc).sort();
  const ncRoles = rolesOf(nc).sort();
  add("zeroclaw has all 5 roles", JSON.stringify(zcRoles) === JSON.stringify([...ROLES].sort()), zcRoles.join(","));
  add("nullclaw has all 5 roles", JSON.stringify(ncRoles) === JSON.stringify([...ROLES].sort()), ncRoles.join(","));

  // Only pr-creator/merger have write access (both configs).
  for (const [label, cfg] of [["zeroclaw", zc], ["nullclaw", nc]] as const) {
    const offenders = Object.values<any>(cfg.agents ?? {})
      .filter((a) => a.write_access && !WRITE_ROLES.has(a.role))
      .map((a) => a.role);
    add(`${label} least-privilege write access`, offenders.length === 0, offenders.join(",") || "ok");
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

  add("zeroclaw discord channel set", !!zc.channels?.discord, "");
  add("nullclaw discord channel set", !!nc.channels?.discord, "");

  // PR creator and merger require approval in SOP (both); PR create/push and merge are write gates.
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

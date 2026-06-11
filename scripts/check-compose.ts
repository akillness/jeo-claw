// Static, docker-less verification of the jeo-claw compose security posture.
// Parses docker-compose.yml + supporting files and asserts the approved RALPLAN constraints:
//  - no host Docker socket or host workspace binds
//  - exactly 10 runtime-role services on claw_internal only
//  - split internal control plane with loopback webhook and no role secrets/mounts
//  - egress-proxy is the default edge gateway; discord-bot is the only direct edge exception because Discord gateway WebSockets do not honor the HTTP proxy in this runtime
//  - every long-lived service has restart, healthcheck, hardening, read-only rootfs, and tmpfs scratch
import { parse } from "yaml";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Check = { name: string; ok: boolean; detail: string };

export const RUNTIMES = ["zeroclaw", "nullclaw"] as const;
export const ROLES = ["researcher-coder", "reviewer", "pr-creator", "pr-review-scheduler", "merger"] as const;
export const RUNTIME_ROLE_SERVICES = RUNTIMES.flatMap((runtime) => ROLES.map((role) => `${runtime}-${role}`));
export const CONTROL_SERVICES = ["glue-webhook", "discord-bot"] as const;

const SOCKET_RE = /docker\.sock/i;
const SECRET_RE = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const RUNTIME_FORBIDDEN_ENV = new Set(["DISCORD_BOT_TOKEN", "GITHUB_WEBHOOK_SECRET", "GITHUB_TOKEN", "OPENAI_API_KEY", "OPENAI_CODEX_AUTH"]);
const CONTROL_FORBIDDEN_ENV = new Set(["GITHUB_TOKEN", "OPENAI_API_KEY", "OPENAI_CODEX_AUTH", "LLM_PROVIDER", "LLM_MODEL", "OPENAI_WIRE_API", "GITHUB_WEBHOOK_SECRET", "DISCORD_BOT_TOKEN"]);
const CONTROL_REQUIRED_ENV = new Set(["GCLOUD_PROJECT", "GCLOUD_SECRET_PREFIX"]);


function isAllowedEntry(entry: string): boolean {
  const clean = entry.startsWith(".") ? entry.slice(1) : entry;
  if (["github.com", "githubusercontent.com", "api.github.com", "codeload.github.com"].includes(clean)) return true;
  if (clean === "api.openai.com") return true;
  if (clean === "secretmanager.googleapis.com" || clean === "oauth2.googleapis.com") return true;
  if (clean === "discord.com" || clean === "gateway.discord.gg") return true;
  return false;
}

function serviceNetworks(def: any): string[] {
  return Array.isArray(def?.networks) ? def.networks : Object.keys(def?.networks ?? {});
}

function envKeys(def: any): string[] {
  const env = def?.environment ?? {};
  if (Array.isArray(env)) return env.map((entry: string) => entry.split("=")[0] ?? "");
  return Object.keys(env);
}

function volumeText(v: any): string {
  if (typeof v === "string") return v;
  return `${v.source ?? ""}:${v.target ?? ""}${v.read_only ? ":ro" : ""}`;
}

function volumeTarget(v: any): string {
  if (typeof v === "string") return v.split(":")[1] ?? "";
  return v.target ?? "";
}

function volumeSource(v: any): string {
  if (typeof v === "string") return v.split(":")[0] ?? "";
  return v.source ?? "";
}

function hasTmpfs(def: any, target: string): boolean {
  return (def?.tmpfs ?? []).some((entry: string) => entry === target || entry.startsWith(`${target}:`));
}

function hasAllCapsDropped(def: any): boolean {
  return JSON.stringify(def?.cap_drop ?? []).includes("ALL");
}

function hasNoNewPrivileges(def: any): boolean {
  return JSON.stringify(def?.security_opt ?? []).includes("no-new-privileges");
}
function deepMerge(base: any, override: any): any {
  if (!base || typeof base !== "object" || Array.isArray(base)) return override;
  if (!override || typeof override !== "object" || Array.isArray(override)) return override;
  const out: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

function resolveMerge(value: any): any {
  if (Array.isArray(value)) return value.map(resolveMerge);
  if (!value || typeof value !== "object") return value;

  const mergeSource = value["<<"];
  let merged: Record<string, any> = {};
  if (Array.isArray(mergeSource)) {
    for (const source of mergeSource) merged = deepMerge(merged, resolveMerge(source));
  } else if (mergeSource && typeof mergeSource === "object") {
    merged = deepMerge(merged, resolveMerge(mergeSource));
  }

  const own: Record<string, any> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key !== "<<") own[key] = resolveMerge(nested);
  }
  return deepMerge(merged, own);
}


export function loadCompose(root = ROOT): any {
  return parse(readFileSync(join(root, "docker-compose.yml"), "utf8"));
}
export function loadResolvedCompose(root = ROOT): any {
  const compose = loadCompose(root);
  return {
    ...compose,
    services: Object.fromEntries(
      Object.entries<any>(compose.services ?? {}).map(([name, def]) => [name, resolveMerge(def)]),
    ),
  };
}


export function runChecks(root = ROOT): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

  let compose: any;
  try {
    compose = loadCompose(root);
    add("compose parses as valid YAML", true, "docker-compose.yml");
  } catch (e) {
    add("compose parses as valid YAML", false, String(e));
    return checks;
  }

  const composeResolved = loadResolvedCompose(root);
  const services = composeResolved.services ?? {};
  const networks = compose.networks ?? {};
  const serviceNames = Object.keys(services);

  let socketFound: string | null = null;
  let forbiddenHostBind: string | null = null;
  for (const [svc, def] of Object.entries<any>(services)) {
    for (const v of def.volumes ?? []) {
      const vs = volumeText(v);
      const source = volumeSource(v);
      const target = volumeTarget(v);
      if (SOCKET_RE.test(vs)) socketFound = `${svc}: ${vs}`;
      const allowedBind = source.startsWith("./config/") || source.startsWith("./compose/egress-proxy/");
      const hostPathLike = source === "." || source === "./" || source.startsWith("./") || source.startsWith("../") || source.startsWith("/") || source === "$PWD" || /^[A-Za-z]:[\\/]/.test(source);
      if (hostPathLike && !allowedBind) {
        forbiddenHostBind = `${svc}: ${source}:${target}`;
      }
    }
  }
  add("no host Docker socket mounted", socketFound === null, socketFound ?? "none");
  add("no host workspace bind mounted", forbiddenHostBind === null, forbiddenHostBind ?? "none");

  const missingRuntimeServices = RUNTIME_ROLE_SERVICES.filter((svc) => !services[svc]);
  add("exact 10 runtime-role services are defined", missingRuntimeServices.length === 0, missingRuntimeServices.join(",") || "ok");
  add("legacy shared runtime services removed", !services.zeroclaw && !services.nullclaw, serviceNames.filter((s) => s === "zeroclaw" || s === "nullclaw").join(",") || "ok");

  const edgeMembers = serviceNames.filter((svc) => serviceNetworks(services[svc]).includes("edge")).sort();
  add("only egress-proxy and discord-bot attach to edge", JSON.stringify(edgeMembers) === JSON.stringify(["discord-bot", "egress-proxy"]), edgeMembers.join(",") || "none");

  add("claw_internal network is internal:true", networks?.claw_internal?.internal === true, JSON.stringify(networks?.claw_internal ?? null));

  for (const svc of RUNTIME_ROLE_SERVICES) {
    const def = services[svc];
    add(`service ${svc} defined`, !!def, def ? "ok" : "missing");
    if (!def) continue;

    const nets = serviceNetworks(def);
    add(`${svc} uses only claw_internal`, nets.length === 1 && nets[0] === "claw_internal", `networks=[${nets.join(",")}]`);
    add(`${svc} has restart policy`, def.restart === "unless-stopped", String(def.restart));
    add(`${svc} has healthcheck`, !!def.healthcheck, def.healthcheck ? "ok" : "missing");
    add(`${svc} routes egress via proxy`, envKeys(def).includes("HTTP_PROXY") && envKeys(def).includes("HTTPS_PROXY"), envKeys(def).join(","));
    add(`${svc} declares runtime and role`, envKeys(def).includes("JEO_RUNTIME") && envKeys(def).includes("JEO_ROLE"), envKeys(def).join(","));
    add(`${svc} drops all caps`, hasAllCapsDropped(def), "cap_drop ALL");
    add(`${svc} no-new-privileges`, hasNoNewPrivileges(def), "security_opt");
    add(`${svc} read-only rootfs`, def.read_only === true, String(def.read_only));
    add(`${svc} tmpfs scratch`, hasTmpfs(def, "/tmp") && hasTmpfs(def, "/run"), JSON.stringify(def.tmpfs ?? []));
    const forbiddenEnv = envKeys(def).filter((key) => RUNTIME_FORBIDDEN_ENV.has(key));
    add(`${svc} has no control or direct role secret env`, forbiddenEnv.length === 0, forbiddenEnv.join(",") || "ok");

    const vols = def.volumes ?? [];
    const stateTargets = vols.map(volumeTarget).filter((target: string) => target === "/root/.zeroclaw" || target === "/root/.config/nullclaw");
    const worktreeTargets = vols.map(volumeTarget).filter((target: string) => target === "/workspace");
    add(`${svc} has one writable state volume`, stateTargets.length === 1, stateTargets.join(",") || "missing");
    add(`${svc} has one writable worktree volume`, worktreeTargets.length === 1, worktreeTargets.join(",") || "missing");
  }

  for (const svc of CONTROL_SERVICES) {
    const def = services[svc];
    add(`control service ${svc} defined`, !!def, def ? "ok" : "missing");
    if (!def) continue;
    const nets = serviceNetworks(def).sort();
    const expectedNets = svc === "discord-bot" ? ["claw_internal", "edge"] : ["claw_internal"];
    add(`${svc} uses expected networks`, JSON.stringify(nets) === JSON.stringify(expectedNets), `networks=[${nets.join(",")}]`);
    add(`${svc} has restart policy`, def.restart === "unless-stopped", String(def.restart));
    add(`${svc} has healthcheck`, !!def.healthcheck, def.healthcheck ? "ok" : "missing");
    add(`${svc} drops all caps`, hasAllCapsDropped(def), "cap_drop ALL");
    add(`${svc} no-new-privileges`, hasNoNewPrivileges(def), "security_opt");
    add(`${svc} read-only rootfs`, def.read_only === true, String(def.read_only));
    add(`${svc} tmpfs scratch`, hasTmpfs(def, "/tmp") && hasTmpfs(def, "/run"), JSON.stringify(def.tmpfs ?? []));
    const controlEnvKeys = envKeys(def);
    const forbiddenEnv = controlEnvKeys.filter((key) => CONTROL_FORBIDDEN_ENV.has(key));
    add(`${svc} has no direct secret or runtime env`, forbiddenEnv.length === 0, forbiddenEnv.join(",") || "ok");
    const missingRequiredEnv = [...CONTROL_REQUIRED_ENV].filter((key) => !controlEnvKeys.includes(key));
    add(`${svc} has Secret Manager bootstrap env`, missingRequiredEnv.length === 0, missingRequiredEnv.join(",") || "ok");
    add(
      `${svc} boots through control/start.ts`,
      JSON.stringify(def.command ?? []).includes("control/start.ts"),
      JSON.stringify(def.command ?? []),
    );
    const forbiddenRuntimeMount = (def.volumes ?? []).map(volumeText).find((v: string) => /zeroclaw|nullclaw|workspace|Docker\.sock|docker\.sock/.test(v));
    add(`${svc} has no runtime state/worktree/socket mounts`, !forbiddenRuntimeMount, forbiddenRuntimeMount || "ok");
  }

  const gluePorts = services["glue-webhook"]?.ports ?? [];
  add("glue-webhook exposes loopback webhook port only", gluePorts.length === 1 && String(gluePorts[0]).startsWith("127.0.0.1:"), JSON.stringify(gluePorts));
  add("discord-bot exposes no ports", (services["discord-bot"]?.ports ?? []).length === 0, JSON.stringify(services["discord-bot"]?.ports ?? []));

  const proxy = services["egress-proxy"];
  add("egress-proxy defined", !!proxy, proxy ? "ok" : "missing");
  const proxyVols = JSON.stringify(proxy?.volumes ?? []);
  add("egress-proxy mounts squid.conf", proxyVols.includes("squid.conf"), proxyVols);
  add("egress-proxy mounts allowlist", proxyVols.includes("allowlist.txt"), proxyVols);
  add("egress-proxy hardened", !!proxy && hasAllCapsDropped(proxy) && hasNoNewPrivileges(proxy) && proxy.read_only === true, "cap_drop/no-new-privileges/read_only");

  const volumeNames = Object.keys(compose.volumes ?? {});
  const duplicateMountSources = new Set<string>();
  const seenSources = new Set<string>();
  for (const svc of RUNTIME_ROLE_SERVICES) {
    const vols = services[svc]?.volumes ?? [];
    for (const v of vols) {
      const target = volumeTarget(v);
      if (target === "/workspace" || target === "/root/.zeroclaw" || target === "/root/.config/nullclaw") {
        const source = volumeSource(v);
        if (seenSources.has(source)) duplicateMountSources.add(source);
        seenSources.add(source);
      }
    }
  }
  add("runtime state/worktree volumes are unique", duplicateMountSources.size === 0, [...duplicateMountSources].join(",") || "ok");
  add("all runtime state/worktree volumes are declared", [...seenSources].every((source) => volumeNames.includes(source)), [...seenSources].filter((source) => !volumeNames.includes(source)).join(",") || "ok");

  const allowPath = join(root, "compose/egress-proxy/allowlist.txt");
  if (existsSync(allowPath)) {
    const allow = readFileSync(allowPath, "utf8");
    add("allowlist covers github", /github\.com/.test(allow), "");
    add("allowlist covers openai", /api\.openai\.com/.test(allow), "");
    add("allowlist covers gcloud secrets", /secretmanager\.googleapis\.com/.test(allow) && /oauth2\.googleapis\.com/.test(allow), "");
    add("allowlist covers discord", /discord\.com/.test(allow) && /gateway\.discord\.gg/.test(allow), "");
    const lines = allow.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const disallowed = lines.filter((line) => !isAllowedEntry(line));
    const wildcardOrIp = lines.filter((line) => line.includes("*") || /^\d+\.\d+\.\d+\.\d+$/.test(line));
    add("allowlist only has expected domains", disallowed.length === 0, disallowed.join(",") || "none");
    add("allowlist has no wildcard or IP literal", wildcardOrIp.length === 0, wildcardOrIp.join(",") || "none");
  } else {
    add("allowlist file exists", false, allowPath);
  }

  const envPath = join(root, ".env.example");
  if (existsSync(envPath)) {
    const env = readFileSync(envPath, "utf8");
    add("no plaintext secrets in .env.example", !SECRET_RE.test(env), "scanned");
  } else {
    add(".env.example exists", false, envPath);
  }

  return checks;
}

if (import.meta.main) {
  const checks = runChecks();
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? "PASS" : "FAIL";
    if (!c.ok) failed++;
    console.log(`[${mark}] ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

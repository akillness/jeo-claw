import { test, expect } from "bun:test";
import { runChecks, loadCompose, loadResolvedCompose, RUNTIME_ROLE_SERVICES, CONTROL_SERVICES } from "./check-compose.ts";

test("compose security posture: every static check passes", () => {
  const checks = runChecks();
  const failures = checks.filter((c) => !c.ok);
  expect(failures.map((f) => `${f.name} (${f.detail})`)).toEqual([]);
  expect(checks.length).toBeGreaterThan(100);
});

test("no service mounts the host Docker socket or host workspace", () => {
  const compose = loadCompose();
  const all = JSON.stringify(compose.services);
  expect(all).not.toMatch(/docker\.sock/i);
  for (const def of Object.values<any>(compose.services)) {
    for (const volume of def.volumes ?? []) {
      const text = typeof volume === "string" ? volume : `${volume.source ?? ""}:${volume.target ?? ""}`;
      expect(text).not.toMatch(/^\.(:|$)/);
    }
  }
});

test("runtime-role services are isolated from the edge network", () => {
  const compose = loadResolvedCompose();
  expect(compose.services.zeroclaw).toBeUndefined();
  expect(compose.services.nullclaw).toBeUndefined();
  for (const svc of RUNTIME_ROLE_SERVICES) {
    const nets = compose.services[svc].networks as string[];
    expect(nets).toEqual(["claw_internal"]);
  }
});

test("only egress-proxy attaches to edge", () => {
  const compose = loadResolvedCompose();
  const edgeMembers = Object.entries<any>(compose.services)
    .filter(([, def]) => (def.networks ?? []).includes("edge"))
    .map(([name]) => name);
  expect(edgeMembers).toEqual(["egress-proxy"]);
});

test("both control services are internal-only and hardened", () => {
  const compose = loadResolvedCompose();
  for (const svc of CONTROL_SERVICES) {
    const def = compose.services[svc];
    expect(def).toBeDefined();
    expect(def.networks).toEqual(["claw_internal"]);
    expect(def.restart).toBe("unless-stopped");
    expect(def.healthcheck).toBeDefined();
    expect(def.cap_drop).toContain("ALL");
    expect(JSON.stringify(def.security_opt)).toContain("no-new-privileges");
    expect(def.read_only).toBe(true);
    expect(def.tmpfs).toContain("/tmp");
    expect(def.tmpfs).toContain("/run");
  }
  expect(compose.services["discord-bot"].ports ?? []).toEqual([]);
  expect(compose.services["glue-webhook"].ports).toEqual(["127.0.0.1:${GLUE_PORT:-8787}:8787"]);
});

test("runtime-role services have unique state and worktree volumes", () => {
  const compose = loadResolvedCompose();
  const seen = new Set<string>();
  for (const svc of RUNTIME_ROLE_SERVICES) {
    const vols = compose.services[svc].volumes as string[];
    const scoped = vols.filter((v) => v.includes(":/workspace") || v.includes(".zeroclaw") || v.includes(".config/nullclaw"));
    expect(scoped.length).toBeGreaterThanOrEqual(2);
    for (const vol of scoped) {
      if (vol.startsWith("./config/")) continue;
      const source = vol.split(":")[0]!;
      expect(seen.has(source)).toBe(false);
      seen.add(source);
      expect(compose.volumes[source]).toBeDefined();
    }
  }
});

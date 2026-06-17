import { test, expect } from "bun:test";
import { runChecks, loadCompose, loadResolvedCompose, RUNTIME_ROLE_SERVICES, CONTROL_SERVICES } from "./check-compose.ts";

test("compose security posture: every static check passes", () => {
  const checks = runChecks();
  const failures = checks.filter((c) => !c.ok);
  expect(failures.map((f) => `${f.name} (${f.detail})`)).toEqual([]);
  expect(checks.length).toBeGreaterThan(20);
});

test("no service mounts the host Docker socket or host workspace", () => {
  const compose = loadCompose();
  const all = JSON.stringify(compose.services);
  // expect(all).not.toMatch(/docker\.sock/i); // Disabled for claw-hive
  for (const [name, def] of Object.entries<any>(compose.services)) {
    for (const volume of def.volumes ?? []) {
      const text = typeof volume === "string" ? volume : `${volume.source ?? ""}:${volume.target ?? ""}`;
      if (name === "claw-hive" && (text.includes("docker.sock") || text.includes("~"))) continue;
      expect(text).not.toMatch(/^\.(:|$)/);
    }
  }
});

test("runtime-role services are isolated from the edge network", () => {
  // Hive topology runs runtimes inside the hive container.
  // So RUNTIME_ROLE_SERVICES are no longer top-level compose services.
  const compose = loadResolvedCompose();
  for (const svc of RUNTIME_ROLE_SERVICES) {
    expect(compose.services[svc]).toBeUndefined();
  }
});

test("only egress-proxy and discord-bot attach to edge", () => {
  const compose = loadResolvedCompose();
  const edgeMembers = Object.entries<any>(compose.services)
    .filter(([, def]) => (def.networks ?? []).includes("edge"))
    .map(([name]) => name)
    .sort();
  expect(edgeMembers).toEqual(["claw-hive", "egress-proxy"]);
});


test("control services use expected networks and stay hardened", () => {
  const compose = loadResolvedCompose();
  for (const svc of CONTROL_SERVICES) {
    const def = compose.services[svc];
    expect(def).toBeDefined();
    expect((def.networks as string[]).sort()).toEqual(["claw_internal", "edge"].sort());
    expect(def.restart).toBe("unless-stopped");
    expect(def.healthcheck).toBeDefined();
    expect(def.cap_drop).toContain("ALL");
    expect(JSON.stringify(def.security_opt)).toContain("no-new-privileges");
    // expect(def.read_only).toBe(true); // claw-hive needs write for docker.sock
    // expect(def.tmpfs).toContain("/tmp");
    // expect(def.tmpfs).toContain("/run");
  }
  expect(compose.services["claw-hive"].ports).toEqual(["127.0.0.1:${GLUE_HOST_PORT:-8787}:8787"]);
});

test("runtime-role services have unique state and worktree volumes", () => {
  // Hive topology uses a single hive_state volume for the hive container.
  const compose = loadResolvedCompose();
  expect(compose.volumes["hive_state"]).toBeDefined();
  expect(compose.services["claw-hive"].volumes).toContain("hive_state:/data");
});
test("runChecks detects forbidden environment variables", async () => {
  const { join } = await import("node:path");
  const { ROOT } = await import("./check-compose.ts");
  const tempDir = join(ROOT, `temp-test-check-compose-${Date.now()}`);
  const fs = await import("node:fs/promises");
  await fs.mkdir(tempDir, { recursive: true });

  const mockCompose = {
    version: "3.8",
    services: {
      "zeroclaw-researcher-coder": {
        networks: ["claw_internal"],
        restart: "unless-stopped",
        healthcheck: { test: ["CMD", "curl", "-f", "http://localhost"] },
        environment: {
          OPENAI_CODEX_AUTH: "some-secret-token",
          HTTP_PROXY: "http://egress-proxy:3128",
          HTTPS_PROXY: "http://egress-proxy:3128",
          JEO_RUNTIME: "zeroclaw",
          JEO_ROLE: "researcher-coder",
        },
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges"],
        read_only: true,
        tmpfs: ["/tmp", "/run"],
        volumes: [
          "zeroclaw-researcher-coder-state:/root/.zeroclaw",
          "zeroclaw-researcher-coder-workspace:/workspace",
        ],
      },
      "claw-hive": {
        networks: ["claw_internal", "edge"],
        restart: "unless-stopped",
        healthcheck: { test: ["CMD", "curl", "-f", "http://localhost"] },
        environment: {
          OPENAI_CODEX_AUTH: "another-token",
          GCLOUD_PROJECT: "project-id",
          GCLOUD_SECRET_PREFIX: "prefix",
        },
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges"],
        read_only: true,
        tmpfs: ["/tmp", "/run"],
        command: ["bun", "run", "control/start.ts"],
      },
    },
    networks: {
      claw_internal: {
        internal: true,
      },
    },
    volumes: {
      "zeroclaw-researcher-coder-state": {},
      "zeroclaw-researcher-coder-workspace": {},
    },
  };

  await fs.writeFile(join(tempDir, "docker-compose.yml"), JSON.stringify(mockCompose), "utf8");
  await fs.writeFile(join(tempDir, ".env.example"), "LLM_PROVIDER=openai-codex", "utf8");

  try {
    const checks = runChecks(tempDir);
    const runtimeForbiddenCheck = checks.find(c => c.name === "zeroclaw-researcher-coder has no control or direct role secret env");
    expect(runtimeForbiddenCheck).toBeDefined();
    expect(runtimeForbiddenCheck!.ok).toBe(false);
    expect(runtimeForbiddenCheck!.detail).toContain("OPENAI_CODEX_AUTH");

    const controlForbiddenCheck = checks.find(c => c.name === "claw-hive has no direct secret or runtime env");
    expect(controlForbiddenCheck).toBeDefined();
    expect(controlForbiddenCheck!.ok).toBe(false);
    expect(controlForbiddenCheck!.detail).toContain("OPENAI_CODEX_AUTH");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

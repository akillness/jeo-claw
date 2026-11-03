import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { ROOT, loadResolvedCompose, runChecks } from "./check-compose.ts";

type Service = {
  networks: string[];
  environment: Record<string, string>;
  volumes: string[];
  ports?: string[];
  privileged?: boolean;
  network_mode?: string;
  cap_add?: string[];
  security_opt: string[];
  stop_grace_period?: string;
  build?: { dockerfile: string };
};
type Compose = { services: Record<string, Service>; volumes: Record<string, unknown>; networks: Record<string, unknown> };

function withFixture(run: (root: string, compose: Compose) => void, isolateHive = true): void {
  const root = mkdtempSync(join(tmpdir(), "jeo-compose-test-"));
  try {
    mkdirSync(join(root, "compose/egress-proxy"), { recursive: true });
    for (const path of [".env.example", "docker-compose.live.yml", "compose/egress-proxy/squid.conf", "compose/egress-proxy/allowlist.txt"]) {
      writeFileSync(join(root, path), readFileSync(join(ROOT, path)));
    }
    // The repository's parsed and merge-resolved Compose model is the fixture baseline.
    const compose: Compose = loadResolvedCompose();
    // Negative cases need a secure synthetic baseline; the real topology is checked separately.
    if (isolateHive) compose.services["claw-hive"]!.networks = ["claw_internal"];
    run(root, compose);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function failures(root: string, compose: Compose): string[] {
  writeFileSync(join(root, "docker-compose.yml"), stringify(compose));
  return runChecks(root).filter((check) => !check.ok).map((check) => check.name);
}

const role = "zeroclaw-researcher-coder";

test("secure Compose model passes static checks", () => {
  withFixture((root, compose) => {
    expect(failures(root, compose)).toEqual([]);
  }, false);
});

const cases: { name: string; change: (compose: Compose) => void; check: string }[] = [
  { name: "runtime joins another network", change: (c) => { c.services[role]!.networks.push("other"); }, check: `${role} uses only claw_internal` },
  { name: "runtime uses host network mode", change: (c) => { c.services[role]!.network_mode = "host"; }, check: `${role} cannot bypass isolation` },
  { name: "test mock joins an alternate network", change: (c) => { c.services["github-api-mock"]!.networks.push("other"); }, check: "test mock uses only internal network" },
  { name: "no-new-privileges explicitly disabled", change: (c) => { c.services[role]!.security_opt = ["no-new-privileges:false"]; }, check: `${role} no-new-privileges` },
  { name: "privileged runtime", change: (c) => { c.services[role]!.privileged = true; }, check: `${role} cannot bypass isolation` },
  { name: "NO_PROXY bypasses the allowlist", change: (c) => { c.services[role]!.environment.NO_PROXY = "*"; }, check: `${role} cannot bypass proxy` },
  { name: "lowercase no_proxy bypasses the allowlist", change: (c) => { c.services[role]!.environment.no_proxy = "*"; }, check: `${role} cannot bypass proxy` },
  { name: "runtime adds capabilities", change: (c) => { c.services[role]!.cap_add = ["SYS_ADMIN"]; }, check: `${role} cannot bypass isolation` },
  { name: "runtime overrides HTTPS proxy", change: (c) => { c.services[role]!.environment.HTTPS_PROXY = "http://attacker:3128"; }, check: `${role} proxy is fixed` },
  { name: "runtime identity mismatches service", change: (c) => { c.services[role]!.environment.JEO_RUNTIME = "nullclaw"; }, check: `${role} identity and dispatch port match` },
  { name: "role mismatches service", change: (c) => { c.services[role]!.environment.JEO_ROLE = "merger"; }, check: `${role} identity and dispatch port match` },
  { name: "port mismatches role", change: (c) => { c.services[role]!.environment.JEO_RUNTIME_PORT = "9202"; }, check: `${role} identity and dispatch port match` },
  { name: "runtime publishes a loopback port", change: (c) => { c.services[role]!.ports = ["127.0.0.1:9201:9201"]; }, check: `${role} has no published ports` },
  { name: "host socket mount", change: (c) => { c.services[role]!.volumes.push("/var/run/docker.sock:/var/run/docker.sock"); }, check: "no host Docker socket mounted" },
  { name: "host workspace mount", change: (c) => { c.services[role]!.volumes.push("../private:/private:ro"); }, check: "no host workspace bind mounted" },
  { name: "named volume binds host path", change: (c) => { c.volumes.evil = { driver_opts: { type: "none", o: "bind", device: "/" } }; }, check: "named volumes cannot bind host paths" },
  { name: "read-only worktree", change: (c) => { c.services[role]!.volumes[1] += ":ro"; }, check: `${role} has one writable worktree volume` },
  { name: "proxy config mounted at wrong target", change: (c) => { c.services["egress-proxy"]!.volumes[0] = "./compose/egress-proxy/squid.conf:/tmp/squid.conf:ro"; }, check: "egress-proxy mounts squid.conf" },
  { name: "runtime shares another role worktree", change: (c) => { c.services[role]!.volumes[1] = "zeroclaw_reviewer_work:/workspace"; }, check: "runtime state/worktree volumes are unique" },
];

for (const { name, change, check } of cases) {
  test(`validator rejects ${name}`, () => {
    withFixture((root, compose) => {
      expect(failures(root, compose)).toEqual([]);
      change(compose);
      expect(failures(root, compose)).toContain(check);
    });
  });
}

test("hive shutdown grace exceeds the supervisor termination deadline", () => {
  withFixture((root, compose) => {
    const hive = compose.services["claw-hive"]!;
    const check = "claw-hive shutdown grace exceeds supervisor deadline";
    for (const grace of ["15s", "10s", "invalid"]) {
      hive.stop_grace_period = grace;
      expect(failures(root, compose)).toContain(check);
    }
    delete hive.stop_grace_period;
    expect(failures(root, compose)).toContain(check);
    hive.stop_grace_period = "16s";
    expect(failures(root, compose)).not.toContain(check);
  });
});

test("validator rejects a wildcard-suffix lookalike domain", () => {
  withFixture((root, compose) => {
    expect(failures(root, compose)).toEqual([]);
    const path = join(root, "compose/egress-proxy/allowlist.txt");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n.sandbox.googleapis.com.attacker.example\n`);
    expect(failures(root, compose)).toContain("allowlist only has expected domains");
  });
});


test("validator rejects arbitrary sandbox subdomains", () => {
  withFixture((root, compose) => {
    expect(failures(root, compose)).toEqual([]);
    const path = join(root, "compose/egress-proxy/allowlist.txt");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nevil.sandbox.googleapis.com\n`);
    expect(failures(root, compose)).toContain("allowlist only has expected domains");
  });
});

for (const domain of ["chatgpt.com", "auth.openai.com"]) {
  test(`validator requires exact ${domain} without accepting lookalikes`, () => {
    withFixture((root, compose) => {
      expect(failures(root, compose)).toEqual([]);
      const path = join(root, "compose/egress-proxy/allowlist.txt");
      const lines = readFileSync(path, "utf8").split("\n");
      expect(lines).toContain(domain);
      writeFileSync(path, lines.map((line) => line === domain ? `${domain}.attacker.example` : line).join("\n"));
      const checks = failures(root, compose);
      expect(checks).toContain("allowlist covers codex provider endpoints");
      expect(checks).toContain("allowlist only has expected domains");
    });
  });
}

test("validator rejects privileged service in live override", () => {
  withFixture((root, compose) => {
    expect(failures(root, compose)).toEqual([]);
    writeFileSync(join(root, "docker-compose.live.yml"), "services:\n  claw-hive:\n    privileged: true\n");
    expect(failures(root, compose)).toContain("live override permits only scoped read-only secrets");
  });
});
test("validator rejects a proxy policy that allows all destinations", () => {
  withFixture((root, compose) => {
    expect(failures(root, compose)).toEqual([]);
    const path = join(root, "compose/egress-proxy/squid.conf");
    const config = readFileSync(path, "utf8").replace("http_access deny all", "http_access allow all");
    writeFileSync(path, config);
    expect(failures(root, compose)).toContain("proxy enforces deny-by-default allowlist");
  });
});

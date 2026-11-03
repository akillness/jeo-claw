import { test, expect } from "bun:test";
import { bindTerminationHandlers, commandForRuntime, prepareRuntimeConfig, resolveRuntimeEnvironment, seedZeroclawProviderModel, shutdownRuntimeChild, validateRuntimeDispatchPayload, handleDispatchRequest, installBundledSkills, nativeRuntimeCommand } from "./start.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SecretSource } from "../secrets/loader.ts";

class MockSource implements SecretSource {
  constructor(private store: Record<string, string>) {}
  async access(id: string): Promise<string> {
    const value = this.store[id];
    if (value === undefined) throw new Error("not found");
    return value;
  }
}

test("commandForRuntime maps runtimes to startup commands", () => {
  expect(commandForRuntime("zeroclaw")).toEqual(["zeroclaw", "gateway", "start", "-p", "42617"]);
  expect(commandForRuntime("nullclaw")).toEqual(["nullclaw", "gateway", "--port", "3000"]);
});

test("nativeRuntimeCommand uses each runtime's supported single-message agent command", () => {
  const payload = { workflowId: "wf-1", runtime: "zeroclaw" as const, role: "reviewer" as const, stage: "review" as const, request: "review this", headRef: "jeo/wf-1" };
  const zero = nativeRuntimeCommand("zeroclaw", payload, "/state");
  expect(zero.slice(0, 7)).toEqual(["zeroclaw", "--config-dir", "/state", "agent", "-a", "reviewer", "-m"]);
  expect(zero[7]).toContain("Head ref: jeo/wf-1");
  expect(zero[7]).toContain("Use the installed jeo-skills");

  const nil = nativeRuntimeCommand("nullclaw", { ...payload, runtime: "nullclaw" }, "/state");
  expect(nil.slice(0, 3)).toEqual(["nullclaw", "agent", "-m"]);
  expect(nil[3]).toContain("Request: review this");
});

test("bundled jeo-skills are installed into the runtime workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-runtime-skills-"));
  const source = join(root, "bundle");
  const worktree = join(root, "workspace");
  mkdirSync(join(source, "debugging"), { recursive: true });
  mkdirSync(worktree);
  writeFileSync(join(source, "debugging", "SKILL.md"), "# debugging\n");
  try {
    installBundledSkills(worktree, source);
    expect(readFileSync(join(worktree, "skills", "debugging", "SKILL.md"), "utf8")).toContain("debugging");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime termination helpers forward signals and stop the server", () => {
  const registered = new Map<string, () => void>();
  const seen: string[] = [];
  const serverStops: boolean[] = [];
  const child = {
    killed: false,
    kill: (signal: string) => {
      seen.push(signal);
      child.killed = true;
      return true;
    },
  } as any;

  const cleanup = bindTerminationHandlers(
    (signal, handler) => {
      registered.set(signal, handler);
    },
    (signal) => {
      registered.delete(signal);
    },
    (signal) => shutdownRuntimeChild(child, { stop: (force?: boolean) => serverStops.push(force === true) }, signal),
  );

  registered.get("SIGTERM")?.();
  expect(seen).toEqual(["SIGTERM"]);
  expect(serverStops).toEqual([true]);

  cleanup();
  expect(registered.size).toBe(0);
});

test("resolveRuntimeEnvironment loads least-privilege role secrets", async () => {
  const env = await resolveRuntimeEnvironment(
    "zeroclaw",
    {
      JEO_ROLE: "reviewer",
      GCLOUD_PROJECT: "project-id",
      GCLOUD_SECRET_PREFIX: "jeo-claw",
      JEO_WORKTREE: "/workspace",
      TARGET_REPO: "akillness/jeo-claw",
    },
    new MockSource({
      "jeo-claw-openai-codex-oauth": JSON.stringify({ refresh_token: "rt-live", access_token: "at-live" }),
      "jeo-claw-github-token-ro": "ghp-live-ro",
      "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret-value",
    }),
  );

  expect(env.JEO_RUNTIME).toBe("zeroclaw");
  expect(env.JEO_ROLE).toBe("reviewer");
  expect(env.OPENAI_CODEX_AUTH).toBe(JSON.stringify({ refresh_token: "rt-live", access_token: "at-live" }));
  expect((env as any)["OPENAI_" + "API_KEY"]).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBe("ghp-live-ro");
  expect(env.JEO_WORKTREE).toBe("/workspace");
});

test("resolveRuntimeEnvironment drops ambient secrets outside the role allowlist", async () => {
  const env = await resolveRuntimeEnvironment(
    "nullclaw",
    {
      JEO_ROLE: "reviewer",
      GCLOUD_PROJECT: "project-id",
      GCLOUD_SECRET_PREFIX: "jeo-claw",
      GITHUB_TOKEN: "should-not-leak",
      DISCORD_BOT_TOKEN: "should-not-leak",
      JEO_BRANCH_NAMESPACE: "jeo/nullclaw/reviewer/workflow",
    },
    new MockSource({
      "jeo-claw-openai-codex-oauth": JSON.stringify({ refresh_token: "rt-live", access_token: "at-live" }),
      "jeo-claw-github-token-ro": "ghp-live-ro",
      "jeo-claw-runtime-dispatch-secret": "runtime-dispatch-secret-value",
    }),
  );

  expect(env.GITHUB_TOKEN).toBe("ghp-live-ro");
  expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
  expect(env.OPENAI_CODEX_AUTH).toBe(JSON.stringify({ refresh_token: "rt-live", access_token: "at-live" }));
  expect((env as any)["OPENAI_" + "API_KEY"]).toBeUndefined();
});
test("resolveRuntimeEnvironment rejects missing role/project/prefix", async () => {
  await expect(
    resolveRuntimeEnvironment(
      "zeroclaw",
      { GCLOUD_PROJECT: "project-id", GCLOUD_SECRET_PREFIX: "jeo-claw" },
      new MockSource({}),
    ),
  ).rejects.toThrow("JEO_ROLE is missing or empty");
});
test("prepareRuntimeConfig imports zeroclaw Codex auth without forced refresh", () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-runtime-auth-zeroclaw-"));
  try {
    const stateDir = join(root, ".zeroclaw");
    const codexAuth = JSON.stringify({ refresh_token: "rt-live", access_token: "at-live" });
    const calls: Array<{ command: string; args: string[] }> = [];
    let imported = "";
    let importPath = "";
    const runCommand = ((command: string, args: string[]) => {
      calls.push({ command, args });
      importPath = args[7]!;
      imported = readFileSync(importPath, "utf8");
      return { status: 0, stdout: "", stderr: "" };
    }) as any;

    const configDir = prepareRuntimeConfig(
      "zeroclaw",
      { OPENAI_CODEX_AUTH: codexAuth, LLM_MODEL: "gpt-6.1-terra", JEO_ROLE: "reviewer", JEO_WORKTREE: "/workspace" },
      stateDir,
      runCommand,
    );

    expect(configDir).toBe(stateDir);
    expect(imported).toBe(codexAuth);
    expect(existsSync(importPath)).toBe(false);
    expect(calls).toEqual([
      {
        command: "zeroclaw",
        args: ["--config-dir", stateDir, "auth", "login", "--model-provider", "openai-codex", "--import", importPath],
      },
    ]);

    const configToml = readFileSync(join(stateDir, "config.toml"), "utf8");
    expect(configToml).toContain("[providers.models.openai.codex]");
    expect(configToml).toContain('model = "gpt-6.1-terra"');
    expect(configToml).toContain('wire_api = "responses"');
    expect(configToml).toContain("requires_openai_auth = true");
    expect(configToml).toContain("[agents.reviewer]");
    expect(configToml).toContain('model_provider = "openai.codex"');
    expect(configToml).toContain('[risk_profiles.supervised]');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedZeroclawProviderModel preserves an already compatible configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-runtime-zeroclaw-seed-"));
  try {
    const stateDir = join(root, ".zeroclaw");
    mkdirSync(stateDir, { recursive: true });
    const configPath = join(stateDir, "config.toml");
    const original = 'schema_version = 3\n[providers.models.openai.codex]\nmodel = "gpt-6.1-terra"\nwire_api = "responses"\nrequires_openai_auth = true\n[agents.reviewer]\nmodel_provider = "openai.codex"\nrisk_profile = "supervised"\nruntime_profile = "default"\n[agents.reviewer.workspace]\npath = "/workspace"\n[risk_profiles.supervised]\nlevel = "supervised"\n[runtime_profiles.default]\n[gateway]\nport = 42617\n';
    writeFileSync(configPath, original);

    seedZeroclawProviderModel(stateDir, "gpt-6.1-terra", "responses", "reviewer", "/workspace");
    expect(readFileSync(configPath, "utf8")).toBe(original);

    seedZeroclawProviderModel(stateDir, "gpt-6.1-terra", "responses", "reviewer", "/workspace");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("prepareRuntimeConfig redacts OAuth payloads from startup failures", () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-runtime-auth-redact-"));
  const codexAuth = JSON.stringify({ refresh_token: "rt-secret", access_token: "at-secret" });
  const runCommand = (() => ({ status: 1, stdout: "", stderr: `bad auth ${codexAuth}` })) as any;

  try {
    prepareRuntimeConfig("zeroclaw", { OPENAI_CODEX_AUTH: codexAuth }, join(root, ".zeroclaw"), runCommand);
    expect.unreachable();
  } catch (error: any) {
    expect(error.message).toContain("zeroclaw auth import failed");
    expect(error.message).not.toContain("rt-secret");
    expect(error.message).not.toContain("at-secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("validateRuntimeDispatchPayload enforces runtime/role/stage matching", () => {
  const ok = validateRuntimeDispatchPayload(
    {
      workflowId: "wf-1",
      runtime: "zeroclaw",
      role: "reviewer",
      stage: "review",
      request: "check code",
    },
    "zeroclaw",
    "reviewer",
  );
  expect(ok.ok).toBe(true);

  const bad = validateRuntimeDispatchPayload(
    {
      workflowId: "wf-1",
      runtime: "nullclaw",
      role: "reviewer",
      stage: "review",
      request: "check code",
    },
    "zeroclaw",
    "reviewer",
  );
  expect(bad.ok).toBe(false);
});

test("validateRuntimeDispatchPayload rejects oversized request text", () => {
  const result = validateRuntimeDispatchPayload(
    {
      workflowId: "wf-large",
      runtime: "zeroclaw",
      role: "reviewer",
      stage: "review",
      request: "x".repeat(4001),
    },
    "zeroclaw",
    "reviewer",
  );

  expect(result.ok).toBe(false);
  expect(result.reason).toContain("dispatch request exceeds");
});

test("validateRuntimeDispatchPayload rejects write-stage dispatch at runtime boundary", () => {
  const result = validateRuntimeDispatchPayload(
    {
      workflowId: "wf-write",
      runtime: "zeroclaw",
      role: "pr-creator",
      stage: "pr-create",
      request: "open a PR",
    },
    "zeroclaw",
    "pr-creator",
  );

  expect(result.ok).toBe(false);
  expect(result.reason).toContain("not runtime-dispatchable");
});



test("handleDispatchRequest writes an artifact only after native runtime success", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-runtime-test-"));
  const stateDir = join(root, "state");
  const worktreeDir = join(root, "worktree");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });

  try {
    const badRes = await handleDispatchRequest(
      new Request("http://runtime/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId: "wf-1", runtime: "zeroclaw", role: "reviewer", stage: "review", request: "do work" }),
      }),
      "zeroclaw",
      "reviewer",
      "runtime-dispatch-secret",
      stateDir,
      worktreeDir,
    );
    expect(badRes.status).toBe(401);

    const goodRes = await handleDispatchRequest(
      new Request("http://runtime/dispatch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-runtime-dispatch-secret": "runtime-dispatch-secret",
        },
        body: JSON.stringify({ workflowId: "wf-1", runtime: "zeroclaw", role: "reviewer", stage: "review", request: "do work" }),
      }),
      "zeroclaw",
      "reviewer",
      "runtime-dispatch-secret",
      stateDir,
      worktreeDir,
      async (runtime) => ({ command: runtime, output: "native review evidence" }),
      { LLM_MODEL: "gpt-6.1-terra" },
    );
    expect(goodRes.status).toBe(200);
    expect(await goodRes.json()).toMatchObject({ ok: true, runtime: "zeroclaw", model: "gpt-6.1-terra", output: "native review evidence" });
    expect(readdirSync(stateDir)).toEqual([]);
    expect(readFileSync(join(worktreeDir, ".jeo-runtime-work/wf-1-review.md"), "utf8")).toBe("native review evidence\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handleDispatchRequest fails closed when native runtime execution fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-runtime-native-failure-"));
  try {
    const response = await handleDispatchRequest(
      new Request("http://runtime/dispatch", {
        method: "POST",
        headers: { "x-runtime-dispatch-secret": "runtime-dispatch-secret" },
        body: JSON.stringify({ workflowId: "wf-1", runtime: "nullclaw", role: "reviewer", stage: "review", request: "review" }),
      }),
      "nullclaw",
      "reviewer",
      "runtime-dispatch-secret",
      join(root, "state"),
      root,
      async () => { throw new Error("provider unavailable"); },
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider unavailable" });
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handleDispatchRequest rejects oversized bodies before writing artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "jeo-runtime-test-large-"));
  const stateDir = join(root, "state");
  const worktreeDir = join(root, "worktree");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });

  try {
    const body = JSON.stringify({
      workflowId: "wf-large",
      runtime: "zeroclaw",
      role: "reviewer",
      stage: "review",
      request: "x".repeat(70 * 1024),
    });

    const res = await handleDispatchRequest(
      new Request("http://runtime/dispatch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-runtime-dispatch-secret": "runtime-dispatch-secret",
        },
        body,
      }),
      "zeroclaw",
      "reviewer",
      "runtime-dispatch-secret",
      stateDir,
      worktreeDir,
    );

    expect(res.status).toBe(413);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

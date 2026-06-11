import { test, expect } from "bun:test";
import { bindTerminationHandlers, commandForRuntime, prepareRuntimeConfig, resolveRuntimeEnvironment, seedZeroclawProviderModel, shutdownRuntimeChild, validateRuntimeDispatchPayload, executeStageWork, handleDispatchRequest } from "./start.ts";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
test("prepareRuntimeConfig seeds zeroclaw Codex auth profile and runs OAuth refresh", () => {
  const root = join(process.env.TEMP || process.cwd(), "jeo-runtime-auth-zeroclaw");
  rmSync(root, { recursive: true, force: true });
  const stateDir = join(root, ".zeroclaw");
  const codexAuth = JSON.stringify({ refresh_token: "rt-live", access_token: "at-live" });
  const calls: Array<{ command: string; args: string[] }> = [];
  const runCommand = ((command: string, args: string[]) => {
    calls.push({ command, args });
    return { status: 0, stdout: "", stderr: "" };
  }) as any;

  const configDir = prepareRuntimeConfig(
    "zeroclaw",
    { OPENAI_CODEX_AUTH: codexAuth, LLM_MODEL: "gpt-5-codex" },
    stateDir,
    runCommand,
  );

  expect(configDir).toBeUndefined();
  expect(readFileSync(join(stateDir, "auth.json"), "utf8")).toBe(codexAuth);
  expect(calls).toEqual([
    {
      command: "zeroclaw",
      args: ["auth", "login", "--provider", "openai-codex", "--import", join(stateDir, "auth.json")],
    },
    { command: "zeroclaw", args: ["auth", "refresh", "--provider", "openai-codex"] },
  ]);

  const configToml = readFileSync(join(stateDir, "config.toml"), "utf8");
  expect(configToml).toContain('fallback = "openai-codex"');
  expect(configToml).toContain("[providers.models.openai-codex]");
  expect(configToml).toContain('model = "gpt-5-codex"');
  expect(configToml).toContain('wire_api = "responses"');
  expect(configToml).toContain("requires_openai_auth = true");
});

test("seedZeroclawProviderModel patches an existing empty providers table and is idempotent", () => {
  const root = join(process.env.TEMP || process.cwd(), "jeo-runtime-zeroclaw-seed");
  rmSync(root, { recursive: true, force: true });
  const stateDir = join(root, ".zeroclaw");
  mkdirSync(stateDir, { recursive: true });
  const configPath = join(stateDir, "config.toml");
  writeFileSync(configPath, "schema_version = 2\n\n[providers]\n\n[gateway]\nport = 42617\n");

  seedZeroclawProviderModel(stateDir, "gpt-5-codex", "responses");
  const seeded = readFileSync(configPath, "utf8");
  expect(seeded).toContain('[providers]\nfallback = "openai-codex"');
  expect(seeded).toContain("[providers.models.openai-codex]");
  expect(seeded).toContain("[gateway]");

  seedZeroclawProviderModel(stateDir, "gpt-5-codex", "responses");
  expect(readFileSync(configPath, "utf8")).toBe(seeded);
});

test("prepareRuntimeConfig seeds nullclaw Codex auth profile and imports it", () => {
  const root = join(process.env.TEMP || process.cwd(), "jeo-runtime-auth-nullclaw");
  rmSync(root, { recursive: true, force: true });
  const worktree = join(root, "workspace");
  const codexAuth = JSON.stringify({ refresh_token: "rt-live", access_token: "at-live" });
  const calls: Array<{ command: string; args: string[]; home?: string; xdgConfigHome?: string }> = [];
  const runCommand = ((command: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, home: opts.env.HOME, xdgConfigHome: opts.env.XDG_CONFIG_HOME });
    return { status: 0, stdout: "", stderr: "" };
  }) as any;

  const configDir = prepareRuntimeConfig(
    "nullclaw",
    { OPENAI_CODEX_AUTH: codexAuth, JEO_WORKTREE: worktree },
    join(root, ".config", "nullclaw"),
    runCommand,
  );

  expect(configDir).toBeUndefined();
  expect(readFileSync(join(worktree, ".codex", "auth.json"), "utf8")).toBe(codexAuth);
  expect(calls).toEqual([
    {
      command: "nullclaw",
      args: ["auth", "login", "openai-codex", "--import-codex"],
      home: worktree,
      xdgConfigHome: join(worktree, ".config"),
    },
    {
      command: "nullclaw",
      args: ["onboard", "--provider", "openai-codex", "--model", "gpt-5-codex", "--memory", "none"],
      home: worktree,
      xdgConfigHome: join(worktree, ".config"),
    },
  ]);
});

test("prepareRuntimeConfig redacts OAuth payloads from startup failures", () => {
  const root = join(process.env.TEMP || process.cwd(), "jeo-runtime-auth-redact");
  rmSync(root, { recursive: true, force: true });
  const codexAuth = JSON.stringify({ refresh_token: "rt-secret", access_token: "at-secret" });
  const runCommand = (() => ({ status: 1, stdout: "", stderr: `bad auth ${codexAuth}` })) as any;

  try {
    prepareRuntimeConfig("zeroclaw", { OPENAI_CODEX_AUTH: codexAuth }, join(root, ".zeroclaw"), runCommand);
    expect.unreachable();
  } catch (error: any) {
    expect(error.message).toContain("***REDACTED***");
    expect(error.message).not.toContain("rt-secret");
    expect(error.message).not.toContain("at-secret");
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


test("executeStageWork writes a tangible stage artifact", () => {
  const root = join(process.env.TEMP || process.cwd(), "jeo-runtime-test-artifacts");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const artifact = executeStageWork(root, {
    workflowId: "wf-1",
    runtime: "zeroclaw",
    role: "reviewer",
    stage: "review",
    request: "review the generated code",
    headRef: "jeo/zeroclaw/pr-creator/wf-1",
  });
  const content = readFileSync(artifact, "utf8");
  expect(content).toContain("workflowId: wf-1");
  expect(content).toContain("stage: review");
});

test("handleDispatchRequest authenticates and writes artifact plus receipt", async () => {
  const stateDir = join(process.env.TEMP || process.cwd(), "jeo-runtime-test-state");
  const worktreeDir = join(process.env.TEMP || process.cwd(), "jeo-runtime-test-worktree");
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(worktreeDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });

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
  );
  expect(goodRes.status).toBe(200);
  const payload = await goodRes.json() as { receiptPath: string; artifactPath: string };
  expect(readFileSync(payload.receiptPath, "utf8")).toContain("\"workflowId\": \"wf-1\"");
  expect(readFileSync(payload.artifactPath, "utf8")).toContain("stage: review");
});

test("handleDispatchRequest rejects oversized bodies before writing artifacts", async () => {
  const stateDir = join(process.env.TEMP || process.cwd(), "jeo-runtime-test-large-state");
  const worktreeDir = join(process.env.TEMP || process.cwd(), "jeo-runtime-test-large-worktree");
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(worktreeDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });

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
});

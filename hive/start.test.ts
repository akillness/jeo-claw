import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { buildChildSpecs, ChildSupervisor } from "./start.ts";
import type { HiveSecrets } from "./start.ts";
import { CLAW_PORTS } from "../glue/contract.ts";
import type { Role } from "../glue/contract.ts";

test("buildChildSpecs - environment isolation and port mapping", () => {
  const dummyParentEnv: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    LLM_MODEL: "gpt-6.1-terra",
    JEO_SECRET_SOURCE: "file",
    DISCORD_BOT_TOKEN: "inherited-discord",
    GITHUB_WEBHOOK_SECRET: "inherited-webhook",
    GITHUB_TOKEN: "inherited-write-token",
    OPENAI_CODEX_AUTH: "inherited-codex",
  };

  const dummySecrets: HiveSecrets = {
    discord: { DISCORD_BOT_TOKEN: "discord-token-1234567890", JEO_CONTROL_EVENT_SECRET: "control-event-1234567890" },
    orchestrator: {
      GITHUB_WEBHOOK_SECRET: "webhook-secret-1234567890",
      JEO_CONTROL_EVENT_SECRET: "control-event-1234567890",
      JEO_RUNTIME_DISPATCH_SECRET: "runtime-dispatch-1234567890",
    },
    roles: {
      "researcher-coder": {
        OPENAI_CODEX_AUTH: "codex-auth-1234567890",
        GITHUB_TOKEN: "github-token-ro-1234567890",
        JEO_RUNTIME_DISPATCH_SECRET: "runtime-dispatch-1234567890",
      },
      "reviewer": {
        OPENAI_CODEX_AUTH: "codex-auth-1234567890",
        GITHUB_TOKEN: "github-token-ro-1234567890",
        JEO_RUNTIME_DISPATCH_SECRET: "runtime-dispatch-1234567890",
      },
      "pr-creator": {
        OPENAI_CODEX_AUTH: "codex-auth-1234567890",
        GITHUB_TOKEN: "github-token-ro-1234567890",
        JEO_RUNTIME_DISPATCH_SECRET: "runtime-dispatch-1234567890",
      },
      "pr-review-scheduler": {
        OPENAI_CODEX_AUTH: "codex-auth-1234567890",
        GITHUB_TOKEN: "github-token-ro-1234567890",
        JEO_RUNTIME_DISPATCH_SECRET: "runtime-dispatch-1234567890",
      },
      "merger": {
        OPENAI_CODEX_AUTH: "codex-auth-1234567890",
        GITHUB_TOKEN: "github-token-ro-1234567890",
        JEO_RUNTIME_DISPATCH_SECRET: "runtime-dispatch-1234567890",
      },
    },
  };

  const specsWithGateway = buildChildSpecs(dummyParentEnv, dummySecrets, true);
  
  const orchSpec = specsWithGateway.find((s) => s.id === "orchestrator")!;
  expect(orchSpec).toBeDefined();
  expect(orchSpec.env.DISCORD_BOT_TOKEN).toBeUndefined();
  expect(orchSpec.env.GITHUB_WEBHOOK_SECRET).toBe("webhook-secret-1234567890");
  expect(orchSpec.env.OPENAI_CODEX_AUTH).toBeUndefined();
  const discordSpec = specsWithGateway.find((s) => s.id === "discord")!;
  expect(discordSpec.env.DISCORD_BOT_TOKEN).toBe("discord-token-1234567890");
  expect(discordSpec.env.JEO_CONTROL_EVENT_SECRET).toBe("control-event-1234567890");
  expect(discordSpec.env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
  expect(discordSpec.env.GITHUB_TOKEN).toBeUndefined();
  expect(discordSpec.env.OPENAI_CODEX_AUTH).toBeUndefined();

  for (const roleId of Object.keys(dummySecrets.roles) as Role[]) {
    const roleSpec = specsWithGateway.find((s) => s.id === roleId)!;
    expect(roleSpec).toBeDefined();
    expect(roleSpec.env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(roleSpec.env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(roleSpec.env.OPENAI_CODEX_AUTH).toBe("codex-auth-1234567890");
    expect(roleSpec.env.GITHUB_TOKEN).toBe("github-token-ro-1234567890");
    expect(roleSpec.env.JEO_CLAW_PORT).toBe(String(CLAW_PORTS[roleId]));
  }

  const gwSpec = specsWithGateway.find((s) => s.id === "zeroclaw-gateway")!;
  expect(gwSpec).toBeDefined();
  expect(gwSpec.env.OPENAI_CODEX_AUTH).toBe("codex-auth-1234567890");

  const specsWithoutGateway = buildChildSpecs(dummyParentEnv, dummySecrets, false);
  const gwSpec2 = specsWithoutGateway.find((s) => s.id === "zeroclaw-gateway");
  expect(gwSpec2).toBeUndefined();

  for (const roleId of Object.keys(dummySecrets.roles) as Role[]) {
    const roleSpec = specsWithoutGateway.find((s) => s.id === roleId)!;
    expect(roleSpec.env.LLM_GATEWAY_URL).toBeUndefined();
  }
});

test("supervisor children cannot inherit another component's credentials", async () => {
  const original = { ...process.env };
  Object.assign(process.env, {
    DISCORD_BOT_TOKEN: "parent-discord", GITHUB_WEBHOOK_SECRET: "parent-webhook",
    GITHUB_TOKEN: "parent-write", OPENAI_CODEX_AUTH: "parent-auth",
  });
  const roles: HiveSecrets["roles"] = {
    "researcher-coder": {}, reviewer: {}, "pr-creator": {}, "pr-review-scheduler": {}, merger: {},
  };
  const secrets: HiveSecrets = {
    discord: { DISCORD_BOT_TOKEN: "discord-only", JEO_CONTROL_EVENT_SECRET: "shared-control" },
    orchestrator: { GITHUB_WEBHOOK_SECRET: "webhook-only", JEO_CONTROL_EVENT_SECRET: "shared-control" },
    roles,
  };
  try {
    const specs = buildChildSpecs(process.env, secrets, false);
    for (const [id, expected] of [
      ["discord", { DISCORD_BOT_TOKEN: "discord-only", GITHUB_WEBHOOK_SECRET: null, GITHUB_TOKEN: null, OPENAI_CODEX_AUTH: null, JEO_CONTROL_EVENT_SECRET: "shared-control" }],
      ["orchestrator", { DISCORD_BOT_TOKEN: null, GITHUB_WEBHOOK_SECRET: "webhook-only", GITHUB_TOKEN: null, OPENAI_CODEX_AUTH: null, JEO_CONTROL_EVENT_SECRET: "shared-control" }],
    ] as const) {
      const spec = specs.find((entry) => entry.id === id);
      expect(spec).toBeDefined();
      let child: ChildProcess | undefined;
      let output = "";
      const supervisor = new ChildSupervisor({ ...spec!, command: [process.execPath, "-e", 'const keys=["DISCORD_BOT_TOKEN","GITHUB_WEBHOOK_SECRET","GITHUB_TOKEN","OPENAI_CODEX_AUTH","JEO_CONTROL_EVENT_SECRET"]; console.log(JSON.stringify(Object.fromEntries(keys.map(k=>[k,process.env[k] ?? null]))))'] }, {
        spawnChild: ((command, args, options) => {
          const spawned = spawn(command, args ?? [], { ...options, stdio: ["ignore", "pipe", "pipe"] });
          child = spawned;
          spawned.stdout!.on("data", (chunk) => { output += chunk; });
          return spawned;
        }) as typeof spawn,
      });
      supervisor.start();
      try {
        expect(child).toBeDefined();
        const [code] = await once(child!, "close");
        expect(code).toBe(0);
        expect(JSON.parse(output)).toEqual(expected);
      } finally {
        supervisor.shutdown();
      }
    }
  } finally {
    for (const key of ["DISCORD_BOT_TOKEN", "GITHUB_WEBHOOK_SECRET", "GITHUB_TOKEN", "OPENAI_CODEX_AUTH"]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});

test("ChildSupervisor cancels pending activation timers during shutdown", () => {
  const children: Array<EventEmitter & { kill: () => boolean }> = [];
  const timers = new Map<object, () => void>();
  const cancelled: object[] = [];

  const supervisor = new ChildSupervisor(
    { id: "test", command: ["fake"], env: {} },
    {
      spawnChild: (() => {
        const child = Object.assign(new EventEmitter(), { kill: () => true });
        children.push(child);
        return child as unknown as ChildProcess;
      }) as typeof spawn,
      schedule: ((callback: () => void) => {
        const handle = {};
        timers.set(handle, callback);
        return handle;
      }) as unknown as typeof setTimeout,
      cancel: ((handle: object) => {
        cancelled.push(handle);
        timers.delete(handle);
      }) as unknown as typeof clearTimeout,
    },
  );

  supervisor.start();
  supervisor.start();
  expect(children).toHaveLength(1);

  children[0]!.emit("exit", 1, null);
  expect(timers.size).toBe(1);

  supervisor.shutdown();
  expect(timers.size).toBe(0);
  expect(cancelled).toHaveLength(2);
});

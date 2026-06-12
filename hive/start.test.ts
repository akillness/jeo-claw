import { test, expect } from "bun:test";
import { buildChildSpecs } from "./start.ts";
import type { HiveSecrets } from "./start.ts";
import { CLAW_PORTS } from "../glue/contract.ts";
import type { Role } from "../glue/contract.ts";

test("buildChildSpecs - environment isolation and port mapping", () => {
  const dummyParentEnv: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    LLM_MODEL: "gpt-5-codex",
    JEO_SECRET_SOURCE: "file",
  };

  const dummySecrets: HiveSecrets = {
    orchestrator: {
      GITHUB_WEBHOOK_SECRET: "webhook-secret-1234567890",
      DISCORD_BOT_TOKEN: "discord-token-1234567890",
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
  expect(orchSpec.env.DISCORD_BOT_TOKEN).toBe("discord-token-1234567890");
  expect(orchSpec.env.GITHUB_WEBHOOK_SECRET).toBe("webhook-secret-1234567890");
  expect(orchSpec.env.OPENAI_CODEX_AUTH).toBeUndefined();

  for (const roleId of Object.keys(dummySecrets.roles) as Role[]) {
    const roleSpec = specsWithGateway.find((s) => s.id === roleId)!;
    expect(roleSpec).toBeDefined();
    expect(roleSpec.env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(roleSpec.env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(roleSpec.env.OPENAI_CODEX_AUTH).toBe("codex-auth-1234567890");
    expect(roleSpec.env.GITHUB_TOKEN).toBe("github-token-ro-1234567890");
    expect(roleSpec.env.JEO_CLAW_PORT).toBe(String(CLAW_PORTS[roleId]));
    expect(roleSpec.env.LLM_GATEWAY_URL).toBe("http://127.0.0.1:4096");
  }

  const gwSpec = specsWithGateway.find((s) => s.id === "zeroclaw-gateway")!;
  expect(gwSpec).toBeDefined();
  expect(gwSpec.env.OPENAI_CODEX_AUTH).toBe("codex-auth-1234567890");
  expect(gwSpec.command).toEqual(["zeroclaw", "gateway", "start", "-p", "4096"]);

  const specsWithoutGateway = buildChildSpecs(dummyParentEnv, dummySecrets, false);
  const gwSpec2 = specsWithoutGateway.find((s) => s.id === "zeroclaw-gateway");
  expect(gwSpec2).toBeUndefined();

  for (const roleId of Object.keys(dummySecrets.roles) as Role[]) {
    const roleSpec = specsWithoutGateway.find((s) => s.id === roleId)!;
    expect(roleSpec.env.LLM_GATEWAY_URL).toBeUndefined();
  }
});

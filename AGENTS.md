# Repository Guidelines

## Project Overview

`jeo-claw` is a **dual-runtime agentic PR orchestration system** that runs two agent
runtimes — **ZeroClaw** (Rust) and **NullClaw** (Zig) — side by side under identical
LLM settings (`openai` / `gpt-5-codex`) to perform continuous **A/B comparison** while
they drive pull requests on the target repo `akillness/jeo-claw` itself.

The orchestration layer (glue, Discord bot, A/B compare, secret loader, validators) is
written in **Bun + TypeScript**. The runtimes themselves run as hardened Docker
containers. Humans control the system and approve high-risk actions through **Discord**;
secrets come from **gcloud Secret Manager** with per-role least privilege.

Design spec: `.gjc/specs/deep-interview-jeo-claw-orchestration.md`. Progress ledger:
`.gjc/ultragoal/ledger.jsonl` (stories G001–G006).

## Architecture & Data Flow

```
GitHub webhook ─▶ glue/server.ts (HTTP :8787)
                    │  verifySignature (HMAC-SHA256, timing-safe)
                    │  parseWebhook → {event, prNumber, ciPassed}
                    ▼
              glue/state-machine.ts  applyEvent → advanceStage
                    │  stages: research-code → review → pr-create
                    │          → pr-review-schedule → merge
                    ▼
              glue/merge-gate.ts  evaluateMergeGate
                    │  BLOCKS merge unless CI && review && Discord-approved
                    ▼
              discord/bot.ts  approvals/status (ApprovalRegistry, buttons)
                    ▼
   compare/runner.ts ─▶ compare/metrics.ts ─▶ compare/dashboard.ts (Discord embed)
```

- **5 roles map 1:1 to 5 stages**: `researcher-coder`, `reviewer`, `pr-creator`,
  `pr-review-scheduler`, `merger`. Roles/stages live in the runtime configs and are
  executed by each runtime's built-in SOP/subagents; the TS glue is a thin connector.
- **Central type contract**: `glue/contract.ts` defines `Runtime`, `WorkflowState`,
  `Stage`, `WorkflowStatus`, the `ControlEvent` discriminated union, `MergeGateInput/Result`,
  and `MetricSample`/`RuntimeMetricSummary`. Every module imports types from here.
- **State store is in-memory** (`Map<workflowId, WorkflowState>` in `glue/server.ts`) —
  ephemeral, no persistence layer.
- **Container topology** (`docker-compose.yml`): `edge` network (external, egress-proxy
  only) + `claw_internal` (`internal: true`, runtimes only). All egress flows through a
  squid **allowlist proxy** (`compose/egress-proxy/`).

## Key Directories

| Path | Purpose |
|------|---------|
| `glue/` | Webhook receiver, workflow state machine, merge-gate policy, shared `contract.ts` |
| `discord/` | Discord.js control bot, command parser, high-risk approval registry |
| `compare/` | A/B run orchestrator, metric aggregation, dashboard rendering |
| `secrets/` | gcloud Secret Manager loader with per-role least-privilege mapping |
| `config/` | Runtime configs (`zeroclaw.config.toml`, `nullclaw.config.json`) + A/B fairness validator |
| `scripts/` | `check-compose.ts` static security validator |
| `runtimes/{zeroclaw,nullclaw}/` | Dockerfiles (ZeroClaw prebuilt binary; NullClaw multi-stage Zig build) |
| `compose/egress-proxy/` | `squid.conf` + `allowlist.txt` |
| `qa/` | Adversarial red-team test suite |
| `artifacts/` | QA evidence (red-team report/transcript, verify transcript) |

## Development Commands

Run all commands from this directory (`jeo-claw/`). **Use Bun, not npm/node.**

```bash
bun install                # install deps (discord.js, yaml, @types/bun)
bun test                   # run all *.test.ts (Bun native test runner)
bun run check:compose      # static Docker/security validation (no Docker needed)
bun run glue               # start webhook server (glue/server.ts, :8787)
bun run discord            # start Discord control bot (discord/bot.ts)
bun run compare            # run A/B comparison runner (compare/runner.ts)
bunx tsc --noEmit          # type-check only (tsconfig has noEmit: true)

# Docker (only in a Docker environment)
cp .env.example .env       # fill non-secret IDs/config only
docker compose up -d --build
docker compose ps          # expect zeroclaw/nullclaw/egress-proxy healthy
```

There is **no separate lint step**; correctness is enforced by `tsc --noEmit`, `bun test`,
and `bun run check:compose`.

## Code Conventions & Common Patterns

- **Naming**: `camelCase` functions/vars (`parseCommand`, `applyEvent`, `ciPassed`);
  `PascalCase` classes/types (`ApprovalRegistry`, `WorkflowState`, `ControlEvent`);
  `UPPER_SNAKE` env vars and const maps (`DISCORD_BOT_TOKEN`, `STAGES`, `ROLE_SECRETS`).
- **Module layout**: source `x.ts` with a **colocated** `x.test.ts` in the same directory.
- **Types-first**: import shared types from `glue/contract.ts`; use `import type { … }`
  (tsconfig sets `verbatimModuleSyntax: true`). TS extensions are imported explicitly
  (e.g. `import { … } from "./contract.ts"`).
- **Pure functions for core logic**: `merge-gate.ts`, `state-machine.ts`, `metrics.ts`
  are side-effect-free. State transitions are **immutable** (spread state, new arrays/history).
- **Dependency injection via factories**: `discord/bot.ts` exposes `buildHandlers(deps)`
  (store, registry, callbacks) so handlers are testable without a live client; secrets use
  an injectable `SecretSource` interface (`GcloudSecretSource` in prod, `MockSource` in tests).
- **Result/guard objects, not exceptions, for policy**: validators return
  `{ ok, reason? }`, guards return `{ allowed, reason? }`, merge gate returns
  `{ allowed, reasons: string[] }`. Reserve `throw` for hard failures
  (`MissingSecretError` when a secret is missing/empty — secrets are never silently skipped).
- **Async**: `async/await` + `Promise` everywhere (Bun HTTP handler, Discord handlers,
  `child_process.spawn` for gcloud, `runComparison`); no callback nesting.
- **Security patterns to preserve**:
  - Webhook auth uses `createHmac('sha256')` + `timingSafeEqual` (constant-time).
  - Merge requires **all three** booleans (`ciPassed && reviewPassed && discordApproved`).
    Use **strict `=== true`** checks (see Known Issues).
  - High-risk actions (`git.push`, `git.merge`, `pr.merge`) are blocked unless approved.
  - Secret values are redacted (`***REDACTED***`) in logs/errors; only secret **ids** surface.
  - Configs reference secrets only via `${ENV_REF}` — **never hardcode tokens**.

## Important Files

- **Entry points** (gated by `if (import.meta.main)`): `glue/server.ts`,
  `discord/bot.ts`, `compare/runner.ts`, `config/validate.ts`.
- **Type contract**: `glue/contract.ts` (single source of truth for shared types).
- **Policy core**: `glue/merge-gate.ts`, `glue/state-machine.ts`.
- **Security**: `glue/github-webhook.ts` (HMAC), `discord/approval.ts` (high-risk guard),
  `secrets/loader.ts` (least-privilege role→secret map), `scripts/check-compose.ts`.
- **Config & infra**: `config/{zeroclaw.config.toml,nullclaw.config.json}`,
  `config/validate.ts` (A/B fairness), `docker-compose.yml`, `compose/egress-proxy/allowlist.txt`,
  `.env.example`, `tsconfig.json`, `package.json`.
- **Docs**: `README.md`, `SECURITY.md` (2026 claw security baseline).

## Runtime/Tooling Preferences

- **Runtime: Bun** (project relies on `bun:test`, `Bun.TOML`, `@types/bun`,
  `import.meta.main`). No Node version is pinned; do not assume Node-only APIs.
- **Package manager: Bun** (`bun.lock` present — do not introduce `package-lock.json`
  or `yarn.lock`).
- **ES modules** (`"type": "module"`); `tsconfig` uses `module: Preserve`,
  `moduleResolution: bundler`, `allowImportingTsExtensions: true`, `noEmit: true`.
- **Strict TypeScript**: `strict: true` plus `noUncheckedIndexedAccess`,
  `noFallthroughCasesInSwitch`, `noImplicitOverride`. Honor these (handle `undefined`
  from indexed access; add `override`; cover switch cases).
- **Dependencies are minimal**: `discord.js ^14`, `yaml ^2`. Prefer Bun/Node built-ins
  (`node:crypto`, `child_process`, `fs`) over new dependencies.

## Testing & QA

- **Framework**: Bun's native runner — `import { test, expect, mock } from "bun:test"`.
- **Style**: flat `test("desc", () => {…})` blocks grouped by numbered comment sections
  (e.g. `// 1. MERGE GATE BYPASS`); no `describe/it` hierarchy. Assertions use
  `.toBe()`, `.toEqual()`, `.toContain()`, `.toBeInstanceOf()`,
  `await expect(...).rejects.toBeInstanceOf(...)`.
- **Mocking via injected fakes**: implement the interface (`MockSource`/`SpySource` for
  `SecretSource`) and assert on recorded calls; `mock()` from `bun:test` for handler spies.
- **Run**: `bun test` (all suites) or target a file, e.g. `bun test glue/merge-gate.test.ts`.
- **Coverage themes**: merge-gate blocking (all 2-of-3 combos rejected), webhook signature
  forgery, secret least-privilege (read-only roles never get write tokens; only
  `pr-creator`/`merger` write; only `merger` gets the webhook secret), high-risk approval
  gating, state-machine transitions (rejected/merged are terminal), A/B config fairness
  (identical model/provider, `autonomy=supervised`, exactly 5 roles, no plaintext secrets),
  and Docker posture (`qa/red-team.test.ts`, `scripts/check-compose.test.ts`).
- **Static gates before Docker**: `bunx tsc --noEmit`, `bun run check:compose`
  (asserts no host docker socket, network isolation, restart policy, egress allowlist,
  no plaintext secrets in `.env.example`), and `bun run config/validate.ts`.
- **Known issue** (`artifacts/red-team-report.md`): `evaluateMergeGate` accepted
  truthy-but-not-`true` values (e.g. `ciPassed: "yes"`), allowing a merge bypass. Fix is
  strict boolean equality (`=== true`, not `!`). New code touching policy gates **must**
  use strict checks and add a regression test.

# Plan: Replace in-memory Map with bun:sqlite WorkflowState persistence

Status: pending-approval
Scope: `glue/store.ts`, `glue/server.ts`, `glue/server.test.ts`, `scripts/smoke-glue.ts`,
`scripts/{tui,tui-capture,tui-snapshot,add-dummy-wf}.ts`, `.env.example`,
`docker-compose.yml`, `scripts/check-compose.ts` (sync only), `AGENTS.md`, `README.md`.

## Context / current state

A prior run left the migration half-finished and broken:

- `glue/store.ts` exists: `WorkflowStore` interface + `SQLiteWorkflowStore` (sync,
  single `workflows(id, data, last_touched)` JSON-blob table).
- `glue/server.ts` is corrupted: duplicated/nested `processQueue` (lines 19–42),
  out-of-scope `updated` references, undefined `autoCapture()` calls, and
  `Map<string, WorkflowState>` typings still on `pruneWorkflowStore`,
  `WorkflowBrokerOpts.store`, and `handleControlEventRequest` while the module-level
  `store` is the SQLite store. `bunx tsc --noEmit` cannot pass.
- `glue/server.test.ts` and `scripts/smoke-glue.ts` still inject `new Map(...)`.
- `scripts/tui*.ts` / `add-dummy-wf.ts` already read `SQLiteWorkflowStore` directly.
- `pendingQueue` (in-memory array) is a second source of truth that does not survive
  restart — defeating the point of persistence.

Strategy: fix-forward (do not revert; treat existing work as user work).

## Design decisions

1. **Synchronous `WorkflowStore` interface.** bun:sqlite is synchronous; keep
   `get/set/delete/values/size` sync. Remove the stray `await`s in `server.ts` and the
   tui scripts. (Async-shaped interface deferred until a non-SQLite backend exists.)
2. **Schema v2 — JSON blob + queryable columns.** Keep `data TEXT` as source of truth;
   add extracted columns maintained on every `set()`:
   - `status TEXT NOT NULL`, `pr_number INTEGER NULL`, `terminal INTEGER NOT NULL`,
     `last_touched INTEGER NOT NULL` (computed from `workflowLastTouchedMs`-style
     history/approval timestamps, fallback `Date.now()`).
   - Indexes: `idx_workflows_pr_number`, `idx_workflows_status`.
   - `CREATE TABLE IF NOT EXISTS` + additive `ALTER TABLE` guard for existing DBs
     (pre-release; no formal migration framework needed).
3. **Pragmas**: `journal_mode = WAL` (tui scripts read the same file concurrently),
   `busy_timeout = 5000`, `synchronous = NORMAL`.
4. **Store-owned queries** replacing O(n) scans in `server.ts`:
   - `getByPrNumber(prNumber)` — replaces the webhook full-store scan.
   - `hasActive()` — `status IN ('running','pending')` — replaces `isAnyWorkflowRunning` loop.
   - `queuedIds()` — `status = 'queued'` ordered by insertion (rowid) — replaces `pendingQueue`.
   - `prune(policy)` — SQL-side: delete terminal rows older than retention, then cap
     to `maxWorkflows` deleting oldest-terminal-first, never deleting active rows below cap.
     `pruneWorkflowStore(map, policy)` is deleted; its tests move to `store.test.ts`.
   - `close()` for tests/smoke teardown.
5. **Queue derived from DB.** Drop the `pendingQueue` array. "Queue position" =
   count of earlier `queued` rows. `processQueue` pops the oldest `queued` row.
   Boot recovery in `start()`: rows stuck in `running`/`pending` from a previous crash
   are marked `failed` with a history entry (write actions are not safely replayable);
   `queued` rows are picked up naturally by `processQueue`.
6. **Immutability preserved.** No `wf.status = ...` in-place mutation; spread to a new
   object before `set()`. `set()` is the only persistence point — handlers keep their
   current shape (`applyEvent`/`progressWorkflowState` stay pure).
7. **Tests use `new SQLiteWorkflowStore(":memory:")`** — exercises the real store with
   zero filesystem residue. No separate `InMemoryWorkflowStore` class.
8. **No secrets in the DB.** `WorkflowState` carries no credentials today (tokens are
   brokered transiently); add a `store.test.ts` assertion that a round-tripped state
   contains no `GITHUB_TOKEN`-like keys as a tripwire.

## Phases

### Phase 0 — Repair `glue/server.ts` corruption (prerequisite)
- Deduplicate `processQueue` into one function; remove out-of-scope trailing block.
- Remove the two `autoCapture(updated)` calls (symbol does not exist anywhere). If
  capture-on-terminal is wanted, it is a separate feature via `ops/scripts/capture-knowledge.ts`.
- Acceptance: file parses; no undefined identifiers.

### Phase 1 — Harden `glue/store.ts`
- Schema v2, pragmas, extracted columns, indexes per decisions 2–3.
- Add `getByPrNumber`, `hasActive`, `queuedIds`, `prune`, `close`; type the JSON
  (de)serialization (`JSON.parse(row.data) as WorkflowState`); parameterize statements
  via prepared queries.
- New colocated `glue/store.test.ts`: CRUD round-trip with nested
  `actionApprovals`/`history` fidelity, `getByPrNumber`, `hasActive`, queue ordering,
  prune (terminal retention expiry, max-cap eviction order, active rows survive),
  `:memory:` isolation, no-credential tripwire.

### Phase 2 — Rewire `glue/server.ts`
- Replace every `Map<string, WorkflowState>` typing with `WorkflowStore`
  (`WorkflowBrokerOpts`, `handleControlEventRequest` signature).
- Replace scans: webhook pr-number lookup → `getByPrNumber`; `isAnyWorkflowRunning`
  → `hasActive`; queue → `queuedIds` (delete `pendingQueue` export).
- All `pruneWorkflowStore(opts.store, opts.storePolicy)` call sites → `opts.store.prune(opts.storePolicy)`.
- Remove stray `await`s on store calls; restore immutable status transitions.
- `start()`: boot recovery (decision 5); default DB path `data/workflows.sqlite`
  (gitignored via existing `data/` + `*.sqlite` rules), overridable by `SQLITE_DB_PATH`.
- `/debug/workflows` and `queuePosition` responses keep their current JSON shape.

### Phase 3 — Update consumers
- `glue/server.test.ts`: `new Map(...)` → `new SQLiteWorkflowStore(":memory:")`;
  adapt prune tests; keep all existing security/policy assertions intact.
- `scripts/smoke-glue.ts`: `:memory:` store (or temp-file + cleanup), same flow proof.
- `scripts/tui.ts`, `tui-capture.ts`, `tui-snapshot.ts`, `add-dummy-wf.ts`: drop the
  incorrect `await store.values()`, default path aligned to `data/workflows.sqlite`
  with `SQLITE_DB_PATH` override (tui.ts/tui-capture.ts already honor the env).

### Phase 4 — Ops/infra/docs
- `.env.example`: add `SQLITE_DB_PATH` (non-secret, documented default).
- `docker-compose.yml`: named volume (e.g. `glue-data:/app/data`) on the glue service +
  `SQLITE_DB_PATH=/app/data/workflows.sqlite`; keep read-only rootfs posture by scoping
  the writable mount to `/app/data` only.
- `scripts/check-compose.ts`: extend/keep green for the new volume + env (validators are
  contract, not lint).
- `AGENTS.md`: replace "State store is in-memory … no persistence layer" with the SQLite
  description; mention `glue/store.ts` in Important Files. `README.md` likewise if it
  states ephemerality.
- Delete leftover junk: `gjc_ralplan_output.txt`, `gjc_ooo_ralph_output.txt` (0-byte).

### Phase 5 — Verification gates (all must pass)
- `bunx tsc --noEmit`
- `bun test` (including new `glue/store.test.ts`)
- `bun run smoke:glue` — full request→approval→brokered write→merge over SQLite store
- `bun run check:compose` and `bun run config/validate.ts`
- Restart proof: scripted check that a `queued` workflow created before process exit is
  picked up after restart, and a crashed `running` workflow is marked `failed`.

## Risks

- **Restart semantics for in-flight write actions**: marking crashed `running` workflows
  `failed` is conservative; replaying `pr.create`/`pr.merge` blindly could double-write
  to GitHub. Revisit with idempotency keys if this hurts.
- **`last_touched` semantics**: prune now reads a column computed at write time instead
  of re-deriving per prune call — equivalent given `set()` is the only mutation path;
  covered by prune tests.
- **Concurrent writers**: single glue process owns writes; tui scripts are readers.
  WAL + busy_timeout covers it. Opening tui scripts read-only (`{ readonly: true }`) is
  a cheap extra guard.

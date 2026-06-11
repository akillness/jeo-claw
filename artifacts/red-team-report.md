# Red-team report: OAuth provider auth migration

Generated: 2026-06-10T04:06:39.802Z

## Verdict

PASS — adversarial suite is green.

## Evidence

- Command: `bun test qa/red-team.test.ts`
- Exit: 0
- Passing tests: 26
- Failing tests: 0
- Transcript: `artifacts/red-team-transcript.txt`

## Coverage highlights

- Forged GitHub webhook signatures remain denied.
- Action-scoped approvals remain single-use and workflow/action isolated.
- Runtime roles receive `openai-codex-oauth` plus read-only startup GitHub credentials, never mediated write tokens at startup.
- Control services do not receive runtime OAuth credentials or GitHub role tokens.
- Static compose checks reject plaintext `OPENAI_API_KEY` and `OPENAI_CODEX_AUTH` env injection.

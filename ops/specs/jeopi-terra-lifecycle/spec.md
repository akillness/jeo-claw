# Specification: jeopi, Terra, and lifecycle hardening

## Requirements

- Operational coding-agent invocations and persistent state use `jeopi`, not `gjc`.
- The logical default provider is OpenAI and the exact supported model is
  `gpt-6.1-terra`; the native ChatGPT OAuth adapter remains `openai-codex`.
- ZeroClaw, NullClaw, workflow, and jeo-skills paths have executable verification.
- Session activation owns and releases timers/processes and blocks duplicate starts.
- Hidden runtime files are ignored while required tracked configuration stays visible.
- Only demonstrably unreferenced root scratch/output files are removed.
- Existing tracked deletions and unmerged branches are preserved.
- Docker work is scoped to the `jeo-claw` Compose project and services are stopped.

## Acceptance

- Targeted lifecycle and integration tests pass.
- Typecheck, full tests, compose validator, config validator, and workflow smoke pass.
- Live-only blockers are reported, never represented as successful verification.


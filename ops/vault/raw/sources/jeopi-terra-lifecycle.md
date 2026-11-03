---
title: Jeopi, GPT-6.1 Terra & Lifecycle Hardening
slug: jeopi-terra-lifecycle
type: source
tags: [jeopi, terra, lifecycle, security, cleanup, runtime]
created: 2026-11-04
runtime: both
---

# Jeopi, GPT-6.1 Terra & Lifecycle Hardening (원천 기록 · 불변)

## 요약
Replaced obsolete gjc operational paths with ephemeral jeopi coding-agent invocations, aligned OpenAI default provider with gpt-6.1-terra (via openai-codex OAuth adapter), hardened process/timer/stream lifecycle and shutdown handling across glue/discord/hive/runtimes/claws, fixed runtimes/start.test.ts temp directory leakage, updated .gitignore to preserve tracked project configs while ignoring hidden runtime state, and removed 68 unreferenced root scratch files and runtime test directories.

## 증거 / 경로
- ops/specs/jeopi-terra-lifecycle/spec.md
- ops/plans/jeopi-terra-lifecycle/plan.md
- ops/plans/jeopi-terra-lifecycle/tasks.md
- artifacts/native-qualification/summary.json
- runtimes/start.test.ts
- .gitignore

> 이 파일은 raw 원천이다. 정정·종합은 [[wiki/sources/jeopi-terra-lifecycle]]에서 한다.

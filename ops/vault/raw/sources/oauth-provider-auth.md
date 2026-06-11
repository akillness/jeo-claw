---
title: OAuth provider 인증 전환 (Phase 1: openai-codex)
slug: oauth-provider-auth
type: source
tags: [security, secrets, oauth, provider, discord, gcloud]
created: 2026-06-10
runtime: both
---

# OAuth provider 인증 전환 (Phase 1: openai-codex) (원천 기록 · 불변)

## 요약
정적 LLM API key를 제거하고 ChatGPT 구독 OAuth(openai-codex) 인증 체계로 전환. 
Secret Manager에서 refresh token을 로드하여 런타임(ZeroClaw, NullClaw)의 auth profile을 시드하는 방식을 구현. 
양 런타임의 동일 provider/model/wire 유지로 A/B 공정성을 확보함.

## 증거 / 경로
- ops/specs/oauth-provider-auth/spec.md
- ops/plans/oauth-provider-auth/plan.md
- ops/plans/oauth-provider-auth/tasks.md
- artifacts/verify-transcript.txt
- artifacts/docker-live-transcript.txt

> 이 파일은 raw 원천이다. 정정·종합은 [[wiki/sources/oauth-provider-auth]]에서 한다.

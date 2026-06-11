---
title: OAuth provider 인증 전환 (Phase 1: openai-codex)
slug: oauth-provider-auth
type: source-summary
tags: [security, secrets, oauth, provider, discord, gcloud]
created: 2026-06-10
runtime: both
---

# OAuth provider 인증 전환 (Phase 1: openai-codex)

> 원천: [[raw/sources/oauth-provider-auth]]

## 무엇을·왜·결과
정적 API 키 노출 위험을 제거하기 위해 ChatGPT OAuth(openai-codex) 인증으로 전환했습니다. 
Secret Manager(openai-codex-oauth)로부터 refresh token을 가져와 부팅 시 각 런타임에 시드하고, 런타임이 스스로 토큰을 갱신(self-refresh)하도록 설계했습니다.
단위 테스트 163개 통과, 4대 정적 게이트 클린, 실환경(live) Discord 봇 기동 및 명령 등록을 통해 검증을 완료했습니다.

## 연결 (wikilink)
- 관련 개념: [[wiki/concepts/oauth-seeding]], [[wiki/concepts/ab-parity]]
- 관련 개체: [[wiki/entities/zeroclaw]], [[wiki/entities/nullclaw]], [[wiki/entities/secret-manager]]

## 후속 / 진화 후보
- Phase 2: Antigravity(Gemini/Google OAuth) - NullClaw 업스트림의 Gemini OAuth 지원 시 재개.
- RULES.md 승격: 런타임 auth profile 시드 시 named volume 권한(0600) 및 redact 규칙 고착화.

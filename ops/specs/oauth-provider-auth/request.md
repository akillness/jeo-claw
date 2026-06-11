<!-- 0. INTAKE -->

# 요청: OAuth 기반 provider 인증 (GPT · Antigravity)

- **slug**: oauth-provider-auth
- **입력원**: 직접 사용자 요청
- **runtime**: both (zeroclaw · nullclaw)
- **접수일**: 2026-06-08

## 원문 요청
API key 값 설정이 아닌 OAuth 인증 방식으로 GPT, Antigravity provider를 사용할 수 있도록 한다.

## 맥락
현재 양 런타임은 정적 `${OPENAI_API_KEY}`(Secret Manager의 `<prefix>-openai-api-key`)로
OpenAI에 인증한다(`config/*.config.*`, `secrets/loader.ts ROLE_SECRETS/ENV_FOR`).
API key 노출/회전 부담을 줄이고, GPT(ChatGPT) + Antigravity(Google) 두 provider를
OAuth로 인증해 쓰려는 것.

## vault 사전 검색 (EVOLVE)
- 검색어: oauth, provider, api-key, secret loader
- 발견한 기존 지식: 없음(신규 도메인). 관련 자산: `ops/vault/wiki/sources/ops-self-evolution-engine`
- 재사용/회피할 결정: 비밀은 Secret Manager 경유·평문 금지(CONSTITUTION I) 그대로 유지.

## 확정된 설계 결정 (CLARIFY 응답)
1. **주입 방식**: refresh token을 Secret Manager에 저장 → glue control-plane refresher가
   access token으로 교환·캐시·갱신 후 런타임에 **브로커**(런타임 변경 최소).
2. **A/B 공정성**: 비교 단위는 **동일 provider+model 유지**(불변). `LLM_PROVIDER`는 양 런타임
   공통 선택값(GPT 또는 Antigravity 중 하나로 같이 감).
3. **GPT 플로우**: ChatGPT 계정 OAuth(access+refresh token, ChatGPT 백엔드 스타일).

## 모호도 신호 (CLARIFY 게이트) — 해소됨
- [x] 보안·승인 정책에 닿음 → 위 결정으로 범위 확정
- [ ] 잔여 미정: 런타임(ZeroClaw/NullClaw)의 OAuth/Antigravity provider 네이티브 지원 범위 (PLAN의 검증 항목)

<!-- 5. TASKS — task #0 조사 반영 최종본 -->

# 작업 분해: OAuth provider 인증 (Phase 1 = openai-codex)

- **slug**: oauth-provider-auth
- **연계 계획**: plan.md

| # | 작업 | 의존 | 검증 | 위임 |
|---|------|------|------|------|
| 0 | ✅ 런타임 OAuth 지원 조사 (완료) | - | runtime-support.md | done |
| 1 | ✅ contract.ts `LLMProvider` union + 상수 + 파서 | 0 | tsc + 단위 테스트 | done |
| 2 | ✅ secrets/loader.ts: `openai-api-key`→`openai-codex-oauth`, ENV_FOR/ROLE 갱신 | 1 | loader.test.ts green | executor |
| 3 | ✅ runtimes/start.ts: auth.json 시드 + import/refresh 기동 시퀀스 | 2 | runtimes/start.test.ts green (시드/redact) | done |
| 4 | ✅ config 2종 provider=openai-codex(OAuth)로 전환, 정적 key 제거 | 1 | config/validate.ts 26/26 green | executor |
| 5 | ✅ config/validate.ts provider 일반화 + 정적 key 부재 검사 | 4 | validate.test.ts green | executor |
| 6 | ✅ preflight-live.ts + .env.example 갱신 | 2 | preflight-live.test.ts green | executor |
| 7 | ✅ 4대 게이트 + smoke-glue 통합 검증 (2026-06-10: tsc clean · bun test 163/0 · check:compose 176/176 · validate 26/26 · smoke:glue PASS · file-backed preflight:live PASS; direct gcloud preflight attempted but live secret ids unreadable in this session) | 1-6 | artifacts/verify-transcript.txt | done |
| 8 | ✅ Docker 재빌드·live 기동 확인 | 7 | 실제 Secret Manager 값으로 `secrets/live.json` 생성 후 live compose 기동; 13/13 컨테이너 healthy, Discord bot ready, 채널 `1483454454350221472` 메시지/명령 등록/내부 control path 201 확인 (`artifacts/docker-live-transcript.txt`) | done |
| 9 | ✅ CAPTURE: vault 적재 | 7 | capture-knowledge 실행 (raw/wiki 기존 페이지 보존, log/index 갱신) | done |

## ANALYZE 점검 (6단계)
- [x] constitution ↔ spec ↔ plan ↔ tasks 모순 없음 (IV 공정성: provider 동일성 `openai-codex` 유지)
- [x] 보안: refresh token 런타임 상주 트레이드오프를 spec 완화책으로 수용, redact·named volume·이미지 미포함 준수
- [x] 신규 고위험 액션 없음 → Discord 승인 변경 불필요
- [x] Antigravity는 비목표(보류) — scope creep 방지

## 보류 (Phase 2 후보)
- Antigravity(Gemini/Google OAuth): NullClaw가 Gemini OAuth 지원 시 재개. 업스트림 추적 이슈로 등록.

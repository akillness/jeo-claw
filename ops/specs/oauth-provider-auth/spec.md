<!-- 2. SPECIFY — 무엇을·왜. how는 plan.md. task #0 조사 반영 최종본 -->

# 명세: OAuth 기반 provider 인증 (Phase 1 = GPT/openai-codex)

- **slug**: oauth-provider-auth
- **헌법 항목**: I(보안·비밀), III(검증), IV(A/B 공정성), VII(사람 통제)
- **근거 조사**: `runtime-support.md` (task #0)

## 문제 / 목표
정적 LLM API key를 제거하고 **GPT를 ChatGPT 구독 OAuth(`openai-codex`)** 로 인증한다.
두 런타임 모두 `openai-codex` OAuth를 네이티브 지원하므로 A/B 공정성을 유지한 채 전환 가능.
Antigravity(Gemini/Google OAuth)는 **NullClaw 미지원**으로 이번 범위에서 보류(업스트림 추적).

## 유저 스토리
- 운영자로서 ChatGPT OAuth refresh token을 Secret Manager에 한 번 등록하면, 양 런타임이
  부팅 시 auth profile을 시드받아 self-refresh로 끊김 없이 동작하길 원한다.
- 운영자로서 API key를 코드/이미지/리포 어디에도 두지 않길 원한다.

## 수용 기준 (measurable)
- [ ] `LLM_PROVIDER` 기본 = `openai-codex`. 정적 `OPENAI_API_KEY` 주입 경로 제거.
- [ ] OAuth 자격(Codex `auth.json` 형식: refresh/access token)은 **Secret Manager**에서 옴
      (`<prefix>-openai-codex-oauth`), 이미지/리포에 평문 없음.
- [ ] `runtimes/start.ts`가 부팅 시 해당 시크릿을 런타임 auth profile 경로
      (ZeroClaw `~/.zeroclaw/...`, NullClaw `~/.codex/auth.json` + `auth login --import-codex`)로 **시드**한 뒤 agent 기동.
- [ ] 런타임이 self-refresh(ZeroClaw `auth refresh`, 또는 자체 갱신)로 만료 access token을 갱신.
- [ ] 자격 값은 로그/에러에 `***REDACTED***`. 시크릿은 state 볼륨(named, 호스트 미마운트)에만 기록, 이미지엔 없음.
- [ ] `config/validate.ts`: 양 런타임 **동일 provider(`openai-codex`)+model+wire** 검사(공정성 불변),
      정적 api_key 부재 검사.
- [ ] `scripts/preflight-live.ts`: `<prefix>-openai-codex-oauth` 존재 점검(gcloud/file 공통), `openai-api-key` 제거.
- [ ] 4대 정적 게이트 green + 신규/수정 단위 테스트.

## 비목표 (non-goals)
- Antigravity/Gemini OAuth (NullClaw 미지원 → 보류). ZeroClaw 전용 실험 레인도 이번 범위 아님.
- 대화형 OAuth 로그인 플로우 구현(refresh token은 운영자가 사전 발급해 Secret Manager 등록).
- GitHub/Discord 인증·머지 게이트·고위험 승인 변경.
- 런타임 업스트림 코드 수정(설정/auth profile 시드 경유로만 연동).

## 보안·공정성 영향 (조사 반영 — 수용한 트레이드오프)
- 런타임이 OAuth를 네이티브 관리하므로 **refresh token이 런타임 auth profile(state 볼륨)에 상주**한다.
  - 완화: state 볼륨은 named volume(호스트 미마운트), 루트FS read-only, 시크릿은 Secret Manager 주입(이미지 미포함), 로그 redact.
  - 정적 API key보다 회전 가능·범위 한정(구독 OAuth)이라 노출 위험은 감소.
- 공정성 불변: 비교 1회 = 동일 provider(`openai-codex`)+model+wire+autonomy+5역할.

## 리스크
- ZeroClaw/NullClaw의 auth profile 파일 포맷 상세(특히 ZeroClaw 비-Codex 경로)는 구현 중 확정.
  NullClaw는 `--import-codex`(`~/.codex/auth.json`)로 명확. ZeroClaw는 `auth refresh`+profile 경로 확인 필요.

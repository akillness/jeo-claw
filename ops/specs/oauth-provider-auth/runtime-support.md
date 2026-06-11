<!-- task #0 — 런타임 OAuth/Antigravity 지원 사전 확인 (read-only 조사 결과) -->
<!-- Generated: 2026-06-08 -->

# 런타임 OAuth 지원 조사 결과 (task #0)

빌드된 이미지의 실제 바이너리 + 업스트림으로 확인. **결론: 설계 분기 + 재승인 필요.**

## 증거 (바이너리 help)

### ZeroClaw (Rust, v0.7.5)
- `zeroclaw auth`: `login`(**OAuth: OpenAI Codex 또는 Gemini**), `paste-redirect`(리다이렉트/코드 붙여넣기로 완료),
  **`refresh`(refresh token으로 OpenAI Codex access token 갱신)**, `use`, `list`, `status`(만료 표시).
- `zeroclaw providers`(66개): `openai-codex` = "OpenAI Codex (OAuth)", `gemini` = "Google Gemini"(alias google).
- → **GPT(ChatGPT/Codex)·Gemini(Google) OAuth 모두 네이티브 지원.**

### NullClaw (Zig)
- `nullclaw auth login <provider>` 지원 provider: **`openai-codex`(ChatGPT Plus/Pro OAuth), `weixin`(WeChat QR)뿐.**
  - `login openai-codex --import-codex` → `~/.codex/auth.json`에서 가져오기 지원.
- **Gemini/Google OAuth 미지원.**

## 핵심 결론

| Provider | ZeroClaw | NullClaw | A/B(양쪽 동일 OAuth) |
|----------|----------|----------|----------------------|
| **GPT (openai-codex, ChatGPT OAuth)** | ✅ | ✅ | **가능** |
| **Antigravity (gemini, Google OAuth)** | ✅ | ❌ | **불가** (NullClaw 미지원) |

## 설계 영향 (기존 plan 대비 변경점)

1. **GPT OAuth**: 양 런타임 모두 `openai-codex` OAuth 지원 → A/B 공정성 유지하며 즉시 진행 가능.
2. **Antigravity OAuth**: NullClaw가 Gemini OAuth를 지원하지 않아 **"양 런타임 동일 provider OAuth" 불가**.
   공정성 불변(결정 2)과 충돌 → 별도 결정 필요.
3. **주입 메커니즘**: 두 런타임이 OAuth를 **네이티브로 자체 관리**(auth profile + self-refresh).
   → 당초 "glue가 access token 브로커" 방식보다, **Secret Manager의 refresh token으로 런타임
   auth profile(Codex `auth.json` 형식)을 부팅 시 시드 + 런타임 self-refresh**가 자연스럽고 변경 최소.
   (런타임은 refresh token을 자체 state 볼륨 `/.zeroclaw`·`/.config/nullclaw`에 보유 → 단기 access token 미보유 목표는
   재검토: refresh token이 런타임에 상주. 대안: state 볼륨을 tmpfs/암호화, 또는 access token만 주입하는 프록시.)

## 권고
- **GPT(openai-codex) OAuth를 1차 범위로 확정·진행** (양 런타임, 공정성 유지).
- **Antigravity는 보류 또는 ZeroClaw 전용 실험 레인**으로 분리 (NullClaw Gemini OAuth 지원 시 재개).
- 메커니즘은 **네이티브 auth profile 시드 + self-refresh**로 전환(브로커 폐기) 권고.

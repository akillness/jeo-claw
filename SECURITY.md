# jeo-claw 보안 기준 (2026 claw 보안 적용 가이드 종합)

본 문서는 "2026 claw 보안적용가이드"가 단일 공식 문서가 아님을 전제로, **ZeroClaw**와 **NullClaw**의 공개 보안 정책(SECURITY.md, 샌드박스, tool receipts, autonomy, `SECURITY-PATCH-PLAN-2026-05-10.md`)을 종합한 하드닝 기준이다. 10개 runtime-role 서비스와 split control plane이 자격증명을 공유·운영하는 환경의 위험을 통제한다.

## 1. 격리 (Isolation)
- 어떤 컨테이너에도 **호스트 Docker 소켓을 마운트하지 않는다** (컨테이너 탈출 → 호스트 장악 방지).
- claw 런타임은 `internal: true` 네트워크에만 연결 → 인터넷 직접 경로 없음.
- `cap_drop: ALL`, `no-new-privileges`, 읽기전용 루트FS + tmpfs(휘발 스크래치).
- role별 state/worktree 볼륨을 분리하고, control plane은 runtime state/worktree/role secret을 마운트하지 않는다.

## 2. Egress allowlist
- 모든 외부 통신은 `egress-proxy`(squid) allowlist를 통과해야 한다.
- 허용 도메인: GitHub, OpenAI(api.openai.com), gcloud Secret Manager(googleapis.com), Discord. 그 외 전부 차단.

## 3. 비밀 관리 (Secrets)
- 모든 비밀은 **gcloud Secret Manager**에서 런타임에 주입. 코드/이미지/리포에 평문 토큰 금지.
- **역할별 최소권한**(`secrets/loader.ts`):
  | 역할 | OpenAI | GitHub | 기타 |
  |------|--------|--------|------|
  | researcher-coder | read | read-only | — |
  | reviewer | read | read-only | — |
  | pr-creator | read | **write** | — |
  | pr-review-scheduler | read | read-only | — |
  | merger | read | **write** | — |
  | glue-webhook(control) | — | — | webhook-secret |
  | discord-bot(control) | — | — | discord-bot-token |
- 로그·에러 메시지에서 비밀값 **리댁션**(`redact()`); 누락/빈 비밀은 하드 실패.

## 4. 자율성 & 승인 게이트 (Autonomy)
- 두 런타임 모두 `autonomy = supervised` (중위험 승인, 고위험 차단).
- 고위험 액션(`pr.create`, `git.push`, `git.merge`, `pr.merge`)은 workflow 단위가 아니라 action-scoped single-use **Discord 승인 필수**. glue 머지 게이트가 CI 통과 AND 머지역할 검수 AND `git.merge`/`pr.merge` 승인을 모두 강제한다.

## 5. 무결성 (Integrity)
- ZeroClaw tool receipts(모든 액션 암호화 영수증)를 활성화해 감사 추적.
- GitHub 웹훅은 `GITHUB_WEBHOOK_SECRET` HMAC 서명 검증(`glue/`)으로만 수락.

## 6. 운영 (Operations)
- 모든 장기 서비스 `restart: unless-stopped` (장애 자동 복구).
- 헬스체크로 비정상 컨테이너 감지.

## 7. 취약점 신고
- 공개 이슈로 보안 취약점을 올리지 않는다. 비공개 채널로 신고(업스트림 SECURITY.md 정책 준용).

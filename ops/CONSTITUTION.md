<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-06-08 -->

# jeo-claw 운영 헌법 (CONSTITUTION)

spec-kit의 `/speckit.constitution` 역할. **모든 claw 작업의 최상위 불가침 원칙.**
하위 산출물(spec / plan / tasks / implement / verify)은 이 문서를 반드시 honor한다.
원칙이 바뀌면 **여기를 먼저 고치고**, 그 다음 워크플로우·규칙을 맞춘다.

## I. 안전 우선 (Security is non-negotiable)

`SECURITY.md` + 루트 `AGENTS.md`의 2026 claw 보안 기준은 어떤 작업도 약화시킬 수 없다.

- 호스트 Docker 소켓 마운트 금지. claw 런타임은 `internal: true` 네트워크 전용.
- 모든 egress는 squid allowlist 프록시(GitHub/OpenAI/gcloud Secret/Discord)만 통과.
- 고위험 액션(`pr.create` · `pr.merge`)은 **Discord action-scoped single-use 승인** 없이는 차단.
- 머지 게이트는 `ciPassed && reviewPassed && discordApproved`가 **모두 boolean `true`**(엄격 `=== true`)일 때만 허용. truthy 우회는 회귀 테스트로 막는다.
- 비밀은 gcloud Secret Manager에서 역할별 최소권한 주입. 평문 토큰을 이미지/리포/로그에 남기지 않는다(`***REDACTED***`).

> 보안과 충돌하는 어떤 편의·속도·자동화도 채택하지 않는다.

## II. spec-우선 (Spec drives code)

코드보다 명세가 먼저다. 모든 비자명 작업은 `ops/WORKFLOW.md`의 파이프라인을 통과한다:
요청 → specify → (clarify) → plan → tasks → (analyze) → implement → verify → **지식적재** → 진화.
명세 없이 product source를 바꾸지 않는다. 명세는 `ops/specs/`에, 계획은 `ops/plans/`에 남긴다.

## III. 검증 없는 완료 없음 (No claim without proof)

작업 완료 선언 전, jeo-claw의 4대 정적 게이트를 통과해야 한다(Docker 불필요). glue/runtime/control-plane 동작을 바꾼 경우 `smoke:glue`까지, 라이브 운영 경로를 바꾼 경우 `preflight:live`까지 통과해야 한다:

```bash
bunx tsc --noEmit            # strict 타입 (0 errors)
bun test                     # 전체 단위/통합/레드팀 (0 fail)
bun run check:compose        # docker-compose 정적 보안
bun run config/validate.ts   # A/B 공정성 + 런타임 config
bun run smoke:glue              # glue/runtime/control-plane 동작 변경 시 필수
bun run preflight:live      # 라이브 Secret Manager/Discord 경로 변경 시 필수
```

부분 완성을 완성으로 보고하지 않는다. 테스트/경고를 끄지 않는다. 관측하지 않은 결과를 지어내지 않는다.

## IV. A/B 공정성 (Fairness is structural)

ZeroClaw·NullClaw는 동일 LLM(`openai`/`gpt-5-codex`) · `autonomy=supervised` · 정확히 5개 역할 · 평문 비밀 없음으로만 비교된다. 한쪽을 유리하게 만드는 설정 변경은 금지. `config/validate.ts`가 이를 강제한다.

## V. 학습·진화 (Every task makes claw smarter)

작업은 결과물로 끝나지 않는다. 모든 완료 작업은 **지식적재 단계**(graphify 그래프 + obsidian vault + llm-wiki)를 거쳐 다음 작업이 참조·검색할 수 있는 자산이 된다(§ `ops/WORKFLOW.md` 8단계). 같은 실수·같은 조사를 두 번 하지 않는 것이 진화의 정의다.

## VI. 토큰 절약 (Token discipline)

모든 셸/조사 출력은 rtk로 압축한다(§ `ops/toolchain/rtk.md`). 큰 원문을 프롬프트에 통째로 붓지 않는다. vault는 `GRAPH_REPORT.md`/`index.md`를 raw보다 먼저 읽는다.

## VII. 사람이 통제권 (Human-in-command via Discord)

claw는 supervised다. 고위험·되돌릴 수 없는 액션은 Discord 승인을 거친다. 사용자 의도가 명확하면 행동하되, 파괴적 단계는 승인 게이트에서 멈춘다.

## 개정 절차

이 헌법의 변경은 그 자체로 하나의 작업이다 — WORKFLOW를 따르고, 변경 사유를 `ops/vault/log.md`에 적재한다. 버전/날짜 헤더를 갱신한다.

<!-- MANUAL: 운영자가 추가하는 불가침 원칙은 이 줄 아래에 보존된다 -->

<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-06-08 -->

# 운영 규칙 마스터 (RULES)

6개 스킬(spec-kit · rtk · graphify · obsidian · llm-wiki · deepinit)을 jeo-claw의
**하나의 자기진화 운영체계**로 묶는 통합 규칙. claw가 Discord로 안정 운영되고,
사용자 요청·작업을 통해 학습·발전하도록 만드는 doctrine의 진입점.

> 읽는 순서: 이 문서 → `CONSTITUTION.md`(불가침) → `WORKFLOW.md`(절차) → `toolchain/*`(도구).

## 0. 한 장으로 보는 진화 루프

```
        ┌────────────────────────────────────────────────────────────┐
        │                      claw EVOLUTION LOOP                     │
        │                                                              │
 Discord 요청 ─▶ [spec-kit 워크플로우] ─▶ 검증된 결과물 ─▶ [graphify 지식적재] │
        ▲                  │ rtk(토큰압축, 전 구간)              │        │
        │                  ▼                                    ▼        │
        │            [obsidian vault 파일/폴더 관리] ◀── [llm-wiki 적재·검색] │
        │                  │                                    │        │
        └──────── 다음 요청은 vault를 먼저 검색(EVOLVE) ◀────────┘        │
                                                                         │
        규칙 승격: 반복 패턴 → RULES.md / CONSTITUTION.md (claw 자체 발전) │
        └────────────────────────────────────────────────────────────┘
```

## 1. 역할 분담 (어떤 도구가 무엇을)

| 스킬 | 이 시스템에서의 역할 | 산출물/위치 | 상세 |
|------|----------------------|-------------|------|
| **spec-kit** | 모든 작업의 기본 워크플로우(계획→검증). 헌법·명세·계획·작업·구현·검증 파이프라인 | `ops/specs/`, `ops/plans/`, `ops/templates/` | `WORKFLOW.md` |
| **rtk** | 전 구간 셸/조사 출력 토큰압축 | hook/직접 `rtk` 명령 | `toolchain/rtk.md` |
| **graphify** | 완료 작업·코드·문서의 **지식적재**(관계 그래프) | `ops/vault/graphify-out/` | `toolchain/graphify.md` |
| **obsidian** | 적재 파일/폴더 관리·연결(vault, wikilink, frontmatter) | `ops/vault/` | `toolchain/obsidian.md` |
| **llm-wiki** | graphify 지식을 **참조·검색·진화**시키는 유지보수 계약 | `ops/vault/wiki/`, `index.md`, `log.md` | `toolchain/llm-wiki.md` |
| **deepinit** | 계층형 `AGENTS.md` 문서 자동 생성/갱신 | 각 디렉터리 `AGENTS.md` | 루트 `AGENTS.md` 규칙 |

## 2. 불변 규칙 (MUST)
## 2.1 Web Automation Rule 1. **Default Agent**: browser-harness 를 웹 자동화(Discord Dev Portal, 채널 모니터링 등)의 기본 에이전트로 사용한다. 2. **Verification**: 모든 웹 기반 작업은 캡처 이미지(MEDIA:...)와 DOM 상태 확인을 통해 실시간으로 검증한다. 3. **Endpoint**:    - Discord Dev Portal: https://discord.com/developers/applications    - Bot Home Channel: https://discord.com/channels/1483450880198971414/1483454454350221472

1. **모든 비자명 작업은 `WORKFLOW.md` 파이프라인을 통과한다.** 명세 없는 product source 변경 금지.
2. **검증 게이트 통과 전 완료 선언 금지** — `tsc --noEmit` · `bun test` · `check:compose` · `config/validate.ts`; glue/runtime/control-plane 동작 변경은 `smoke:glue`, 라이브 운영 경로 변경은 `preflight:live`도 필수.
3. **모든 완료 작업은 9단계 CAPTURE로 지식적재된다.** 적재 없는 작업은 미완으로 본다.
4. **다음 작업은 vault 검색으로 시작한다**(10단계 EVOLVE). 같은 조사·실수 반복 금지.
5. **보안·A/B 공정성은 약화 불가**(`CONSTITUTION.md` I·IV). 고위험 액션은 Discord 승인.
6. **모든 셸/조사 출력은 rtk로 압축**, vault는 `index.md`/`GRAPH_REPORT.md`를 raw보다 먼저 읽는다.
7. **`raw/`는 불변, `wiki/`는 LLM 소유.** 정정은 wiki 페이지/후속 노트로, raw 재작성 금지.
8. **반복되는 패턴/교훈은 규칙으로 승격**(`RULES.md`/`CONSTITUTION.md`) — 이것이 claw 자체 발전.

## 3. 권장 (SHOULD)

- 큰 다중파일 작업은 `executor` 서브에이전트로 슬라이스 위임, 통합·검증은 부모.
- 모호하면 `/clarify`로 멈추고 질문 — 계획이 모호함을 덮지 않게.
- 도구 미설치 시 정직하게 명시(설치 명령 제시), "설치됨"으로 가장 금지.
- vault는 강한 concept/entity 페이지 소수를 약한 파편 다수보다 우선.

## 4. Discord 운영 접점

| 명령 | 워크플로우 단계 | 비고 |
|------|------------------|------|
| `request <zeroclaw\|nullclaw> <요청>` | 0. INTAKE 트리거 | 새 워크플로우 시작 |
| `approve <workflowId> <action>` | 7. IMPLEMENT 고위험 게이트 | action-scoped, 1회용 |
| `reject <workflowId> <action>` | 7. IMPLEMENT 고위험 게이트 | 거부 |

`<action>` ∈ `pr.create` · `pr.merge`. A/B 대시보드는 `compare/` 메트릭을 Discord 임베드로 보고.

## 5. 안정성 규칙 (안정적인 claw)

- 모든 장기 서비스 `restart: unless-stopped`. claw 런타임 `cap_drop: ALL`+`no-new-privileges`+읽기전용 루트FS.
- 상태는 in-memory(`Map<workflowId, WorkflowState>`)이므로 재기동 시 휘발 — 진행 이력은 vault `log.md`로 영속화한다.
- 정적 게이트(`check:compose`)가 호스트 소켓 부재·네트워크 격리·재시작 정책·egress allowlist·평문 비밀 부재를 강제.

## 6. 규칙 개정

규칙 변경은 그 자체로 하나의 작업이다. WORKFLOW를 따르고, 변경 사유와 근거 작업을 `ops/vault/log.md`에 적재한 뒤 헤더 날짜를 갱신한다. 충돌 시 우선순위: `CONSTITUTION.md` > `RULES.md` > `WORKFLOW.md` > `toolchain/*`.

<!-- MANUAL: 운영자 규칙 메모는 이 줄 아래에 보존된다 -->

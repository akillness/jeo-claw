<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-06-08 -->

# 기본 워크플로우 (WORKFLOW)

spec-kit 파이프라인을 jeo-claw에 이식한 **모든 작업의 표준 절차**.
사용자 요청을 분석하는 순간부터 최종 결과물·지식적재·진화까지 한 사이클.

```
요청(Discord/user)
   │
0. INTAKE      요청 분석·정규화 → ops/specs/<slug>/request.md
   │
1. CONSTITUTION  ops/CONSTITUTION.md 로드 (불가침 원칙 확인)
   │
2. SPECIFY     요구·유저스토리·수용기준 → ops/specs/<slug>/spec.md   (templates/spec.md)
   │
3. CLARIFY?    모호도 높으면 질문으로 해소 (아래 모호도 점수)
   │
4. PLAN        기술 전략·아키텍처·영향범위 → ops/plans/<slug>/plan.md  (templates/plan.md)
   │
5. TASKS       실행 가능한 작업 분해 → ops/plans/<slug>/tasks.md       (templates/tasks.md)
   │
6. ANALYZE?    constitution↔spec↔plan 일관성 점검
   │
7. IMPLEMENT   task 단위 실행 (고위험은 Discord 승인 게이트)
   │
8. VERIFY      4대 정적 게이트 통과 (tsc/test/check:compose/validate) + checklist
   │
9. CAPTURE     지식적재: graphify 그래프 → vault(raw+wiki) → llm-wiki index/log 갱신
   │
10. EVOLVE     적재 지식을 다음 INTAKE의 참조 소스로 → claw 자체 개선 백로그
```

## 0. INTAKE — 요청 분석

- 입력원: Discord `request <runtime> <요청>` 또는 직접 사용자 요청.
- `ops/specs/<slug>/request.md`에 원문·맥락·런타임(zeroclaw|nullclaw|both)을 기록.
- **먼저 vault를 검색**(§9 산출물)해 동일/유사 작업이 이미 적재됐는지 확인 → 진화 루프의 시작.

## 1. CONSTITUTION — 원칙 로드

`ops/CONSTITUTION.md`를 읽고 이번 작업에 걸리는 불가침 항목(보안·공정성·검증)을 식별한다.

## 2. SPECIFY — 무엇을·왜

`templates/spec.md` 사용. 요구사항·유저스토리·수용기준(measurable)·비목표(non-goals)를 적는다. **어떻게(how)는 적지 않는다.**

## 3. CLARIFY — 모호도 게이트

다음 신호가 2개 이상이면 `/clarify` 인터뷰로 해소 후 진행:
- 수용기준이 측정 불가능
- 영향 파일/모듈이 불명확
- 보안·승인 정책에 닿는데 정책이 미정의
- 여러 해석이 결과를 크게 바꿈

## 4. PLAN — 어떻게

`templates/plan.md` 사용. 변경 모듈, `contract.ts` 타입 영향, 테스트 전략, 보안 영향, 롤백 경로. 고위험 액션이 포함되면 Discord 승인 지점을 명시.

## 5. TASKS — 분해

`templates/tasks.md` 사용. 각 task는 5–10단어, 단일 책임, 검증 가능. 의존 순서 표기. 대형 작업은 `executor` 서브에이전트로 슬라이스 위임 가능(통합·검증은 부모 책임).

## 6. ANALYZE — 일관성

constitution ↔ spec ↔ plan ↔ tasks가 서로 모순 없는지 점검. 보안 원칙을 우회하는 task가 없는지 확인.

## 7. IMPLEMENT — 실행

- jeo-claw 코드 컨벤션 준수: Bun, strict TS, `import type`, `.ts` 확장자 명시, 순수함수 코어, 팩토리 DI, 결과/가드 객체(예외 아님).
- 고위험 액션은 진행 전 Discord action-scoped 승인 소비.
- 정책 게이트 신규 코드는 strict `=== true` + 회귀 테스트 필수.

## 8. VERIFY — 증거

```bash
bunx tsc --noEmit
bun test
bun run check:compose
bun run config/validate.ts
```

`templates/checklist.md`로 품질 게이트를 채점. 통과 전 완료 선언 금지. 결과(green/red)를 `ops/specs/<slug>/`에 기록.

## 9. CAPTURE — 지식적재 (핵심 진화 단계)

완료 직후 실행 — 자세한 절차는 `ops/toolchain/{graphify,obsidian,llm-wiki}.md`:

```bash
bun run ops/scripts/capture-knowledge.ts \
  --title "<작업 제목>" \
  --slug "<slug>" \
  --summary "<무엇을·왜·결과>" \
  --tags "domain,security,glue" \
  --runtime both \
  --evidence "artifacts/verify-transcript.txt"
```

이 단계가 하는 일:
1. `ops/vault/raw/sources/<slug>.md` — 불변 원천 기록(요청·결정·증거 경로)
2. `ops/vault/wiki/sources/<slug>.md` — LLM 요약 페이지(stub)
3. `ops/vault/log.md` 시간순 1줄 추가, `ops/vault/index.md` 갱신
4. (선택) graphify로 `ops/vault/` 코퍼스 그래프 갱신 → 작업 간 관계 추적

## 10. EVOLVE — 되먹임

- 적재된 지식을 다음 작업 INTAKE의 첫 검색 대상으로 삼는다.
- 반복되는 패턴/실수는 `ops/RULES.md` 또는 `ops/CONSTITUTION.md`에 규칙으로 승격.
- claw 자체 개선 아이디어는 `ops/vault/wiki/reports/`의 개선 백로그로 적재 → 다음 사이클의 후보 요청.

<!-- MANUAL: 워크플로우 커스터마이즈 메모는 이 줄 아래에 보존된다 -->

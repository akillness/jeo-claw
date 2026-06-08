<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-06-08 -->

# ops — 운영·진화 엔진

## Purpose
jeo-claw의 **자기진화 운영체계**. spec-kit 워크플로우를 모든 작업의 기본 규칙으로 삼고,
rtk(토큰압축)·graphify(지식적재)·obsidian(파일/폴더 관리)·llm-wiki(참조·검색·진화)를
하나의 루프로 묶어 claw가 사용자 요청·작업을 통해 학습·발전하도록 한다.
product source가 아니라 **운영 doctrine + 지식 자산** 폴더다.

## Key Files
| File | Description |
|------|-------------|
| `RULES.md` | 통합 운영 규칙 마스터(진입점). 6개 스킬 역할 분담 + 진화 루프 |
| `CONSTITUTION.md` | 불가침 원칙(보안·spec우선·검증·공정성·진화·토큰·사람통제) |
| `WORKFLOW.md` | 요청→specify→plan→tasks→implement→verify→적재→진화 표준 절차 |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `toolchain/` | rtk·graphify·obsidian·llm-wiki 통합·사용 가이드 (see `toolchain/AGENTS.md`) |
| `templates/` | spec/plan/tasks/checklist 템플릿(spec-kit 파이프라인) |
| `specs/` | 작업별 요청·명세·검증 기록(작업 시 생성) |
| `plans/` | 작업별 계획·작업분해(작업 시 생성) |
| `vault/` | obsidian+llm-wiki 지식 베이스(raw 불변 / wiki LLM소유) (see `vault/AGENTS.md`) |
| `scripts/` | `capture-knowledge.ts` 지식적재 실행 스크립트 |

## For AI Agents

### Working In This Directory
- 새 작업은 `RULES.md` → `CONSTITUTION.md` → `WORKFLOW.md` 순으로 읽고 시작한다.
- 작업 시작 전 `vault/`를 검색해 기존 지식을 참조한다(중복 작업 방지).
- 완료 후 반드시 9단계 CAPTURE(`scripts/capture-knowledge.ts`)로 적재한다.
- 이 폴더의 doc은 한국어, 코드/명령은 영어. `<!-- MANUAL -->` 아래 운영자 메모는 보존.

### Testing Requirements
- `scripts/*.ts`는 jeo-claw strict TS를 따른다 → `bunx tsc --noEmit`, `bun test ops/scripts/`.

### Common Patterns
- 계층형 `AGENTS.md`(deepinit): 모든 하위 폴더는 `<!-- Parent: ../AGENTS.md -->` 태그.
- vault frontmatter + wikilink(obsidian) 규약은 `vault/AGENTS.md`.

## Dependencies

### Internal
- `../glue/contract.ts` — 워크플로우 단계/액션 타입의 단일 소스(작업 명세 시 참조)
- `../glue/merge-gate.ts`, `../discord/` — 고위험 승인 게이트(IMPLEMENT 단계 연결)

### External
- spec-kit `specify` CLI, `rtk`, `graphifyy`(graphify), Obsidian, llm-wiki 스킬 — `toolchain/*` 참조(설치는 각 도구 문서)

<!-- MANUAL: -->

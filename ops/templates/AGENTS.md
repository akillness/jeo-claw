<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-06-08 -->

# templates — spec-kit 파이프라인 템플릿

## Purpose
`WORKFLOW.md`의 각 단계에서 복사해 쓰는 산출물 템플릿. spec-kit의
constitution→specify→plan→tasks→implement→verify 파이프라인을 jeo-claw 작업 단위로 고정한다.

## Key Files
| File | 단계 | 복사 위치 |
|------|------|-----------|
| `request.md` | 0. INTAKE | `ops/specs/<slug>/request.md` |
| `spec.md` | 2. SPECIFY | `ops/specs/<slug>/spec.md` |
| `plan.md` | 4. PLAN | `ops/plans/<slug>/plan.md` |
| `tasks.md` | 5. TASKS | `ops/plans/<slug>/tasks.md` |
| `checklist.md` | 8. VERIFY | `ops/specs/<slug>/checklist.md` |

## For AI Agents
### Working In This Directory
- 템플릿은 빈 양식이다. 복사 후 `<…>` 자리표시자를 실제 내용으로 채운다.
- `<slug>`는 kebab-case 작업 식별자(예: `merge-gate-strict`). spec/plan/검증 기록이 같은 slug 공유.
- 템플릿 자체 수정은 규칙 변경에 준한다 → WORKFLOW를 따르고 `vault/log.md`에 사유 적재.

<!-- MANUAL: -->

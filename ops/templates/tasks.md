<!-- 5. TASKS — 복사처: ops/plans/<slug>/tasks.md -->
<!-- 각 task: 5–10단어, 단일 책임, 검증 가능, 의존 순서 표기. -->

# 작업 분해: <제목>

- **slug**: <slug>
- **연계 계획**: plan.md

| # | 작업 | 의존 | 검증 | 위임(executor?) |
|---|------|------|------|-----------------|
| 1 | <단일 책임 작업> | - | <어떻게 확인> | no |
| 2 | <…> | 1 | <…> | yes/no |

## ANALYZE 점검 (6단계)
- [ ] constitution ↔ spec ↔ plan ↔ tasks 모순 없음
- [ ] 보안 원칙을 우회하는 task 없음
- [ ] 고위험 task는 Discord 승인 지점이 명시됨

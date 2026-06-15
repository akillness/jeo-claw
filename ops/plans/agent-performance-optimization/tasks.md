<!-- 5. TASKS — 복사처: ops/plans/agent-performance-optimization/tasks.md -->
<!-- 각 task: 5–10단어, 단일 책임, 검증 가능, 의존 순서 표기. -->

# 작업 분해: 에이전트 성능평가 및 성능 최적화와 도커 자동 재빌드 적용

- **slug**: agent-performance-optimization
- **연계 계획**: plan.md

| # | 작업 | 의존 | 검증 | 위임(executor?) |
|---|------|------|------|-----------------|
| 1 | `compare/runner.ts`에 라이브 메트릭 수집 및 대시보드 출력 구현 | - | `bun run compare/runner.ts` 실행 결과 확인 | no |
| 2 | `scripts/docker-watch.ts` 파일 감시 및 도커 자동 재빌드 구현 | - | 스크립트 실행 후 파일 수정 시 도커 재빌드 확인 | no |
| 3 | `compare/runner.test.ts`에 메모리 누수 및 메트릭 수집 테스트 추가 | 1 | `bun test compare/runner.test.ts` 통과 확인 | no |
| 4 | 4대 정적 게이트 검증 및 지식 적재 | 1, 2, 3 | `bun test`, `check:compose`, `validate.ts` 통과 | no |

## ANALYZE 점검 (6단계)
- [x] constitution ↔ spec ↔ plan ↔ tasks 모순 없음
- [x] 보안 원칙을 우회하는 task 없음
- [x] 고위험 task는 Discord 승인 지점이 명시됨

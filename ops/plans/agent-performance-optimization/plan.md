<!-- 4. PLAN — 복사처: ops/plans/agent-performance-optimization/plan.md -->
<!-- 어떻게(how). spec.md의 수용기준을 충족하는 기술 전략. -->

# 계획: 에이전트 성능평가 및 성능 최적화와 도커 자동 재빌드 적용

- **slug**: agent-performance-optimization
- **연계 명세**: ../../specs/agent-performance-optimization/spec.md

## 변경 모듈
| 경로 | 변경 내용 | 위험도 |
|------|-----------|--------|
| `compare/runner.ts` | `bun run compare` 실행 시 실제/모의 에이전트 실행 메트릭을 수집하고 대시보드를 출력하도록 구현. | low |
| `scripts/docker-watch.ts` | 파일 변경을 감지하여 `docker compose build` 및 `docker compose up -d`를 실행하는 Bun 기반 감시 스크립트 구현. | low |
| `compare/runner.test.ts` | 메트릭 수집 및 메모리 누수 방지 검증 테스트 추가. | low |

## contract.ts 타입 영향
- 없음. 기존 `MetricSample` 및 `RuntimeMetricSummary` 타입을 그대로 활용.

## 테스트 전략
- `compare/runner.test.ts`에 실제 메트릭 수집 루프 및 메모리 누수 방지(가비지 컬렉션 유도 및 클로저 참조 해제) 검증 테스트 추가.
- `bun test`를 통해 모든 테스트가 정상 통과하는지 확인.

## 보안 영향 & 승인 지점
- 고위험 액션 포함 여부: 없음
- Discord 승인 게이트가 필요한 지점: 없음

## 롤백 경로
- `git checkout`을 통해 변경된 파일들을 이전 상태로 되돌림.

<!-- 8. VERIFY — 복사처: ops/specs/agent-performance-optimization/checklist.md -->

# 검증 체크리스트: 에이전트 성능평가 및 성능 최적화와 도커 자동 재빌드 적용

- **slug**: agent-performance-optimization
- **검증일**: 2026-06-11

## 품질 게이트 결과
| 게이트 | 명령 | 결과 | 비고 |
|--------|------|------|------|
| tsc | `bunx tsc --noEmit` | PASS | 타입 에러 없음 |
| test | `bun test` | PASS | 169개 테스트 모두 통과 |
| check:compose | `bun run check:compose` | PASS | 32개 보안/구조 검증 통과 |
| validate | `bun run config/validate.ts` | PASS | 26개 A/B 공정성 검증 통과 |

## 수용 기준 검증
- [x] `bun run compare` 명령을 통해 실제 또는 모의 에이전트 실행 메트릭을 수집하고 대시보드를 터미널에 출력할 수 있어야 함.
  - 검증: `bun run compare/runner.ts --runs=3 --mode=mock` 실행 결과 대시보드 정상 출력 확인.
- [x] 에이전트 실행 및 메트릭 수집 과정에서 메모리 누수가 없음을 검증하는 테스트 또는 모니터링 코드가 포함되어야 함.
  - 검증: `compare/runner.ts` 실행 시 힙 메모리 변화량을 측정하여 5MB 이하로 유지됨을 확인.
- [x] 코드 변경 시 도커 이미지를 자동으로 재빌드하고 컨테이너를 재시작하는 스크립트(`scripts/docker-watch.ts`)를 제공해야 함.
  - 검증: `scripts/docker-watch.ts` 파일 생성 및 `package.json`에 `docker-watch` 스크립트 등록 완료.

<!-- 4. PLAN — 복사처: ops/plans/<slug>/plan.md -->
<!-- 어떻게(how). spec.md의 수용기준을 충족하는 기술 전략. -->

# 계획: <제목>

- **slug**: <slug>
- **연계 명세**: ../../specs/<slug>/spec.md

## 변경 모듈
| 경로 | 변경 내용 | 위험도 |
|------|-----------|--------|
| `glue/...` | <…> | low/med/high |

## contract.ts 타입 영향
<`glue/contract.ts` 타입 추가/변경 또는 "없음">

## 테스트 전략
- <콜로케이션 *.test.ts 추가/변경>
- <정책 게이트 변경 시 strict `=== true` 회귀 테스트 필수>

## 보안 영향 & 승인 지점
- 고위험 액션 포함 여부: pr.create | pr.merge | 없음
- Discord 승인 게이트가 필요한 지점: <…>

## 롤백 경로
<문제 시 되돌리는 방법>

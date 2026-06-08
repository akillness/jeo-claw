<!-- 8. VERIFY — 복사처: ops/specs/<slug>/checklist.md -->

# 검증 체크리스트: <제목>

- **slug**: <slug>
- **검증일**: <YYYY-MM-DD>

## 4대 정적 게이트 (Docker 불필요)
- [ ] `bunx tsc --noEmit` — 0 errors
- [ ] `bun test` — 0 fail (현재 기준: 108+ pass)
- [ ] `bun run check:compose` — 전체 pass
- [ ] `bun run config/validate.ts` — A/B 공정성·config 통과

## 수용 기준 (spec.md에서 복사)
- [ ] <기준 1>
- [ ] <기준 2>

## 헌법 준수
- [ ] 보안 기준 약화 없음(I)
- [ ] spec-우선 절차 준수(II)
- [ ] 관측한 결과만 보고(III) — 결과 green/red 기록
- [ ] A/B 공정성 유지(IV)
- [ ] 정책 게이트 신규 코드는 strict `=== true` + 회귀 테스트

## 결과
- green/red: <…>
- 증거 경로: <transcript/artifact 경로>

## CAPTURE 예약 (9단계)
- [ ] `bun run ops/scripts/capture-knowledge.ts --title "…" --slug "<slug>" --summary "…" --tags "…"`

# PLAN: claw-improvement-2026

## 기술 전략 (Technical Strategy)
1. **현황 분석**: `config/`, `glue/`, `discord/`, `ops/` 디렉터리의 설정 및 코드를 분석하여 현재 작업 플로우 파악.
2. **개선안 도출**: 2026년 보안 기준(SECURITY.md)과 운영 헌법(CONSTITUTION.md)을 바탕으로 병목 현상, 보안 강화 포인트, A/B 비교 효율성 개선안 도출.
3. **신규 기능 기획**: Discord 제어 평면 고도화, 지식 적재(graphify/llm-wiki) 자동화 강화 등 제안.
4. **프로세스 정립**: claw 자체 진화 루프(EVOLVE)를 강화하는 작업 방식 개선 프로세스 문서화.
5. **문서화**: 도출된 내용을 종합하여 `ops/vault/wiki/reports/claw-improvement-2026.md`에 백로그 형태로 작성.

## 영향 범위 (Impact)
- `ops/vault/wiki/reports/claw-improvement-2026.md` (신규 생성)
- `ops/vault/index.md` (링크 추가)

## 보안 영향 (Security Impact)
- 실제 코드 변경이 없으므로 직접적인 보안 영향은 없음.
- 제안되는 개선안은 모두 `SECURITY.md`의 격리, 최소 권한, 승인 게이트 원칙을 준수해야 함.

## 롤백 경로 (Rollback)
- 생성된 보고서 파일 삭제 및 `index.md` 링크 제거.

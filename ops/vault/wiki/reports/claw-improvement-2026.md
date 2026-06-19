---
title: 2026 ZeroClaw & NullClaw Improvement Plan
type: report
updated: 2026-06-10
---

# 2026 ZeroClaw & NullClaw 개선 및 진화 방향 (Improvement Plan)

## 1. 현황 분석 (Current State)
- **A/B 비교 체계**: ZeroClaw(Rust)와 NullClaw(Zig)가 동일한 LLM(`gpt-5-codex`)과 자율성(`supervised`) 하에서 경쟁하며, `config/validate.ts`를 통해 공정성이 강제됨.
- **보안 및 제어**: `SECURITY.md`에 명시된 2026 보안 기준에 따라, 모든 고위험 액션(`pr.create`, `pr.merge`)은 Discord 승인 게이트를 거치며, 평문 비밀번호 없이 gcloud Secret Manager를 통해 최소 권한으로 주입됨.
- **운영 및 진화**: `ops/WORKFLOW.md`의 spec-kit 파이프라인과 지식 적재(graphify, obsidian, llm-wiki) 루프를 통해 자체 진화(EVOLVE) 체계를 갖춤.

## 2. 개선안 및 신규 기능 제안 (Improvements & New Features)

### A. 작업 플로우 및 A/B 비교 고도화
1. **동적 메트릭 수집 강화**: `compare/metrics.ts`를 확장하여, 각 런타임의 토큰 사용량, API 응답 시간, PR 리뷰 통과율 등 세부 지표를 실시간으로 수집하고 Discord 대시보드에 시각화.
2. **자동화된 회고 (Automated Retrospective)**: 각 워크플로우 완료 시, 두 런타임의 산출물을 비교 분석하는 자동 회고 에이전트(Critic 역할) 도입. 차이점과 개선점을 `wiki/reports/`에 자동 적재.

### B. 보안 및 제어 평면 (Control Plane) 강화
1. **세분화된 승인 게이트**: 현재의 이분법적(고위험/저위험) 승인에서 벗어나, 변경되는 파일의 민감도(예: `SECURITY.md` 또는 `glue/` 디렉터리 변경)에 따른 동적 위험도 평가 및 다중 승인(Multi-sig) 도입.
2. **비밀 관리 감사 (Secret Audit)**: 런타임 실행 중 비밀 접근 이력을 로깅하고, 비정상적인 접근 패턴을 탐지하는 감사 모듈 추가.

### C. 지식 적재 및 진화 루프 (Evolution Loop) 개선
1. **Graphify 자동화**: `capture-knowledge.ts` 실행 시, 변경된 코드의 AST(Abstract Syntax Tree)를 분석하여 graphify 노드에 코드 레벨의 의존성 정보를 자동으로 추가.
2. **LLM-Wiki 컨텍스트 주입**: INTAKE 단계에서 vault 검색 시, 단순 키워드 매칭을 넘어 벡터 검색(Vector Search)을 도입하여 과거의 유사한 작업 맥락을 프롬프트에 더 정확하게 주입.

## 3. 작업 방식 개선 프로세스 (Process Optimization)

1. **Pre-flight 시뮬레이션**: IMPLEMENT 단계 전, 제안된 코드 변경사항이 기존 테스트 및 정적 분석을 통과할지 예측하는 경량 샌드박스 시뮬레이션 도입.
2. **Subagent 병렬화 최적화**: 대규모 리팩토링 작업 시, `executor` 서브에이전트의 작업 분할(Task Slicing) 알고리즘을 개선하여 의존성이 없는 작업을 완벽히 병렬 처리.
3. **지속적 피드백 루프**: Discord 승인/거절 사유를 구조화된 데이터로 수집하여, 다음 작업 계획(PLAN) 수립 시 LLM의 프롬프트에 반영(Few-shot learning).

## 4. 다음 단계 (Next Steps)
- 본 백로그의 항목들을 개별 spec-kit 워크플로우(`ops/specs/`)로 분리하여 순차적으로 구현.
- 우선순위 1: 동적 메트릭 수집 강화 및 Discord 대시보드 연동.

<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-06-08 -->

# llm-wiki — 참조·검색·진화 유지보수 계약

`WORKFLOW.md 9-CAPTURE·10-EVOLVE` / `CONSTITUTION.md V` / `RULES.md §1`.
graphify가 만든 지식 구조를 **LLM이 유지보수하는 살아있는 markdown 계약**으로 운영한다.
이 문서가 "어떻게 적재 지식을 참조·검색하고, 다음 작업에서 진화시키는가"의 규칙이다.

## 운영 계약 (이 vault의 헌법)

1. `ops/vault/raw/`는 source of truth이며 **불변**.
2. `ops/vault/wiki/` + `index.md` + `log.md`는 **LLM 소유 작업 산출물**.
3. **모든 적재**는 source 요약·관련 종합 페이지·`index.md`·`log.md`를 갱신한다.
4. **모든 재사용 가치 답변**은 `wiki/queries/`(질문형) 또는 `wiki/reports/`(지속 산출물)로 환원.
5. **lint 패스**는 깨진 링크·고아 페이지·낡은 주장·모순·누락 종합 페이지 후보를 찾는다.

## 적재 (CAPTURE) — 1소스씩

`scripts/capture-knowledge.ts`가 한 작업당:

1. `raw/sources/<slug>.md` 불변 원천 기록(요청·결정·증거 경로)
2. `wiki/sources/<slug>.md` LLM 요약 stub 생성(이미 있으면 보존)
3. `log.md`에 시간순 1줄 append, `index.md`에 링크 추가(없을 때만)

워크플로우가 안정되기 전엔 **한 번에 한 소스만** 적재해 vault 변화를 검수한다.

## 참조·검색 (다음 작업의 INTAKE 시작점)

```
1. index.md 읽기 (가장 단순·강력한 검색 레이어)
2. 관련 wiki/ 페이지 열기 (concept/entity 우선)
3. graphify GRAPH_REPORT.md로 "이 작업이 무엇과 얽히는지" 확인
4. 필요할 때만 raw/로 내려가 grounding/모순 해소
5. 페이지 경로와 raw 경로를 명시해 인용
```

검색 도구 순서: `index.md` → `search`(정규식) → `graphify query`/`path`(관계).
큰 `graph.json`을 프롬프트에 통째로 붓지 않는다(`GRAPH_REPORT.md` 우선).

## 진화 (EVOLVE) — 되먹임 규칙

- 좋은 답변은 반드시 vault로 환원한다. "한 번 중요했던 답은 다시 중요하다."
- 강한 concept/entity 페이지로 **종합** > 약한 파편 양산. 자주 참조되는 아이디어는 별도 페이지로 승격.
- 낡은 주장은 새 소스로 갱신하되, raw는 건드리지 않고 wiki에서 정정/대체.
- **반복 패턴/교훈은 규칙으로 승격**: `ops/RULES.md` 또는 `ops/CONSTITUTION.md`(= claw 자체 발전).
- **실행 가능한 패턴은 스킬로 증류**: 도구 사용법이나 복잡한 작업 절차는 `ops/templates/skill.md`를 사용해 `wiki/skills/`에 스킬 문서로 작성하여 에이전트가 쉽게 재사용할 수 있게 한다.
- claw 개선 아이디어는 `wiki/reports/`의 개선 백로그 → 다음 사이클 후보 요청.

## lint 패스 (주기적 건전성)

구조 점검(진실성 아님): 필수 파일·디렉터리 존재, 깨진 wikilink, 고아 페이지.
출력은 사람 주도 정리의 시작점:

- 중복 concept 병합
- 자주 참조되는 아이디어를 독립 페이지로 승격
- 새 소스로 대체된 낡은 주장 폐기
- 그래프가 성긴 곳에 backlink/요약 페이지 추가

## 스케일링 (필요해질 때만)

`index.md` + `log.md`로 충분한 규모를 넘어서면: graphify 증분 갱신 상시화 → 검색 보조 도구 →
Dataview frontmatter 질의 순으로 도입. 임베딩/MCP를 1일차에 강제하지 않는다.

<!-- MANUAL: -->

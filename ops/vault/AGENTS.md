<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-06-08 -->

# vault — 지식 베이스 (obsidian + llm-wiki)

## Purpose
claw가 작업으로 학습한 지식의 영속 저장소. graphify 그래프 + obsidian 파일관리 +
llm-wiki 유지보수 계약이 합쳐지는 곳. **다음 작업의 INTAKE는 항상 여기 검색으로 시작한다.**

## 진입점 (읽기 순서 — 토큰 절약)
1. `index.md` — navigational primitive (항상 먼저)
2. `wiki/` concept/entity 페이지
3. `graphify-out/GRAPH_REPORT.md` — 관계 그래프
4. 필요 시 `raw/` grounding

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `raw/sources/` | **불변** 원천 기록(요청·결정·증거). 재작성 금지 |
| `raw/assets/` | 캡처 이미지/첨부 |
| `wiki/sources/` | raw 1:1 LLM 요약 페이지 |
| `wiki/entities/` | 지속 개체(런타임·모듈·역할) 페이지 |
| `wiki/concepts/` | 지속 개념(머지게이트·승인·A/B공정성) 페이지 |
| `wiki/queries/` | 재사용 가치 있는 질의 답변 |
| `wiki/skills/` | UpSkill 포맷으로 증류된 실행 가능한 스킬 문서 |
| `wiki/reports/` | claw 자체 개선 백로그·비교·메모 |
| `graphify-out/` | graphify 산출(작업 후 생성) |

## For AI Agents
### Working In This Directory
- **`raw/`는 불변, `wiki/`는 LLM 소유**(CONSTITUTION V). 정정은 wiki에서.
- 적재는 손으로 만들지 말고 `../scripts/capture-knowledge.ts`로 수행(index/log 자동 갱신).
- 모든 페이지는 `obsidian.md`의 frontmatter + wikilink 규약을 따른다.
- lint/유지보수 규칙은 `../toolchain/llm-wiki.md`.

<!-- MANUAL: -->

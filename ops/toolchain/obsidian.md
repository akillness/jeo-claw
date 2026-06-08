<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-06-08 -->

# obsidian — vault 파일/폴더 관리

`WORKFLOW.md 9-CAPTURE` / `RULES.md §1·§2-7`. 적재된 지식을 **사람·LLM이 함께 읽는
markdown vault**로 구조화한다. graphify가 만든 관계 그래프와 llm-wiki의 참조·검색을
담는 물리적 저장소가 `ops/vault/`이며, 그 폴더 규약을 정의한다.

## vault 레이아웃

```
ops/vault/
├── index.md              # 진입점. 항상 먼저 읽는 navigational primitive
├── log.md                # 시간순 1줄 적재 이력(append-only)
├── raw/
│   ├── sources/<slug>.md # 불변 원천(요청·결정·증거 경로). 재작성 금지
│   └── assets/           # 캡처 이미지/첨부
├── wiki/
│   ├── sources/<slug>.md # LLM 요약 페이지(raw 1:1 요약)
│   ├── entities/         # 지속 개체(런타임·모듈·역할 등) 페이지
│   ├── concepts/         # 지속 개념(머지게이트·승인·A/B공정성 등) 페이지
│   ├── queries/          # 재사용 가치 있는 질의 답변 적재
│   └── reports/          # claw 자체 개선 백로그·메모·비교 산출물
└── graphify-out/         # graphify 산출(GRAPH_REPORT.md / graph.html / graph.json)
```

## 불변 규칙 (CONSTITUTION V · RULES §2-7)

- **`raw/`는 불변**: 한 번 적재된 원천은 재작성하지 않는다. 정정은 `wiki/`에서 한다.
- **`wiki/`는 LLM 소유**: 요약·종합·정정의 작업 공간. capture는 stub만 만들고 클로버 금지.
- 새 적재는 항상 `index.md`·`log.md`를 함께 갱신(`scripts/capture-knowledge.ts`가 수행).

## frontmatter 규약

모든 vault 페이지는 YAML frontmatter로 시작한다(Dataview/검색 대비):

```markdown
---
title: 머지 게이트 strict 비교 회귀
slug: merge-gate-strict
type: source            # source | entity | concept | query | report
tags: [security, glue, merge-gate]
created: 2026-06-08
runtime: both           # zeroclaw | nullclaw | both | n/a
---
```

## wikilink 규약 (연결이 곧 진화)

- 다른 페이지 참조: `[[wiki/concepts/merge-gate]]`, 별칭 `[[wiki/concepts/merge-gate|머지 게이트]]`.
- 원천 인용: `[[raw/sources/merge-gate-strict]]` (증거로 backlink).
- 콜아웃으로 주의/결정 강조: `> [!WARNING] truthy 우회는 회귀 테스트로 차단`.
- 강한 concept/entity 페이지 소수를 약한 파편 다수보다 우선(RULES §3).

## 읽기 순서 (토큰 절약 — rtk.md 연계)

1. `index.md` → 2. 관련 `wiki/` 페이지 → 3. 필요 시 `raw/`로 grounding.
raw 원문 전체를 프롬프트에 붓지 않는다. 검색은 `search`/`graphify query`로.

## Obsidian 앱 연동(선택)

vault를 Obsidian 앱으로 열면 그래프 뷰·backlink·Bases 질의를 사람이 직접 쓸 수 있다.
CLI 자동화가 필요하면 `obsidian` 스킬의 `references/cli-automation.md` 참조(데스크톱 CLI 필요).

<!-- MANUAL: -->

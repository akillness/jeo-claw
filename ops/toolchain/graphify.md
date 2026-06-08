<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-06-08 -->

# graphify — 지식적재 (작업 관계 그래프)

`WORKFLOW.md 9-CAPTURE`. 완료된 작업·코드·문서를 **지속되는 관계 그래프**로 적재해,
이후 작업이 "무엇이 무엇과 연결되는가"를 추적·검색할 수 있게 한다. vault 코퍼스를 입력으로 삼는다.

## 설치 / 검증

```bash
pip install graphifyy          # PyPI 패키지명은 graphifyy, CLI는 graphify (Python 3.10+)
graphify --version
```

## 적재 모드 (1개만 선택)

| 모드 | 언제 |
|------|------|
| `local-python-build` | 환경에 따라 그래프를 직접 빌드 (기본) |
| `incremental-refresh` | 기존 그래프에 변경 범위만 갱신 |
| `graph-query-followup` | 기존 산출물에서 관계 질의 |
| `structural-fallback` | 마크다운 위주 코퍼스에서 의미추출이 0노드/오해소지일 때 구조 그래프 |

## jeo-claw 사용 (vault 코퍼스 대상)

```bash
# 작업 적재 후 vault 전체를 그래프로 (출력: ops/vault/graphify-out/)
graphify ops/vault --out ops/vault/graphify-out

# 변경분만 갱신
graphify ops/vault --out ops/vault/graphify-out --incremental
```

산출물 읽기 순서(토큰 절약): `graphify-out/GRAPH_REPORT.md` → `graph.html` → `graph.json`.
raw `graph.json`을 프롬프트에 통째로 붓지 않는다.

## 스코프 규칙

- 전체 리포 무차별 그래프 금지 → 대상은 **`ops/vault/`**(지식 코퍼스)로 한정.
- 코드 구조 파악이 목적이면 `glue/`·`discord/` 등 좁은 서브트리만.
- 단순 "심볼/참조 찾기"는 graphify가 아니라 `search`/`codebase-search`로.

## 진화 연결

graphify 그래프는 llm-wiki(`llm-wiki.md`)가 참조·검색하는 1차 구조 레이어다.
새 요청의 INTAKE에서 `GRAPH_REPORT.md`로 "이 작업이 무엇과 얽히는지"를 먼저 본다.

<!-- MANUAL: -->

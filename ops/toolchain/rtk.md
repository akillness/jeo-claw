<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-06-08 -->

# rtk — 토큰압축 (전 구간)

`CONSTITUTION.md VI` / `RULES.md §2-6`. claw의 모든 셸·조사 출력을 토큰 최적화 형태로
재작성해 LLM 비용·컨텍스트를 줄인다. A/B 비교의 `tokenCost` 지표에도 직접 기여.

## 설치 / 검증

```bash
# 검증 우선 — gain 이 동작하면 올바른 rtk
rtk gain                       # 실패 시 잘못된 패키지(Rust Type Kit 등) 의심

# 설치 (택1)
brew install rtk               # macOS
# 또는 fork install.sh / cargo (akillness/rtk fork)
```

> 주의: `cargo install rtk`는 이름 충돌(다른 패키지) 위험. `rtk gain` 동작으로 정품 확인.

## 에이전트 init

```bash
rtk init -g                    # claude/codex/gemini 등 hook-capable 에이전트 전역 설정
rtk init --show                # 설치/hook 상태 확인 (업그레이드 후 필수)
```

## 직접 명령 (hook 부재·built-in 도구 사용 시)

built-in Read/Grep/Glob은 셸 hook을 통과하지 않으므로, 토큰 절감이 중요할 땐 직접 호출:

```bash
rtk git status
rtk read glue/server.ts
rtk grep "evaluateMergeGate" .
rtk test bun test
rtk gain                       # 누적 절감량 확인
```

## jeo-claw 운영 규칙

- 큰 로그·diff·검색 결과를 프롬프트에 통째로 붓지 않는다 → `rtk`/요약 경유.
- 1회성 원문 확인이 필요하면 `RTK_DISABLED=1 <cmd>`로 bypass.
- vault 읽기는 `index.md`/`GRAPH_REPORT.md` 우선(§ `llm-wiki.md`), raw는 필요할 때만.
- 도구별 hook 타입/범위는 rtk 스킬 `references/platform-init.md` 참조.

<!-- MANUAL: -->

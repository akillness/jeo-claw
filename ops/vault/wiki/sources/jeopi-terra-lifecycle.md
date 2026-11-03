---
title: Jeopi, GPT-6.1 Terra & Lifecycle Hardening
slug: jeopi-terra-lifecycle
type: source-summary
tags: [jeopi, terra, lifecycle, security, cleanup, runtime]
created: 2026-11-04
runtime: both
---

# Jeopi, GPT-6.1 Terra & Lifecycle Hardening

> 원천: [[raw/sources/jeopi-terra-lifecycle]]

## 무엇을·왜·결과
- **코딩 에이전트 및 모델 전환**: 기존 `gjc` 호출 경로를 임시 세션(`--no-session`) 기반의 `jeopi` 실행으로 전환하고, 논리 기본 모델을 `openai` / `gpt-6.1-terra`(네이티브 OAuth 어댑터 `openai-codex`)로 일원화했습니다.
- **라이프사이클 및 보안 하드닝**: `glue/server.ts`, `discord/proxy-main.ts`, `hive/start.ts`, `runtimes/start.ts`, `claws/repo-work.ts`, `secrets/loader.ts` 전반의 스트림·프로세스 그룹·타이머·시크릿 조회 취소(AbortSignal) 및 우아한 종료(Graceful Shutdown) 처리를 강화하고 회귀 테스트를 추가했습니다.
- **저장소 루트 및 테스트 임시 폴더 정리**: `runtimes/start.test.ts`에서 `process.env.TEMP || process.cwd()` 폴백으로 인해 저장소 루트에 `jeo-runtime-*` 폴더가 남던 문제를 `mkdtempSync(join(tmpdir(), ...))` + `finally` 정리로 수정하고, 참조되지 않는 루트 임시 패치·테스트 스크립트 68개와 임시 폴더들을 제거했습니다.
- **`.gitignore` 정교화**: 숨김 런타임 상태(`.*`, `jeo-runtime-*/`)는 무시하되 `.gitignore`, `.dockerignore`, `.env.example`, `.github/`, `secrets/.gitkeep` 등 필수 추적 설정 파일은 항상 노출되도록 규칙을 정비했습니다.

## 연결 (wikilink)
- 관련 개념: [[wiki/concepts/oauth-seeding]], [[wiki/concepts/ab-parity]]
- 관련 개체: [[wiki/entities/nullclaw]], [[wiki/entities/secret-manager]]

## 후속 / 진화 후보
- 테스트 작성 시 임시 디렉터리는 항상 `os.tmpdir()` + `mkdtempSync` 및 `finally` 블록 정리를 표준 패턴으로 유지

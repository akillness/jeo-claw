---
title: OAuth Seeding
slug: oauth-seeding
type: concept
tags: [security, oauth, seeding]
created: 2026-06-11
---

# OAuth Seeding

## 정의
외부 비밀 저장소(예: Google Secret Manager)에 보관된 OAuth 을 런타임(ZeroClaw, NullClaw) 부팅 시점에 주입하여, 런타임이 별도의 브라우저 인증 과정 없이 즉시 인증 상태로 시작하게 하는 기술적 패턴입니다.

## 적용 이력
- [[wiki/sources/oauth-provider-auth]] (2026-06-10):  provider에 최초 적용.

## 보안 사항
- 은 런타임 메모리 및 지정된 명명된 볼륨(named volume)에만 상주하며, 이미지에는 포함되지 않아야 합니다.
- 로그 출력 시 반드시 Redact 처리가 필요합니다.

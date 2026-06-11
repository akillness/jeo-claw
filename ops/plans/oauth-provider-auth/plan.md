# 계획: OAuth 기반 provider 인증 (openai-codex)

- **slug**: oauth-provider-auth
- **명세**: 
- **헌법 항목**: I(보안), III(검증), IV(공정성)

## 1. 개요
Secret Manager의 refresh token을 사용하여 런타임(ZeroClaw/NullClaw)의 auth profile을 부팅 시 시드하고, 런타임 네이티브 self-refresh 기능을 활용해 인증을 유지한다.

## 2. 상세 작업 (TASK)

### [T1] 설정 및 검증 로직 수정
- [ ] :  검사 및  사용 금지 로직 추가.
- [ ] :  시크릿 존재 여부 확인 로직 추가.

### [T2] 런타임 부팅 로직 수정 (Seeding)
- [ ] : 
    - Secret Manager에서  (JSON 형태: refresh_token 등 포함) 로드.
    - ZeroClaw:  (포맷 확인 필요) 위치에 쓰기.
    - NullClaw:  위치에 쓰기.

### [T3] 비밀 관리 및 보안
- [ ] :  로더 제거 및  로더 추가.
- [ ] 로그 출력 시 OAuth 관련 토큰값  처리 확인.

### [T4] 검증 및 테스트
- [ ] : 신규 인증 로직 단위 테스트 수행.
- [ ] : 런타임 부팅 및 초기 인증 성공 확인.

## 3. 검증 게이트 (GATE)
- [ ]  (정적 타이핑)
- [ ]  (로직 검증)
- [ ]  (설정 검증)

const secret = "c4d5d2f7071751a543514a894acd70bfb3a538b234175edb5cec6278bfc2494c";
const body = JSON.stringify({
  type: "request",
  source: "discord",
  runtime: "zeroclaw",
  repo: "akillness/jeo-claw",
  request: `<@&1484796692632174605> [Ouroboros Evolution Cycle: Spec-Kit Driven Deep Refactoring]

단순 겉핥기식(README 등) 수정을 절대 금지하며, 'ooo (Ouroboros) 인터뷰' 피드백 궤적과 'spec-kit' 방법론을 적용하여 강도 높은 실제 성능 개선 코드 작업을 수행하라.

[핵심 행동 강령 및 요구사항]
1. Spec-Kit 기반 문제 정의 및 계획:
   - 작업 시작 전 프로젝트(glue, discord, claws 등)의 현재 구조와 SQLite 마이그레이션 이후의 잔여 병목 현상을 면밀히 스캔하라.
   - 예상되는 메모리 누수, Promise unhandled rejection, 타임아웃, 중복 알림 트리거 지점을 찾아내어 내부 Spec(또는 ROOT_CHECK.md)으로 명확히 정의(Plan)하라.

2. Ouroboros 딥 리팩토링 (실제 코드 타격):
   - 계획된 Spec에 맞춰 실제 코드를 뜯어고쳐라. 
   - 멱등성(Idempotency) 보장, 이벤트 디바운싱(Debouncing), 불필요한 상태 유지 철폐 등 극한의 성능 최적화 로직을 핵심 파일들에 구현하라.

3. 자가 진화 및 검증 (Self-Healing Loop):
   - 수정 후 반드시 모든 로컬 테스트를 구동하라. 
   - 실패 시 스스로 에러 로그를 인터뷰하듯 심층 분석(ooo feedback)하고, 원인을 완벽히 제거할 때까지 코드를 반복 재수정하라.

4. 우아한 파이프라인 마무리:
   - PR 생성 시, 이번 진화 사이클에서 개선된 성능 최적화 및 메모리 누수 차단 내역을 상세히 기록하라.
   - 오직 실제 승인이 필요한 시점(awaiting-approval)에만 디스코드 팝업이 발송되도록 보장하고, 병합 후 즉각적인 도커 재빌드로 환골탈태가 이루어지도록 시스템 정합성을 맞춰라.

5. [Ponytail 스킬 필수 준수사항 - 긴급 수정 요망]:
   - 브랜치(워크트리) 자동 청소: PR이 병합(Merge)되는 즉시 깃허브 원격 저장소에 남겨진 임시 파생 브랜치(예: workflow-wf-*)를 깃허브 API 등을 이용해 반드시 삭제(Cleanup)하는 로직을 오케스트레이터(glue/server.ts 또는 관련 모듈)에 추가하라.
   - Docker 강제 재빌드 (No-Cache): Auto-Rebuild(자동 재빌드) 로직 실행 시, Windows/WSL 환경의 캐시 오작동을 원천 차단하기 위해 반드시 \`docker compose build --no-cache && docker compose up -d\` 형태로 캐시 없이 하드 리빌드하도록 코드를 수정하라.`
});

fetch("http://127.0.0.1:8787/control-event", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-control-event-secret": secret
  },
  body
}).then(async r => {
  console.log(r.status, await r.text());
}).catch(console.error);
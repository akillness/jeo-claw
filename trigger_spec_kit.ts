import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const secret = "c4d5d2f7071751a543514a894acd70bfb3a538b234175edb5cec6278bfc2494c";
const counterFile = join(process.cwd(), "ops", "evolution_counter.txt");

// Ensure ops directory exists
if (!existsSync(join(process.cwd(), "ops"))) {
    mkdirSync(join(process.cwd(), "ops"), { recursive: true });
}

// Read and increment counter
let counter = 1;
if (existsSync(counterFile)) {
    try {
        counter = parseInt(readFileSync(counterFile, "utf8").trim(), 10) + 1;
    } catch (e) {
        counter = 1;
    }
}
writeFileSync(counterFile, counter.toString(), "utf8");

const isTenthCycle = (counter % 10 === 0);
console.log(`[Evolution Cycle] Current Run: ${counter} | Survey Mode: ${isTenthCycle}`);

let requestText = `<@&1484796692632174605> [Ouroboros Evolution Cycle: Spec-Kit Driven Deep Refactoring] (Cycle #${counter})

단순 겉핥기식(README 등) 수정을 절대 금지하며, 'ooo (Ouroboros) 인터뷰' 피드백 궤적과 'spec-kit' 방법론을 적용하여 실제 성능 개선 코드 작업을 수행하라.

[최우선 행동 강령 및 핵심 목표]
1. 워크플로우 강건성(Robustness) 및 엣지 케이스 방어
2. 메모리 최적화(Memory Optimization) 및 누수 방지
3. 속도 최적화(Speed Optimization) 및 불필요한 지연 철폐

[상세 요구사항]
1. Spec-Kit 기반 문제 정의 및 계획:
   - 시스템 전반(glue, discord, claws 등)의 병목 현상 및 동시성 이슈를 면밀히 스캔.
   - 예상되는 메모리 누수, unhandled rejection, 중복 실행 지점을 명확히 정의(Plan).

2. 딥 리팩토링 (실제 코드 타격):
   - 멱등성 보장, 이벤트 디바운싱 등 강도 높은 성능 최적화 적용.

3. 자가 진화 및 검증 (Self-Healing Loop):
   - 수정 후 로컬 테스트로 부작용 없는지 교차 검증. 실패 시 원인 분석(ooo feedback) 및 재수정.

4. 우아한 마무리:
   - 최적화 내역 상세 기록. PR 생성 및 병합 후 캐시 없는 도커 리빌드로 즉각 반영.
`;

if (isTenthCycle) {
    requestText += `\n\n[특별 지시사항: 10주기 정기 기술 서베이(Survey) 및 신기술 적용]
- 이번 주기는 10번째 진화 사이클입니다. 기존 리팩토링에 더해 **반드시 신규 개선 사항이나 적용 가능한 최신 기술/아키텍처 패턴이 있는지 survey** 하십시오.
- Survey 결과를 바탕으로 가장 효율적인(또는 안전한) 기술적 접근을 도출하고, 이를 실제 코드에 시험 적용(PoC)하여 시스템을 한 단계 도약시키십시오.`;
} else {
    requestText += `\n\n[참고] 현재는 일반 진화 사이클입니다. (10주기 Survey까지 ${10 - (counter % 10)}회 남음)`;
}

const body = JSON.stringify({
  type: "request",
  source: "discord",
  runtime: "zeroclaw",
  repo: "akillness/jeo-claw",
  request: requestText
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

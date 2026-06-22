import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const secret = "c4d5d2f7071751a543514a894acd70bfb3a538b234175edb5cec6278bfc2494c";
const counterFile = join(process.cwd(), "ops", "evolution_counter.txt");

if (!existsSync(join(process.cwd(), "ops"))) {
    mkdirSync(join(process.cwd(), "ops"), { recursive: true });
}

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
const isSkillsTarget = (counter % 2 === 0);

console.log(`[Evolution Cycle] Current Run: ${counter} | Survey Mode: ${isTenthCycle} | Target: ${isSkillsTarget ? 'jeo-skills' : 'jeo-claw'}`);

let targetRepo = "akillness/jeo-claw";
let requestText = "";

if (!isSkillsTarget) {
    targetRepo = "akillness/jeo-claw";
    requestText = `<@&1484796692632174605> [Ouroboros Evolution Cycle: Spec-Kit Driven Deep Refactoring] (Cycle #${counter})

단순 겉핥기식(README 등) 수정을 절대 금지하며, 'ooo (Ouroboros) 인터뷰' 피드백 궤적과 'spec-kit' 방법론을 적용하여 실제 성능 개선 코드 작업을 수행하라.

[최우선 행동 강령 및 핵심 목표]
1. 워크플로우 강건성(Robustness) 및 엣지 케이스 방어
2. 메모리 최적화(Memory Optimization) 및 누수 방지
3. 속도 최적화(Speed Optimization) 및 불필요한 지연 철폐

[상세 요구사항]
1. Spec-Kit 기반 문제 정의 및 계획:
   - 시스템 전반의 병목 현상 및 동시성 이슈를 면밀히 스캔.
2. 딥 리팩토링 (실제 코드 타격):
   - 멱등성 보장, 이벤트 디바운싱 등 강도 높은 성능 최적화 적용.
3. 자가 진화 및 검증 (Self-Healing Loop):
   - 수정 후 로컬 테스트 교차 검증. 실패 시 원인 분석 및 재수정.`;

    if (isTenthCycle) {
        requestText += `\n\n[특별 지시사항: 10주기 정기 기술 서베이(Survey) 및 신기술 적용]\n- 이번 주기는 10번째 진화 사이클입니다. 기존 리팩토링에 더해 **반드시 신규 개선 사항이나 적용 가능한 최신 기술/아키텍처 패턴이 있는지 survey** 하십시오.\n- Survey 결과를 바탕으로 가장 효율적인(또는 안전한) 기술적 접근을 도출하고, 이를 실제 코드에 시험 적용(PoC)하여 시스템을 한 단계 도약시키십시오.`;
    } else {
        requestText += `\n\n[참고] 현재는 일반 진화 사이클입니다. (10주기 Survey까지 ${10 - (counter % 10)}회 남음)`;
    }
} else {
    targetRepo = "akillness/jeo-skills";
    requestText = `<@&1484796692632174605> [Ouroboros Evolution Cycle: Agentic Skill Management and Validation] (Cycle #${counter})

이 작업은 스킬 자산 저장소(jeo-skills)의 무결성을 검증하고, 스킬 생태계를 자가 발전시키기 위한 특수 워크플로우입니다.

[최우선 행동 강령 및 핵심 목표]
1. 스킬 무결성 보장 (Quality Gate):
   - \`fix_frontmatter.py\` 스크립트를 반드시 실행하여 모든 SKILL.md 파일의 YAML Frontmatter 포맷 에러를 교정하라.
   - 마크다운 문법 오류나 깨진 링크, 잘못된 구조를 찾아 수정하라.
2. 스킬 플래트닝 자동화:
   - \`flatten_skills.py\` 스크립트를 실행하여 스킬 통합 파일(JSON/Markdown)의 최신화를 보장하라.
3. 스킬 가독성 최적화:
   - 각 스킬의 설명을 다듬고 중복된 내용을 병합하라.`;

    if (isTenthCycle) {
        requestText += `\n\n[특별 지시사항: 10주기 정기 스킬 수집 및 자가 창작(Scraping and Creation)]\n- 이번 주기는 10번째 진화 사이클입니다. 최신 Agentic Workflow 트렌드나 유용한 시스템 유틸리티 패턴을 스스로 Survey(조사)하십시오.\n- 조사한 지식을 바탕으로 **새로운 스킬 폴더를 생성하고 신규 SKILL.md 파일을 최소 1개 이상 새롭게 작성**하여 생태계를 확장시키십시오.`;
    } else {
        requestText += `\n\n[참고] 현재는 일반 스킬 검증 사이클입니다. (10주기 스킬 창작까지 ${10 - (counter % 10)}회 남음)`;
    }
}

const body = JSON.stringify({
  type: "request",
  source: "discord",
  runtime: "zeroclaw",
  repo: targetRepo,
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

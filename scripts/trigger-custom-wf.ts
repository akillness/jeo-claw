import { SQLiteWorkflowStore } from "../glue/store.ts";
import { createWorkflow } from "../glue/state-machine.ts";

async function run() {
    const store = new SQLiteWorkflowStore("workflows.sqlite");
    const timestamp = Date.now();
    const wfId = `wf-${timestamp}-${Math.floor(Math.random() * 1000)}`;
    
    // The prompt requested by the user
    const goal = "https://github.com/akillness/jeo-claw 프로젝트의 에이전트 성능평가를 통해 성능 개선방법을 논의하고 개선방향적용해보면서 성능이 개선된 코드로 발전시켜나가고 정교하고 빠르게, 메모리누수없는 성능 최적화를 병행하는게 중요해. 즉 스스로 진화하면서 발전되도록해야해. 현재 제로클로의 도커 프로젝트 시스템인데 업데이트되면 도커 재빌드를통해 바로 적용되도록 작업해";
    
    // The target repo based on the URL in the goal
    const repo = "jeo-claw";
    
    const wf = createWorkflow(wfId, "sc_jeo", goal);
    wf.repo = repo;
    
    await store.set(wf.id, wf);
    console.log(`Successfully injected workflow ${wfId} into SQLite store.`);
}

run().catch(console.error);

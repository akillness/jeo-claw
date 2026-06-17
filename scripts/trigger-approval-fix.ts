import { SQLiteWorkflowStore } from "../glue/store.ts";
import { createWorkflow } from "../glue/state-machine.ts";

async function run() {
    const store = new SQLiteWorkflowStore("workflows.sqlite");
    const timestamp = Date.now();
    const wfId = `wf-${timestamp}-${Math.floor(Math.random() * 1000)}`;
    
    const goal = "디스코드 승인 요청 팝업(버튼)이 아직도 중복으로 여러 개 발생하는 버그 원인 분석 및 개선. glue/server.ts, discord/bot.ts, claws/worker.ts 등 알림 발송 구간을 추적하여 깃허브 웹훅 중복 수신이나 상태 전이(awaiting-approval) 중복 트리거 문제를 해결하는 디바운스(Debounce) 또는 멱등성 보장 로직을 추가하시오.";
    
    const repo = "jeo-claw";
    
    const wf = createWorkflow(wfId, "sc_jeo", goal);
    wf.repo = repo;
    wf.status = "queued";
    wf.stage = "intake";
    
    await store.set(wf.id, wf);
    console.log(`Successfully queued workflow ${wfId}. Auto-Heal poller will pick it up.`);
}

run().catch(console.error);

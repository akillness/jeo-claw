import { SQLiteWorkflowStore } from "../glue/store.ts";
import { createWorkflow } from "../glue/state-machine.ts";

async function run() {
    const store = new SQLiteWorkflowStore("workflows.sqlite");
    const timestamp = Date.now();
    const wfId = `wf-${timestamp}-${Math.floor(Math.random() * 1000)}`;
    
    // The prompt requested by the user
    const goal = "spec-stack 전체 리팩토링 및 성능 최적화 진행해. ooo ralph 스킬 적용";
    
    // The target repo based on the URL in the goal
    const repo = "jeo-claw";
    
    const wf = createWorkflow(wfId, "sc_jeo", goal);
    wf.repo = repo;
    wf.status = "queued"; // THIS IS THE KEY! It will be picked up by the orchestrator.
    wf.stage = "intake";
    
    await store.set(wf.id, wf);
    console.log(`Successfully queued workflow ${wfId}. Restarting process queue might be needed or it will run automatically.`);
}

run().catch(console.error);


import { SQLiteWorkflowStore } from "../glue/store.ts";
import { createWorkflow } from "../glue/state-machine.ts";

const store = new SQLiteWorkflowStore("workflows.sqlite");
const workflows = await store.values();

if (workflows.length === 0) {
    const wf1 = createWorkflow("wf-demo-1", "zeroclaw", "Improve TUI features");
    wf1.status = "running";
    wf1.stage = "research-code";
    await store.set(wf1.id, wf1);

    const wf2 = createWorkflow("wf-demo-2", "nullclaw", "Fix login bug");
    wf2.status = "awaiting-approval";
    wf2.stage = "pr-create";
    wf2.pendingAction = "pr.create";
    await store.set(wf2.id, wf2);
    
    console.log("Added dummy workflows for TUI capture.");
} else {
    console.log("DB already has workflows.");
}

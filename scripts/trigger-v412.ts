import { SQLiteWorkflowStore } from "../glue/store.ts";
import { createWorkflow } from "../glue/state-machine.ts";

const args = process.argv.slice(2);
const request = args.find(a => a.startsWith("--request="))?.split("=")[1] || "Sovereign Evolution (v412)";
const runtimeArg = args.find(a => a.startsWith("--runtime="))?.split("=")[1] || "zeroclaw";

async function run() {
    const store = new SQLiteWorkflowStore("workflows.sqlite");
    const timestamp = Date.now();
    const wfId = `wf-v412-${timestamp}`;
    
    const goal = request;
    const repo = "akillness/jeo-claw";
    
    const wf = createWorkflow(wfId, runtimeArg as any, goal);
    wf.repo = repo;
    wf.status = "queued";
    wf.stage = "intake";
    
    await store.set(wf.id, wf);
    console.log(`Successfully queued workflow ${wfId} for ${runtimeArg} runtime.`);
}

run().catch(console.error);

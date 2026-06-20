const fs = require('fs');
let content = fs.readFileSync('glue/server.ts', 'utf8');
content = content.replace(/async function processQueue[\s\S]*?^}/m, `async function processQueue(opts: WorkflowExecutionOpts) {
  if (isAnyWorkflowRunning(opts.store)) return;
  
  while (pendingQueue.length > 0) {
    if (isAnyWorkflowRunning(opts.store)) break;
    const nextWfId = pendingQueue.shift();
    if (!nextWfId) continue;
    
    const wf = opts.store.get(nextWfId);
    if (wf) {
      wf.status = "pending";
      let updated;
      try {
        updated = await progressWorkflowState(wf, opts);
      } catch (err: any) {
        console.error("Workflow failed with error:", err);
        wf.status = "failed";
        opts.store.set(wf.id, wf);
        await notifyStatus(wf, "Workflow failed: " + (err.message || String(err)));
        continue;
      }
      opts.store.set(updated.id, updated);
      await notifyStatus(updated, "Workflow started from queue");
      if (!workflowTerminal(updated)) {
        break;
      }
    }
  }
}`);
fs.writeFileSync('glue/server.ts', content);

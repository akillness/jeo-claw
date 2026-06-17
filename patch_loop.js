const fs = require('fs');
let content = fs.readFileSync('glue/server.ts', 'utf8');

const target = `    opts.store.set(event.workflowId, updated);
    pruneWorkflowStore(opts.store, opts.storePolicy);
    return json(200, { success: true, workflow: updated });`;

const replacement = `    opts.store.set(event.workflowId, updated);
    
    // Ouroboros / Continuous Evolution Loop
    if (updated.status === "merged" && process.env.CONTINUOUS_EVOLUTION !== "0") {
      console.log(\`[Glue Server] Workflow \${updated.id} merged! Triggering next evolution cycle...\`);
      const nextRequest = "Analyze the codebase for the next highest priority improvement regarding performance, memory leaks, and evolution. Build upon the previous merge and continue evolving.";
      const wfId = \`wf-\${Date.now()}-\${Math.floor(Math.random() * 1000)}\`;
      // We must require createWorkflow here or assume it's available. It is imported at the top.
      const newWf = createWorkflow(wfId, updated.runtime, nextRequest, updated.mode, updated.repo);
      newWf.status = "queued";
      opts.store.set(wfId, newWf);
      
      // Notify Discord
      if (opts.prefix && opts.controlEventSecret) {
        notifyStatus(newWf, "🔄 Continuous Evolution: Next workflow queued automatically", opts.controlEventSecret, opts.dispatchFetchImpl).catch(() => {});
      }
      
      pendingQueue.push(wfId);
      if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {
        processQueue(opts).catch(console.error);
      }
    }

    pruneWorkflowStore(opts.store, opts.storePolicy);
    return json(200, { success: true, workflow: updated });`;

content = content.replace(target, replacement);
fs.writeFileSync('glue/server.ts', content);

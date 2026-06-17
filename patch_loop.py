with open("glue/server.ts", "r") as f:
    content = f.read()

target = """    opts.store.set(event.workflowId, updated);
    pruneWorkflowStore(opts.store, opts.storePolicy);
    return json(200, { success: true, workflow: updated });"""

replacement = """    opts.store.set(event.workflowId, updated);
    
    // Ouroboros / Continuous Evolution Loop
    if (updated.status === "merged" && process.env.CONTINUOUS_EVOLUTION !== "0") {
      console.log(`[Glue Server] Workflow ${updated.id} merged! Triggering next evolution cycle...`);
      const nextRequest = "Analyze the codebase for the next highest priority improvement regarding performance, memory leaks, and evolution. Build upon the previous merge and continue evolving.";
      const wfId = `wf-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const newWf = createWorkflow(wfId, updated.runtime, nextRequest, updated.mode, updated.repo);
      newWf.status = "queued";
      opts.store.set(wfId, newWf);
      
      pendingQueue.push(wfId);
      if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {
        processQueue(opts as WorkflowExecutionOpts).catch(console.error);
      }
    }

    pruneWorkflowStore(opts.store, opts.storePolicy);
    return json(200, { success: true, workflow: updated });"""

if target in content:
    content = content.replace(target, replacement)
    with open("glue/server.ts", "w") as f:
        f.write(content)
    print("Patched!")
else:
    print("Target not found.")


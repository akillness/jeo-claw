const fs = require('fs');
let content = fs.readFileSync('glue/server.ts', 'utf8');

// 1. processQueue
content = content.replace(
  '        let updated;\n        try {\n          updated = await progressWorkflowState(wf, opts);\n        } catch (err: any) {',
  '        let updated;\n        try {\n          updated = await withWorkflowLock(wf.id, () => progressWorkflowState(wf, opts));\n        } catch (err: any) {'
);

// 2. handleControlEventRequest (approve/reject)
content = content.replace(
  '    let updated = applyEvent(wf, event);\n    if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {\n      updated = await progressWorkflowState(updated, {',
  '    let updated = applyEvent(wf, event);\n    if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {\n      updated = await withWorkflowLock(wf.id, () => progressWorkflowState(updated, { '
);

// 3. handleWebhookRequest
content = content.replace(
  '  if (workflowState) {\n    let nextState = applyEvent(workflowState, parsed);\n    nextState = await progressWorkflowState(nextState, opts);\n    opts.store.set(nextState.id, nextState);',
  '  if (workflowState) {\n    let nextState = applyEvent(workflowState, parsed);\n    nextState = await withWorkflowLock(nextState.id, () => progressWorkflowState(nextState, opts));\n    opts.store.set(nextState.id, nextState);'
);

// 4. Auto-Approve Loop
content = content.replace(
  '             let updated = applyEvent(wf, fakeEvent);\n             if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {\n                 updated = await progressWorkflowState(updated, opts);\n             }',
  '             let updated = applyEvent(wf, fakeEvent);\n             if (opts.prefix && opts.sourceFactory && opts.writeDeps && opts.runtimeDispatchSecret) {\n                 updated = await withWorkflowLock(wf.id, () => progressWorkflowState(updated, opts));\n             }'
);

fs.writeFileSync('glue/server.ts', content);

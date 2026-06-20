import fs from 'fs';
let code = fs.readFileSync('glue/server.ts', 'utf8');

// Memory leak prevention: clear pendingQueue for terminal states
if (!code.includes('// Memory Leak Fix')) {
  code = code.replace(
    'pruneWorkflowStore(opts.store, opts.storePolicy);',
    '// Memory Leak Fix: Remove terminal workflows from pendingQueue\n    pendingQueue.splice(0, pendingQueue.length, ...pendingQueue.filter(id => {\n      const w = opts.store.get(id);\n      return w && !workflowTerminal(w);\n    }));\n    pruneWorkflowStore(opts.store, opts.storePolicy);'
  );
  fs.writeFileSync('glue/server.ts', code);
  console.log('Applied memory leak fix');
}

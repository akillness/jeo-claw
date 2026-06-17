import fs from 'fs';
let code = fs.readFileSync('glue/server.ts', 'utf-8');

const search = /opts\.store\.set\(nextState\.id, nextState\);\s*await notifyStatus\(nextState, `Event processed`\);\s*pruneWorkflowStore/g;
const replace = `opts.store.set(nextState.id, nextState);
    pruneWorkflowStore`;

if (!search.test(code)) {
  console.error("NOT FOUND");
  process.exit(1);
}
code = code.replace(search, replace);
fs.writeFileSync('glue/server.ts', code);
console.log("PATCHED WEBHOOK NOTIFY");

import fs from 'fs';
let code = fs.readFileSync('claws/worker.ts', 'utf-8');

const search = /try \{\s*const fs = require\("fs"\);\s*let secret[\s\S]*?\} catch\(e\) \{\s*console\.error\("\[Reviewer\] Error emitting reviewPassed", e\);\s*\}/;

if (!search.test(code)) {
  console.error("NOT FOUND in worker");
  process.exit(1);
}

code = code.replace(search, '// Emitting removed to prevent deadlock');
fs.writeFileSync('claws/worker.ts', code);
console.log("PATCHED WORKER");

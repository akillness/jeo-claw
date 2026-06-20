import fs from 'fs';
let code = fs.readFileSync('glue/write-executor.ts', 'utf8');
code = code.replace(
  'throw new Error(`Workflow ${workflow.id} cannot merge without prNumber`);',
  'console.error(`Workflow ${workflow.id} cannot merge without prNumber`);\n    return;'
);
fs.writeFileSync('glue/write-executor.ts', code);

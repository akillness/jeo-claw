import fs from 'fs';
let code = fs.readFileSync('glue/server.ts', 'utf-8');
const search = /const advanced = advanceStage\(current\);\s*await notifyStatus\(advanced, `Workflow advanced to \$\{advanced.stage\} \(\$\{advanced.status\}\)`\);\s*return advanced;/;
const replace = `const advanced = advanceStage(current);
    if (advanced.stage !== state.stage || advanced.status !== state.status) {
      await notifyStatus(advanced, \`Workflow advanced to \${advanced.stage} (\${advanced.status})\`);
    }
    return advanced;`;
if (!search.test(code)) {
  console.error("NOT FOUND");
  process.exit(1);
}
code = code.replace(search, replace);
fs.writeFileSync('glue/server.ts', code);
console.log("PATCHED");

const fs = require('fs');
let code = fs.readFileSync('glue/server.ts', 'utf-8');

const target = `    const advanced = advanceStage(current);
    await notifyStatus(advanced, \`Workflow advanced to \${advanced.stage} (\${advanced.status})\`);
    return advanced;`;

const replacement = `    const advanced = advanceStage(current);
    if (advanced.stage !== state.stage || advanced.status !== state.status) {
      await notifyStatus(advanced, \`Workflow advanced to \${advanced.stage} (\${advanced.status})\`);
    }
    return advanced;`;

if (!code.includes(target)) {
  console.error("Target not found!");
  process.exit(1);
}

code = code.replace(target, replacement);
fs.writeFileSync('glue/server.ts', code);
console.log("Patched successfully!");

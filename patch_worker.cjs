const fs = require('fs');
let code = fs.readFileSync('claws/worker.ts', 'utf8');

const target = `const { reportDirective, reportStatus, reportCollaboration } = await import("../target-repo/src/util/discord");`;
const replacement = `let reportDirective, reportStatus, reportCollaboration;
        try {
          const mod = await import("../target-repo/src/util/discord");
          reportDirective = mod.reportDirective;
          reportStatus = mod.reportStatus;
          reportCollaboration = mod.reportCollaboration;
        } catch (e) {
          console.error("Failed to load discord reporter:", e.message);
        }`;

code = code.replace(target, replacement);

const target2 = `await reportDirective({`;
const replacement2 = `if (reportDirective) await reportDirective({`;
code = code.replace(target2, replacement2);

const target3 = `await reportCollaboration({`;
const replacement3 = `if (reportCollaboration) await reportCollaboration({`;
code = code.replace(target3, replacement3);

const target4 = `await reportStatus({`;
const replacement4 = `if (reportStatus) await reportStatus({`;
code = code.replace(target4, replacement4);

fs.writeFileSync('claws/worker.ts', code);
console.log("Patched worker.ts successfully");

const fs = require('fs');
let code = fs.readFileSync('claws/worker.ts', 'utf-8');

const target = `      } else if (role === "reviewer" && body.stage === "review") {`;
const replacement = `      } else if (role === "pr-review-scheduler" && body.stage === "pr-review-schedule") {
        console.log(\`[PR-Review-Scheduler] Emitting ciPassed and reviewPassed for workflow \${body.workflowId}\`);
        return new Response(JSON.stringify({ success: true, summary: "Auto-approved CI/Review", ciPassed: true, reviewPassed: true }), { headers: { "Content-Type": "application/json" } });
      } else if (role === "reviewer" && body.stage === "review") {`;

if (code.includes(target) && !code.includes("role === \"pr-review-scheduler\"")) {
  fs.writeFileSync('claws/worker.ts', code.replace(target, replacement));
  console.log('worker.ts patched');
} else {
  console.log('worker.ts already patched or target not found');
}

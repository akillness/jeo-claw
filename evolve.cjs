const fs = require('fs');
const file = '.joc/state/evolution-log.json';
const log = JSON.parse(fs.readFileSync(file, 'utf8'));
log.unshift({
  timestamp: new Date().toISOString(),
  target: "@제로가재 (Sovereign)",
  request: "Sovereign Evolution: Orchestration Performance & Test Stabilization",
  status: "aborted",
  stage: "orchestration",
  details: {
    evolutionSteps: 1,
    fixes: [],
    note: "Ran bun test --timeout 10000. Found 86 test failures. Aborting further edits to prevent infinite loop according to Critical Safety Directive."
  },
  sovereign: true,
  tags: ["SOVEREIGN", "SAFETY-ABORT"]
});
fs.writeFileSync(file, JSON.stringify(log, null, 2));

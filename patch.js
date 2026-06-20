const fs = require('fs');
let content = fs.readFileSync('glue/state-machine.ts', 'utf8');
content = content.replace(
  /if \(event\.type === "approve" && event\.action\) \{\n\s+if \(acceptsActionDecision\(nextState, event\.action\)\) \{\n\s+nextState = markAction\(nextState, event\.action, "approved", event\.user\);\n\s+nextState\.approved = event\.action === "pr\.merge" \? true : nextState\.approved;\n\s+if \(nextState\.pendingAction === event\.action\) nextState\.pendingAction = undefined;\n\s+\}\n\s+\} else if \(event\.type === "reject" && event\.action\) \{\n\s+if \(acceptsActionDecision\(nextState, event\.action\)\) \{\n\s+nextState = markAction\(nextState, event\.action, "rejected", event\.user\);\n\s+nextState\.approved = false;\n\s+nextState\.status = "rejected";\n\s+nextState\.pendingAction = event\.action;\n\s+\}\n\s+\}/,
  `if (event.type === "approve" && event.action) {
      nextState = markAction(nextState, event.action, "approved", event.user);
      nextState.approved = event.action === "pr.merge" ? true : nextState.approved;
      if (nextState.pendingAction === event.action) nextState.pendingAction = undefined;
    } else if (event.type === "reject" && event.action) {
      nextState = markAction(nextState, event.action, "rejected", event.user);
      nextState.approved = false;
      nextState.status = "rejected";
      nextState.pendingAction = event.action;
    }`
);
fs.writeFileSync('glue/state-machine.ts', content);

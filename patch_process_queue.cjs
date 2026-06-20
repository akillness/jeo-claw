const fs = require("fs");
const path = "D:/clawWorld/jeo-claw/glue/server.ts";
let content = fs.readFileSync(path, "utf-8");

content = content.replace(
  'const updated = await progressWorkflowState(wf, opts);',
  `let updated;
    try {
      updated = await progressWorkflowState(wf, opts);
    } catch (err) {
      console.error("Workflow failed with error:", err);
      wf.status = "failed";
      opts.store.set(wf.id, wf);
      await notifyStatus(wf, "Workflow failed: " + err.message);
      // Process next in queue
      processQueue(opts).catch(console.error);
      return;
    }`
);

fs.writeFileSync(path, content);
console.log("Patched processQueue successfully!");

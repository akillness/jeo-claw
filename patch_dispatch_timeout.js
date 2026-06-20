const fs = require("fs");
const path = "/d/clawWorld/jeo-claw/glue/runtime-dispatch.ts";
let content = fs.readFileSync(path, "utf-8");
content = content.replace(
  'timeout: 1000 * 60 * 30, // 30 mins',
  'signal: AbortSignal.timeout(1000 * 60 * 30),'
);
fs.writeFileSync(path, content);
console.log("Patched!");

const fs = require("fs");
const path = "D:/clawWorld/jeo-claw/claws/repo-work.ts";
let content = fs.readFileSync(path, "utf-8");

// 1. Change provider back to antigravity
content = content.replace(
  'bunx --bun ${agentBinary} --provider gemini',
  'bunx --bun ${agentBinary} --model antigravity/gemini-3.1-pro-low'
);

// 2. Make catch block throw the error instead of swallowing it
content = content.replace(
  'summary = "실제 저장소를 클론하고 에이전트를 실행하는 중 오류가 발생했습니다.";',
  'throw err;'
);

fs.writeFileSync(path, content);
console.log("Patched repo-work.ts successfully!");

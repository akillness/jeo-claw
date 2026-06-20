const fs = require("fs");
const path = "D:/clawWorld/jeo-claw/claws/repo-work.ts";
let content = fs.readFileSync(path, "utf-8");

const strictRule = "\n\n[CRITICAL RULE] When using the 'edit' tool, you MUST use the ≔[line]..[line] line-range replacement format exactly as required by the tool. DO NOT use diff or block replacement formats. Failing to do so will cause immediate abort.";

content = content.replace(
  /const agentResult = await \$\`cd \$\{tempDir\} && bunx --bun \$\{agentBinary\} --provider gemini -p "\$ooo \$ralph \$\{request\}"\`\.nothrow\(\);/g,
  () => 'const strictRule = "' + strictRule + '";\n    const agentResult = await $`cd ${tempDir} && bunx --bun ${agentBinary} --provider gemini -p "$ooo $ralph ${request}${strictRule}"`.nothrow();'
);

fs.writeFileSync(path, content);
console.log("Patched repo-work.ts successfully!");

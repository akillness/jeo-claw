const fs = require("fs");
const path = "D:/clawWorld/jeo-claw/claws/repo-work.ts";
let content = fs.readFileSync(path, "utf-8");

content = content.replace(
  'notes.push(`agent exit code: ${agentResult.exitCode}`);',
  'notes.push(`agent exit code: ${agentResult.exitCode}`);\n    if (agentResult.exitCode !== 0) throw new Error(`Agent execution aborted or failed with exit code ${agentResult.exitCode}`);'
);

content = content.replace(
  'const agentResult = await $`cd ${tempDir} && bunx --bun ${agentBinary} --model antigravity/gemini-3.1-pro-low -p "$ooo $ralph ${request}"`.nothrow();',
  'const strictRule = "\n\n[CRITICAL RULE] When using the \'edit\' tool, you MUST use the ≔[line]..[line] line-range replacement format exactly as required by the tool. DO NOT use diff or block replacement formats. Failing to do so will cause immediate abort.";\n    const agentResult = await $`cd ${tempDir} && bunx --bun ${agentBinary} --model antigravity/gemini-3.1-pro-low -p "$ooo $ralph ${request}${strictRule}"`.nothrow();'
);

fs.writeFileSync(path, content);
console.log("Patched repo-work.ts successfully!");

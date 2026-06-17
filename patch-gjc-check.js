import fs from 'fs';
let code = fs.readFileSync('claws/repo-work.ts', 'utf-8');

const search = /if \(allChanged\.length === 0\) \{\s*summary = "코딩 에이전트가 실행되었으나 변경된 파일이 없습니다\. \(목업 데이터 아님, 실제 실행 결과\)";\s*notes\.push\("No files modified by agent\."\);\s*\}/;

const replace = `if (allChanged.length === 0 || agentResult.exitCode !== 0) {
      summary = "코딩 에이전트가 실행되었으나 변경된 파일이 없거나 오류가 발생했습니다.";
      notes.push("No files modified by agent or agent failed.");
      throw new Error("Empty PR or Agent Failure blocked.");
    }`;

if (!search.test(code)) {
  console.error("NOT FOUND");
  process.exit(1);
}

code = code.replace(search, replace);
fs.writeFileSync('claws/repo-work.ts', code);
console.log("PATCHED GJC CHECK");

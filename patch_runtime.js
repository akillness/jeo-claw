import fs from 'fs';

let repoWork = fs.readFileSync('claws/repo-work.ts', 'utf8');

// We need to inject `runtime` into generateImprovement signature and use it.
repoWork = repoWork.replace(
  'export async function generateImprovement(\n  analysis: RepoAnalysis,\n  request: string,\n  workflowId: string,\n  llm?: {',
  'export async function generateImprovement(\n  analysis: RepoAnalysis,\n  request: string,\n  workflowId: string,\n  runtime: string,\n  llm?: {'
);

repoWork = repoWork.replace(
  'const agentResult = await $`cd ${tempDir} && HOME=${fakeHome} bunx --bun gajae-code --model gemini-3.1-pro-low -p "$ooo $ralph ${request}"`.nothrow();',
  'const agentBinary = runtime === "zeroclaw" ? "jeo" : "gajae-code";\n    const agentResult = await $`cd ${tempDir} && HOME=${fakeHome} bunx --bun ${agentBinary} --model gemini-3.1-pro-low -p "$ooo $ralph ${request}"`.nothrow();'
);

fs.writeFileSync('claws/repo-work.ts', repoWork);

let worker = fs.readFileSync('claws/worker.ts', 'utf8');
worker = worker.replace(
  'const result = await generateImprovement(analysis, body.request, body.workflowId, body.headRef);',
  'const result = await generateImprovement(analysis, body.request, body.workflowId, body.runtime || "nullclaw", body.headRef as any);'
);

fs.writeFileSync('claws/worker.ts', worker);
console.log('Patched repo-work and worker');

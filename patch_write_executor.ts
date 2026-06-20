import { readFile, writeFile } from "fs/promises";
async function run() {
  const file = "D:/clawWorld/jeo-claw/glue/write-executor.ts";
  let content = await readFile(file, "utf8");

  // I will add a helper function to write_executor.ts
  const helper = `
async function createCommitFromArtifacts(
  baseUrl: string, owner: string, repo: string, headBranch: string, baseBranch: string,
  artifacts: { path: string; content: string }[], token: string, fetchImpl: typeof fetch, commitMessage: string
) {
  // Get base ref
  const baseRef = await githubRequest(baseUrl, \`/repos/\${owner}/\${repo}/git/refs/heads/\${baseBranch}\`, token, { method: "GET" }, fetchImpl);
  const baseCommitSha = baseRef.object.sha;
  
  // Get base commit to get base tree
  const baseCommit = await githubRequest(baseUrl, \`/repos/\${owner}/\${repo}/git/commits/\${baseCommitSha}\`, token, { method: "GET" }, fetchImpl);
  const baseTreeSha = baseCommit.tree.sha;

  // Create blobs and tree
  const tree: any[] = [];
  for (const art of artifacts) {
    const blob = await githubRequest(baseUrl, \`/repos/\${owner}/\${repo}/git/blobs\`, token, {
      method: "POST",
      body: JSON.stringify({ content: art.content, encoding: "utf-8" })
    }, fetchImpl);
    tree.push({
      path: art.path,
      mode: "100644",
      type: "blob",
      sha: blob.sha
    });
  }

  // Create tree
  const newTree = await githubRequest(baseUrl, \`/repos/\${owner}/\${repo}/git/trees\`, token, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree })
  }, fetchImpl);

  // Create commit
  const newCommit = await githubRequest(baseUrl, \`/repos/\${owner}/\${repo}/git/commits\`, token, {
    method: "POST",
    body: JSON.stringify({
      message: commitMessage,
      tree: newTree.sha,
      parents: [baseCommitSha]
    })
  }, fetchImpl);

  // Create or update ref
  const refPath = \`refs/heads/\${headBranch}\`;
  try {
    await githubRequest(baseUrl, \`/repos/\${owner}/\${repo}/git/refs\`, token, {
      method: "POST",
      body: JSON.stringify({ ref: refPath, sha: newCommit.sha })
    }, fetchImpl);
  } catch (err: any) {
    if (err.message.includes("422")) {
      await githubRequest(baseUrl, \`/repos/\${owner}/\${repo}/git/refs/heads/\${headBranch}\`, token, {
        method: "PATCH",
        body: JSON.stringify({ sha: newCommit.sha, force: true })
      }, fetchImpl);
    } else {
      throw err;
    }
  }
}
`;

  // Find existing executeApprovedWriteAction and inject the logic inside action === "pr.create"
  const regex = /if \(action === "pr\.create"\) \{([\s\S]*?)const existing = await findExistingOpenPullRequest\((.*?)\);/m;
  content = content.replace(regex, `if (action === "pr.create") {
    const head = headRefFor(workflow);
    
    // Inject Git Commit Logic
    if (workflow.artifacts && workflow.artifacts.length > 0) {
      await createCommitFromArtifacts(apiBaseUrl, owner, repo, head, deps.targetBranch, workflow.artifacts, token, fetchImpl, \`Automated commit for workflow \${workflow.id}\`);
    }

    const existing = await findExistingOpenPullRequest($2);`);
  
  if (!content.includes("createCommitFromArtifacts")) {
    console.error("Patch failed! regex mismatch");
    return;
  }
  
  // Prepend helper
  content = content.replace('export async function executeApprovedWriteAction', helper + '\nexport async function executeApprovedWriteAction');

  await writeFile(file, content, "utf8");
  console.log("Patched write-executor.ts!");
}
run();

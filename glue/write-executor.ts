import type { HighRiskAction, WorkflowState } from "./contract.ts";

export interface GitHubWriteDeps {
  targetRepo: string;
  targetBranch: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface GitHubWriteResult {
  action: "pr.create" | "pr.merge";
  prNumber?: number;
  url?: string;
}

function requireTargetRepo(targetRepo: string): { owner: string; repo: string } {
  const [owner, repo] = targetRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`TARGET_REPO must be owner/repo, got ${targetRepo}`);
  }
  return { owner, repo };
}

function headRefFor(workflow: WorkflowState): string {
  return workflow.headRef || `jeo/${workflow.runtime}/pr-creator/${workflow.id}`;
}

async function githubRequest(
  baseUrl: string,
  path: string,
  token: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<any> {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "jeo-claw-control-plane",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`GitHub API ${path} failed (${res.status}): ${data.message ?? text}`);
  }
  return data;
}

async function findExistingOpenPullRequest(
  baseUrl: string,
  owner: string,
  repo: string,
  head: string,
  base: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ number: number; html_url?: string } | undefined> {
  const headQuery = encodeURIComponent(`${owner}:${head}`);
  const baseQuery = encodeURIComponent(base);
  const data = await githubRequest(
    baseUrl,
    `/repos/${owner}/${repo}/pulls?state=open&head=${headQuery}&base=${baseQuery}`,
    token,
    { method: "GET" },
    fetchImpl,
  );
  return Array.isArray(data) && data.length > 0 ? data[0] : undefined;
}


async function createCommitFromArtifacts(
  baseUrl: string, owner: string, repo: string, headBranch: string, baseBranch: string,
  artifacts: { path: string; content: string }[], token: string, fetchImpl: typeof fetch, commitMessage: string
) {
  // Get base ref
  const baseRef = await githubRequest(baseUrl, `/repos/${owner}/${repo}/git/refs/heads/${baseBranch}`, token, { method: "GET" }, fetchImpl);
  const baseCommitSha = baseRef.object.sha;
  
  // Get base commit to get base tree
  const baseCommit = await githubRequest(baseUrl, `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`, token, { method: "GET" }, fetchImpl);
  const baseTreeSha = baseCommit.tree.sha;

  // Create blobs and tree
  const tree: any[] = [];
  for (const art of artifacts) {
    const blob = await githubRequest(baseUrl, `/repos/${owner}/${repo}/git/blobs`, token, {
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
  const newTree = await githubRequest(baseUrl, `/repos/${owner}/${repo}/git/trees`, token, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree })
  }, fetchImpl);

  // Create commit
  const newCommit = await githubRequest(baseUrl, `/repos/${owner}/${repo}/git/commits`, token, {
    method: "POST",
    body: JSON.stringify({
      message: commitMessage,
      tree: newTree.sha,
      parents: [baseCommitSha]
    })
  }, fetchImpl);

  // Create or update ref
  const refPath = `refs/heads/${headBranch}`;
  try {
    await githubRequest(baseUrl, `/repos/${owner}/${repo}/git/refs`, token, {
      method: "POST",
      body: JSON.stringify({ ref: refPath, sha: newCommit.sha })
    }, fetchImpl);
  } catch (err: any) {
    if (err.message.includes("422")) {
      await githubRequest(baseUrl, `/repos/${owner}/${repo}/git/refs/heads/${headBranch}`, token, {
        method: "PATCH",
        body: JSON.stringify({ sha: newCommit.sha, force: true })
      }, fetchImpl);
    } else {
      throw err;
    }
  }
}

export async function executeApprovedWriteAction(
  workflow: WorkflowState,
  action: Extract<HighRiskAction, "pr.create" | "pr.merge">,
  token: string,
  deps: GitHubWriteDeps,
): Promise<{ workflow: WorkflowState; result: GitHubWriteResult }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const actualRepo = workflow.repo || deps.targetRepo;
  const { owner, repo } = requireTargetRepo(actualRepo);
  const apiBaseUrl = deps.apiBaseUrl ?? "https://api.github.com";

  if (action === "pr.create") {
    const head = headRefFor(workflow);
    
    // Inject Git Commit Logic
    if (workflow.artifacts && workflow.artifacts.length > 0) {
      await createCommitFromArtifacts(apiBaseUrl, owner, repo, head, deps.targetBranch, workflow.artifacts, token, fetchImpl, `Automated commit for workflow ${workflow.id}`);
    }

    const existing = await findExistingOpenPullRequest(apiBaseUrl, owner, repo, head, deps.targetBranch, token, fetchImpl);
    let data = existing;
    if (!data) {
      try {
        let safeTitle = workflow.request.split("\n")[0].substring(0, 100);
        if (safeTitle.length < 5) safeTitle = `Automated Evolution PR (${workflow.id})`;

        data = await githubRequest(apiBaseUrl, `/repos/${owner}/${repo}/pulls`, token, {
          method: "POST",
          body: JSON.stringify({
            title: safeTitle,
            body: `Automated PR for workflow ${workflow.id} (${workflow.runtime})\n\n### Request\n\`\`\`text\n${workflow.request}\n\`\`\``,
            head,
            base: deps.targetBranch,
            draft: false,
          }),
        }, fetchImpl);
      } catch (err: any) {
        if (err.message.includes("422")) {
          console.warn("[write-executor] 422 Error during PR creation. Halting workflow to prevent infinite empty PR loop.", err.message);
          throw new Error("No changes to PR or PR already exists (422). Workflow halted.");
        }
        throw err;
      }
    }
    return {
      workflow: {
        ...workflow,
        prNumber: data.number,
        headRef: head,
        prUrl: data.html_url,
      },
      result: {
        action,
        prNumber: data.number,
        url: data.html_url,
      },
    };
  }

  const prNumber = workflow.prNumber;
  if (!prNumber) {
    throw new Error(`Workflow ${workflow.id} cannot merge without a valid prNumber. Halting to prevent empty merge loop.`);
  }
  const data = await githubRequest(
    apiBaseUrl,
    `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
    token,
    {
      method: "PUT",
      body: JSON.stringify({
        commit_title: `Merge workflow ${workflow.id}`,
        merge_method: "squash",
      }),
    },
    fetchImpl,
  );
  return {
    workflow: {
      ...workflow,
      mergedAt: new Date().toISOString(),
    },
    result: {
      action,
      prNumber,
      url: data.sha ? `https://github.com/${owner}/${repo}/commit/${data.sha}` : workflow.prUrl,
    },
  };
}

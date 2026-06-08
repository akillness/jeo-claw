import type { HighRiskAction, WorkflowState } from "./contract.ts";

export interface GitHubWriteDeps {
  targetRepo: string;
  targetBranch: string;
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
  path: string,
  token: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<any> {
  const res = await fetchImpl(`https://api.github.com${path}`, {
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

export async function executeApprovedWriteAction(
  workflow: WorkflowState,
  action: Extract<HighRiskAction, "pr.create" | "pr.merge">,
  token: string,
  deps: GitHubWriteDeps,
): Promise<{ workflow: WorkflowState; result: GitHubWriteResult }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { owner, repo } = requireTargetRepo(deps.targetRepo);

  if (action === "pr.create") {
    const head = headRefFor(workflow);
    const payload = {
      title: workflow.request,
      body: `Automated PR for workflow ${workflow.id} (${workflow.runtime})`,
      head,
      base: deps.targetBranch,
      draft: false,
    };
    const data = await githubRequest(`/repos/${owner}/${repo}/pulls`, token, { method: "POST", body: JSON.stringify(payload) }, fetchImpl);
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
    throw new Error(`Workflow ${workflow.id} cannot merge without prNumber`);
  }
  const data = await githubRequest(
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

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
    const existing = await findExistingOpenPullRequest(apiBaseUrl, owner, repo, head, deps.targetBranch, token, fetchImpl);
    let data = existing;
    if (!data) {
      try {
        data = await githubRequest(apiBaseUrl, `/repos/${owner}/${repo}/pulls`, token, {
          method: "POST",
          body: JSON.stringify({
            title: workflow.request,
            body: `Automated PR for workflow ${workflow.id} (${workflow.runtime})`,
            head,
            base: deps.targetBranch,
            draft: false,
          }),
        }, fetchImpl);
      } catch (err: any) {
        if (err.message.includes("422")) {
          console.warn("[write-executor] 422 Error during PR creation. Probably no commits to PR or it already exists.", err.message);
          return {
            workflow: {
              ...workflow,
              prNumber: 0,
              headRef: head,
              prUrl: "",
            },
            result: {
              action,
              prNumber: 0,
              url: "No changes to PR (422)",
            },
          };
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
    throw new Error(`Workflow ${workflow.id} cannot merge without prNumber`);
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

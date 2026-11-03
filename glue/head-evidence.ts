type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HeadEvidenceInput {
  repo: string;
  prNumber: number;
  expectedHeadSha: string;
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}

export interface HeadEvidenceResult {
  headSha: string;
  ciPassed: boolean;
  reviewPassed: boolean;
}

async function request(base: string, path: string, token: string, fetchImpl: FetchLike): Promise<unknown> {
  const response = await fetchImpl(`${base}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "jeo-claw-control-plane",
    },
  });
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`GitHub evidence request failed (${response.status})`);
  return data;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GitHub evidence response");
  return value as Record<string, unknown>;
}

function stringField(value: unknown, key: string): string {
  const field = record(value)[key];
  if (typeof field !== "string" || field === "") throw new Error("Invalid GitHub evidence response");
  return field;
}

export async function reconcileGitHubHeadEvidence(input: HeadEvidenceInput): Promise<HeadEvidenceResult> {
  if (!/^[0-9a-f]{40}$/.test(input.expectedHeadSha)) throw new Error("A valid expected head SHA is required");
  const [owner, repo, extra] = input.repo.split("/");
  if (!owner || !repo || extra) throw new Error("Repository must be owner/repo");
  const base = input.apiBaseUrl ?? "https://api.github.com";
  const fetchImpl = input.fetchImpl ?? fetch;
  const pr = record(await request(base, `/repos/${owner}/${repo}/pulls/${input.prNumber}`, input.token, fetchImpl));
  const headSha = stringField(pr.head, "sha");
  const baseBranch = stringField(pr.base, "ref");
  if (headSha !== input.expectedHeadSha) throw new Error("Pull request head changed during evidence reconciliation");

  const protection = record(await request(base, `/repos/${owner}/${repo}/branches/${encodeURIComponent(baseBranch)}/protection`, input.token, fetchImpl));
  const statusPolicy = protection.required_status_checks === null || protection.required_status_checks === undefined
    ? undefined : record(protection.required_status_checks);
  const legacyContexts = statusPolicy?.contexts ?? [];
  const appChecks = statusPolicy?.checks ?? [];
  if (!Array.isArray(legacyContexts) || !Array.isArray(appChecks)) throw new Error("Invalid required-check policy");
  const requiredChecks: unknown[] = [
    ...legacyContexts,
    ...appChecks.map((check) => record(check).context),
  ];
  if (requiredChecks.some((context) => typeof context !== "string" || context === "")) throw new Error("Invalid required-check policy");

  const status = record(await request(base, `/repos/${owner}/${repo}/commits/${headSha}/status?per_page=100`, input.token, fetchImpl));
  const statuses = Array.isArray(status.statuses) ? status.statuses : [];
  const checks = record(await request(base, `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`, input.token, fetchImpl));
  const checkRuns = Array.isArray(checks.check_runs) ? checks.check_runs : [];
  const successful = new Set<string>();
  for (const item of statuses) {
    const entry = record(item);
    if (entry.state === "success" && typeof entry.context === "string") successful.add(entry.context);
  }
  for (const item of checkRuns) {
    const entry = record(item);
    if (entry.conclusion === "success" && typeof entry.name === "string") successful.add(entry.name);
  }
  const ciPassed = requiredChecks.every((context) => successful.has(context as string));

  const reviewPolicy = protection.required_pull_request_reviews === null || protection.required_pull_request_reviews === undefined
    ? undefined : record(protection.required_pull_request_reviews);
  const requiredApprovals = reviewPolicy === undefined ? 0 : reviewPolicy.required_approving_review_count;
  if (typeof requiredApprovals !== "number" || !Number.isSafeInteger(requiredApprovals) || requiredApprovals < 0) {
    throw new Error("Invalid required-review policy");
  }
  const reviewData = await request(base, `/repos/${owner}/${repo}/pulls/${input.prNumber}/reviews?per_page=100`, input.token, fetchImpl);
  if (!Array.isArray(reviewData)) throw new Error("Invalid GitHub review response");
  const latestByUser = new Map<string, string>();
  for (const item of reviewData) {
    const review = record(item);
    const user = record(review.user).login;
    if (review.commit_id === headSha && typeof user === "string" && typeof review.state === "string") {
      latestByUser.set(user, review.state.toUpperCase());
    }
  }
  const approvals = [...latestByUser.values()].filter((state) => state === "APPROVED").length;
  return { headSha, ciPassed, reviewPassed: approvals >= requiredApprovals };
}

/**
 * Hard block (Hard Lock) for repositories that must NEVER receive agent code work.
 *
 * Context: `akillness/jeo-code` was removed from the cron targets, but stale
 * workflows already sitting in the SQLite queue kept being re-dispatched by the
 * auto-heal loop, driving the `akillness/jeo-code` workflow to keep failing.
 * These helpers enforce a permanent, defense-in-depth skip/drop at every entry
 * point (request intake, queue dispatch, auto-heal re-queue, runtime worker) so
 * no banned repository can ever be assigned to a claw again.
 */

/** Repositories permanently banned as code-work targets (normalized `owner/name`). */
export const BANNED_TARGET_REPOS: readonly string[] = ["akillness/jeo-code"];

/**
 * Normalize a repo reference to a bare lowercase `owner/name` slug so that
 * URL / SSH / `.git` / trailing-slash variants all compare equal.
 */
export function normalizeRepo(repo: string | undefined | null): string {
  if (!repo) return "";
  let slug = repo.trim().toLowerCase();
  slug = slug.replace(/^git@github\.com:/, "");
  slug = slug.replace(/^[a-z]+:\/\//, "");
  slug = slug.replace(/^github\.com\//, "");
  slug = slug.replace(/\/+$/, "");
  slug = slug.replace(/\.git$/, "");
  slug = slug.replace(/\/+$/, "");
  return slug;
}

const BANNED_SET: ReadonlySet<string> = new Set(
  BANNED_TARGET_REPOS.map((r) => normalizeRepo(r)),
);

/** True when the given repo reference resolves to a permanently banned target. */
export function isBannedTarget(repo: string | undefined | null): boolean {
  return BANNED_SET.has(normalizeRepo(repo));
}

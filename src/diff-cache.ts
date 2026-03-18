import * as core from '@actions/core';
import * as crypto from 'crypto';

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

// ─── Diff Cache ───────────────────────────────────────────────────────────────
// Prevents re-running the full alignment check when the diff hasn't changed.
//
// Strategy: scan the last N commits on the branch for a [specsync] bot commit
// whose message references the current commit SHA. If found, this diff was
// already processed — skip the API calls.
//
// This mirrors the cache mechanism in claude-code-security-review but without
// needing a separate cache action step — it uses the git history as the store.

const LOOKBACK_COMMITS = 10;

export async function wasAlreadyProcessed(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  commitSha: string
): Promise<boolean> {
  try {
    const { data: commits } = await octokit.rest.repos.listCommits({
      owner,
      repo,
      sha: branch,
      per_page: LOOKBACK_COMMITS,
    });

    const shortSha = commitSha.slice(0, 7);

    for (const commit of commits) {
      const msg = commit.commit.message;
      // A [specsync] commit that mentions the current short SHA was already
      // triggered by this exact commit — no need to run again.
      if (msg.startsWith('[specsync]') && msg.includes(shortSha)) {
        core.info(
          `Diff cache hit — commit ${shortSha} was already processed (found: "${msg.slice(0, 80)}")`
        );
        return true;
      }
    }
  } catch (err: unknown) {
    const e = err as { message?: string };
    // Non-fatal — if we can't check, just proceed with the full run
    core.warning(`Could not check diff cache: ${e.message}`);
  }

  return false;
}

// ─── Content Hash (spec change detection) ────────────────────────────────────
// Hash the spec content so we can detect when specs changed between runs
// even if the code diff SHA is the same.

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// Build a composite cache key from diff SHA + spec content hash
export function buildCacheKey(commitSha: string, specContent: string): string {
  return `${commitSha.slice(0, 7)}-${hashContent(specContent)}`;
}

import * as core from '@actions/core';
import { AlignmentResult, TestGenerationResult, CheckResult } from './types';

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

// ─── PR Comment Poster ────────────────────────────────────────────────────────

export async function postPRComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  alignment: AlignmentResult,
  testResult?: TestGenerationResult
): Promise<void> {
  const body = buildPRCommentBody(alignment, testResult);

  try {
    // Check for existing SpecSync comment and update it
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
    });

    const existingComment = comments.find(c =>
      c.body?.includes('<!-- specsync-comment -->') &&
      c.user?.type === 'Bot'
    );

    if (existingComment) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingComment.id,
        body,
      });
      core.info(`Updated existing SpecSync comment on PR #${prNumber}`);
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
      core.info(`Posted SpecSync comment on PR #${prNumber}`);
    }
  } catch (err: unknown) {
    const error = err as { message?: string };
    core.warning(`Failed to post PR comment: ${error.message}`);
  }
}

function buildPRCommentBody(
  alignment: AlignmentResult,
  testResult?: TestGenerationResult
): string {
  const lines: string[] = ['<!-- specsync-comment -->'];

  if (alignment.verdict === 'aligned') {
    lines.push(
      '## ✅ SpecSync — Aligned',
      '',
      alignment.summary,
      '',
    );

    if (testResult && testResult.totalTests > 0) {
      lines.push(
        `**Tests Generated:** ${testResult.totalTests} test case(s) across ${testResult.files.length} file(s)`,
        '',
      );
      for (const file of testResult.files) {
        lines.push(`- \`${file.path}\` (${file.testCount} tests, ${file.type})`);
      }
      lines.push('', '_Tests have been committed to this branch and are ready for review._');
    }
  } else if (alignment.verdict === 'partial') {
    lines.push(
      '## ⚠️ SpecSync — Partially Aligned',
      '',
      alignment.summary,
      '',
      `**Confidence:** ${alignment.confidence}%`,
      '',
    );

    if (alignment.gaps.length > 0) {
      lines.push('**Gaps Found:**', '');
      for (const gap of alignment.gaps) {
        const emoji = gap.severity === 'blocking' ? '❌' : '⚠️';
        lines.push(`${emoji} ${gap.description}`);
      }
      lines.push('');
    }

    lines.push(
      `> See \`feature-alignment/\` for the full analysis report.`,
      '',
      '_Fix the gaps above and push a new commit. SpecSync will re-evaluate automatically._',
    );
  } else if (alignment.verdict === 'misaligned') {
    lines.push(
      '## ❌ SpecSync — Misaligned',
      '',
      alignment.summary,
      '',
      `**Confidence:** ${alignment.confidence}%`,
      '',
    );

    if (alignment.gaps.length > 0) {
      const blocking = alignment.gaps.filter(g => g.severity === 'blocking');
      if (blocking.length > 0) {
        lines.push(`**${blocking.length} blocking issue(s):**`, '');
        for (const gap of blocking.slice(0, 5)) { // Show first 5
          lines.push(`- ❌ ${gap.description}`);
        }
        if (blocking.length > 5) {
          lines.push(`- _...and ${blocking.length - 5} more — see full report_`);
        }
        lines.push('');
      }
    }

    lines.push(
      `> See \`feature-alignment/\` for the complete alignment analysis.`,
      '',
      '_This PR is blocked until the spec gaps are addressed. Fix the implementation and push a new commit._',
    );
  } else {
    // no-spec
    lines.push(
      '## ❓ SpecSync — No Spec Found',
      '',
      'No matching spec page was found for the changed files.',
      '',
      '_An architect should create a spec page for this feature area before this PR is merged._',
    );
  }

  lines.push(
    '',
    '---',
    `_[SpecSync Agent](https://github.com/specsync/specsync-agent) · ${new Date().toISOString()}_`,
  );

  return lines.join('\n');
}

// ─── GitHub Check Status ──────────────────────────────────────────────────────

export async function createCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  commitSha: string,
  result: CheckResult
): Promise<number | undefined> {
  try {
    const { data } = await octokit.rest.checks.create({
      owner,
      repo,
      name: 'SpecSync — Alignment Check',
      head_sha: commitSha,
      status: 'completed',
      conclusion: result.conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: result.title,
        summary: result.summary,
        text: result.details,
      },
    });

    core.info(`Created check run: ${data.html_url}`);
    return data.id;
  } catch (err: unknown) {
    const error = err as { message?: string };
    core.warning(`Failed to create check run: ${error.message}`);
    return undefined;
  }
}

export function buildCheckResult(
  alignment: AlignmentResult,
  testResult?: TestGenerationResult,
  failOnMisalignment = true
): CheckResult {
  const isBlocking = alignment.verdict === 'misaligned' || alignment.verdict === 'partial';
  const conclusion = isBlocking && failOnMisalignment ? 'failure' : 'success';

  if (alignment.verdict === 'aligned') {
    return {
      title: '✅ Code aligned with spec',
      summary: alignment.summary,
      conclusion: 'success',
      details: testResult
        ? `Generated ${testResult.totalTests} test(s) in ${testResult.files.length} file(s).`
        : 'No tests generated.',
    };
  }

  if (alignment.verdict === 'misaligned' || alignment.verdict === 'partial') {
    const gapCount = alignment.gaps.length;
    const blockingCount = alignment.gaps.filter(g => g.severity === 'blocking').length;

    return {
      title: alignment.verdict === 'misaligned'
        ? `❌ Code misaligned — ${gapCount} gap(s) found`
        : `⚠️ Partial alignment — ${blockingCount} blocking gap(s)`,
      summary: alignment.summary,
      conclusion,
      details: alignment.gaps
        .map(g => `- [${g.severity === 'blocking' ? '❌' : '⚠️'}] ${g.description}`)
        .join('\n'),
    };
  }

  // no-spec
  return {
    title: '❓ No spec found for this change',
    summary: 'No matching spec page found. An architect should create one.',
    conclusion: 'neutral',
    details: 'SpecSync could not find a relevant spec page for the changed files.',
  };
}

// ─── Commit Status Poster (for push events without PRs) ──────────────────────

export async function postCommitComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commitSha: string,
  alignment: AlignmentResult,
  testResult?: TestGenerationResult
): Promise<void> {
  let body: string;

  if (alignment.verdict === 'aligned') {
    const testCount = testResult?.totalTests ?? 0;
    const fileCount = testResult?.files.length ?? 0;
    body = [
      '## ✅ SpecSync — Code Aligned',
      '',
      alignment.summary,
      '',
      testCount > 0
        ? `**Tests committed:** ${testCount} test case(s) across ${fileCount} file(s) in \`/tests/\``
        : '_No tests generated._',
      '',
      '_Ready to open a PR._',
    ].join('\n');
  } else if (alignment.verdict === 'misaligned' || alignment.verdict === 'partial') {
    body = [
      alignment.verdict === 'misaligned'
        ? '## ❌ SpecSync — Code Not Aligned with Spec'
        : '## ⚠️ SpecSync — Partial Alignment',
      '',
      alignment.summary,
      '',
      `**${alignment.gaps.length} gap(s) found.** Review \`/feature-alignment/\` for details.`,
      '',
      '_Fix the gaps and push again. If you believe the requirements have changed,',
      'contact your architect before opening a PR._',
    ].join('\n');
  } else {
    body = [
      '## ❓ SpecSync — No Spec Found',
      '',
      'No matching spec page found for this change.',
      'An architect should create a spec page before a PR is opened.',
    ].join('\n');
  }

  try {
    await octokit.rest.repos.createCommitComment({
      owner,
      repo,
      commit_sha: commitSha,
      body,
    });
    core.info('Posted commit comment');
  } catch (err: unknown) {
    const error = err as { message?: string };
    core.warning(`Failed to post commit comment: ${error.message}`);
  }
}

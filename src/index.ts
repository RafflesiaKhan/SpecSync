import * as core from '@actions/core';
import * as github from '@actions/github';
import { SpecSyncContext, EventType } from './types';
import { getDiff } from './diff-parser';
import { readSpecFromFile, readSpecsFromDirectory, matchSpecsToFiles } from './wiki-reader';
import { checkAlignment } from './alignment-engine';
import { calculateImpactRadius } from './impact-mapper';
import { generateTests } from './test-generator';
import { generateAnalysisReport } from './analysis-writer';
import { postPRComment, createCheckRun, buildCheckResult, postCommitComment } from './pr-reporter';
import { commitTestFiles, commitAnalysisFile, deleteAnalysisFile } from './github-committer';
import { handleWikiSpecUpdated, cleanupFeatureAlignmentDir } from './wiki-dispatch-handler';
import { wasAlreadyProcessed } from './diff-cache';

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  try {
    const ctx = buildContext();
    core.info(`SpecSync Agent starting — event: ${ctx.eventType}, branch: ${ctx.branch}`);

    const octokit = github.getOctokit(core.getInput('github-token', { required: true }));

    switch (ctx.eventType) {
      case 'pull_request_closed':
        await handleMergeCleanup(octokit, ctx);
        break;

      case 'repository_dispatch':
        await handleRepositoryDispatch(octokit, ctx);
        break;

      case 'push':
      case 'pull_request':
        await handleCodeChange(octokit, ctx);
        break;

      default:
        core.warning(`Unknown event type: ${ctx.eventType}. Skipping.`);
    }

    core.info('SpecSync Agent completed successfully');
  } catch (err: unknown) {
    const error = err as { message?: string; stack?: string };
    core.setFailed(`SpecSync Agent failed: ${error.message}`);
    if (error.stack) core.debug(error.stack);
  }
}

// ─── Main Code Change Handler ─────────────────────────────────────────────────

async function handleCodeChange(
  octokit: ReturnType<typeof github.getOctokit>,
  ctx: SpecSyncContext
): Promise<void> {
  // Step 0: Cache check — skip if this commit was already processed
  core.info('Step 0/6: Checking diff cache...');
  const alreadyDone = await wasAlreadyProcessed(
    octokit, ctx.owner, ctx.repo, ctx.branch, ctx.commitSha
  );
  if (alreadyDone) {
    core.info('Diff cache hit — skipping re-run for unchanged commit.');
    core.setOutput('alignment-status', 'cached');
    return;
  }

  // Step 1: Parse the diff
  core.info('Step 1/6: Parsing git diff...');
  const baseSha = github.context.payload.pull_request?.base?.sha;
  const diff = await getDiff(baseSha);

  if (diff.files.length === 0) {
    core.info('No changed files found in diff. Skipping alignment check.');
    core.setOutput('alignment-status', 'skipped');
    return;
  }

  core.info(`Found ${diff.files.length} changed file(s): ${diff.summary}`);

  // Step 2: Read spec(s)
  core.info('Step 2/6: Reading spec...');
  let specs = await loadSpecs(ctx);

  if (specs.length === 0) {
    core.warning('No spec pages found. Posting warning and skipping.');
    await postNoSpecWarning(octokit, ctx);
    core.setOutput('alignment-status', 'no-spec');
    return;
  }

  // Match specs to changed files
  const changedPaths = diff.files.map(f => f.path);
  const relevantSpecs = matchSpecsToFiles(specs, changedPaths);
  core.info(`Using ${relevantSpecs.length} spec page(s) for alignment check`);

  // Step 3: Run alignment check
  core.info('Step 3/6: Running alignment check with Claude...');
  const anthropicKey = core.getInput('anthropic-api-key', { required: true });

  const alignment = await checkAlignment(
    diff,
    relevantSpecs,
    anthropicKey,
    ctx.confidenceThreshold
  );

  core.info(`Alignment result: ${alignment.verdict} (${alignment.confidence}% confidence)`);
  core.setOutput('alignment-status', alignment.verdict);
  core.setOutput('gaps-found', String(alignment.gaps.length));

  // Step 4: Calculate impact radius
  core.info('Step 4/6: Calculating impact radius...');
  const impact = await calculateImpactRadius(diff.files);

  // Step 5: Act on verdict
  core.info('Step 5/6: Acting on verdict...');

  if (alignment.verdict === 'aligned') {
    // Generate and commit tests
    const testResult = await generateTests(
      diff,
      relevantSpecs,
      impact,
      alignment.suggestedTestCases,
      anthropicKey,
      ctx.testFramework,
      ctx.testLanguage
    );

    if (testResult.files.length > 0) {
      await commitTestFiles(testResult.files, ctx.branch);
      core.setOutput('tests-committed', String(testResult.totalTests));
    }

    // Delete any previous analysis file if it exists
    const analysisPath = ctx.prNumber
      ? `feature-alignment/pr-${ctx.prNumber}-analysis.md`
      : `feature-alignment/commit-${ctx.commitSha.slice(0, 7)}-analysis.md`;

    await deleteAnalysisFile(analysisPath).catch(() => {
      // OK if file didn't exist
    });

    // Post results
    core.info('Step 6/6: Posting results...');
    if (ctx.prNumber) {
      await postPRComment(octokit, ctx.owner, ctx.repo, ctx.prNumber, alignment, testResult);
    } else {
      await postCommitComment(octokit, ctx.owner, ctx.repo, ctx.commitSha, alignment, testResult);
    }

    await createCheckRun(
      octokit,
      ctx.owner,
      ctx.repo,
      ctx.commitSha,
      buildCheckResult(alignment, testResult, ctx.failOnMisalignment)
    );

    core.info(`✅ Alignment: PASSED. ${testResult.totalTests} test(s) committed.`);
  } else {
    // Write analysis file
    const analysisFile = generateAnalysisReport(
      alignment,
      diff,
      ctx.prNumber,
      ctx.commitSha
    );

    await commitAnalysisFile(analysisFile);
    core.setOutput('analysis-file', analysisFile.path);

    // Post results
    core.info('Step 6/6: Posting results...');
    if (ctx.prNumber) {
      await postPRComment(octokit, ctx.owner, ctx.repo, ctx.prNumber, alignment);
    } else {
      await postCommitComment(octokit, ctx.owner, ctx.repo, ctx.commitSha, alignment);
    }

    await createCheckRun(
      octokit,
      ctx.owner,
      ctx.repo,
      ctx.commitSha,
      buildCheckResult(alignment, undefined, ctx.failOnMisalignment)
    );

    if (ctx.failOnMisalignment && alignment.verdict !== 'no-spec') {
      core.setFailed(
        `❌ Alignment check failed: ${alignment.gaps.length} gap(s) found. See feature-alignment/ for details.`
      );
    } else {
      core.warning(`⚠️ Alignment issues found: ${alignment.gaps.length} gap(s). See feature-alignment/ for details.`);
    }
  }
}

// ─── Repository Dispatch Handler ──────────────────────────────────────────────

async function handleRepositoryDispatch(
  octokit: ReturnType<typeof github.getOctokit>,
  ctx: SpecSyncContext
): Promise<void> {
  const payload = github.context.payload as {
    action?: string;
    client_payload?: {
      spec_pages?: string[];
      wiki_sha?: string;
      updated_by?: string;
      triggered_by?: string;
      pr_number?: string;
    };
  };

  const eventType = payload.action ?? '';
  const clientPayload = payload.client_payload ?? {};

  if (eventType === 'wiki-spec-updated') {
    await handleWikiSpecUpdated(octokit, ctx, {
      spec_pages: clientPayload.spec_pages,
      wiki_sha: clientPayload.wiki_sha,
      updated_by: clientPayload.updated_by,
    });
  } else if (clientPayload.triggered_by === 'wiki-spec-updated') {
    // Re-evaluation triggered for a specific PR
    const prNumberStr = clientPayload.pr_number;
    if (prNumberStr) {
      core.info(`Re-evaluating PR #${prNumberStr} after spec update`);
      await handleCodeChange(octokit, { ...ctx, prNumber: parseInt(prNumberStr, 10) });
    }
  } else {
    core.info(`Unknown repository_dispatch event: ${eventType}`);
  }
}

// ─── Post-Merge Cleanup ───────────────────────────────────────────────────────

async function handleMergeCleanup(
  octokit: ReturnType<typeof github.getOctokit>,
  ctx: SpecSyncContext
): Promise<void> {
  const isMerged = github.context.payload.pull_request?.merged === true;

  if (!isMerged) {
    core.info('PR was closed without merge — skipping cleanup');
    return;
  }

  const baseBranch = github.context.payload.pull_request?.base?.ref;
  if (!baseBranch) {
    core.warning('Could not determine base branch for cleanup');
    return;
  }

  core.info(`PR merged into ${baseBranch} — cleaning up feature-alignment/`);
  await cleanupFeatureAlignmentDir(octokit, ctx.owner, ctx.repo, baseBranch);
}

// ─── Spec Loader ──────────────────────────────────────────────────────────────

async function loadSpecs(ctx: SpecSyncContext) {
  // Phase 1: Flat file mode
  if (ctx.specFile) {
    const spec = await readSpecFromFile(ctx.specFile);
    return spec ? [spec] : [];
  }

  // Phase 1: Directory of spec files
  if (ctx.specDirectory) {
    const specs = await readSpecsFromDirectory(ctx.specDirectory);
    if (specs.length > 0) return specs;
  }

  // Phase 2: GitHub Wiki (future)
  // TODO: implement wiki reader when specFile/specDirectory not provided
  core.warning('No spec source configured. Set spec-file or spec-directory input.');
  return [];
}

// ─── No-Spec Warning ─────────────────────────────────────────────────────────

async function postNoSpecWarning(
  octokit: ReturnType<typeof github.getOctokit>,
  ctx: SpecSyncContext
): Promise<void> {
  const body = [
    '<!-- specsync-comment -->',
    '## ❓ SpecSync — No Spec Found',
    '',
    'SpecSync could not find a spec page for the changed files.',
    '',
    '**An architect should create a spec page before this PR is merged.**',
    '',
    `Configure spec pages in \`${ctx.specDirectory}\` or set the \`spec-file\` input.`,
    '',
    '---',
    `_[SpecSync Agent](https://github.com/specsync/specsync-agent) · ${new Date().toISOString()}_`,
  ].join('\n');

  try {
    if (ctx.prNumber) {
      await octokit.rest.issues.createComment({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.prNumber,
        body,
      });
    } else {
      await octokit.rest.repos.createCommitComment({
        owner: ctx.owner,
        repo: ctx.repo,
        commit_sha: ctx.commitSha,
        body,
      });
    }
  } catch (err: unknown) {
    const error = err as { message?: string };
    core.warning(`Failed to post no-spec warning: ${error.message}`);
  }
}

// ─── Context Builder ──────────────────────────────────────────────────────────

function buildContext(): SpecSyncContext {
  const { eventName, payload, repo, sha, ref } = github.context;

  let eventType: EventType = 'unknown';
  let prNumber: number | undefined;

  if (eventName === 'push') {
    eventType = 'push';
  } else if (eventName === 'pull_request') {
    const action = payload.action as string;
    eventType = action === 'closed' ? 'pull_request_closed' : 'pull_request';
    prNumber = payload.pull_request?.number;
  } else if (eventName === 'repository_dispatch') {
    eventType = 'repository_dispatch';
  }

  const branch = ref.replace('refs/heads/', '');

  return {
    eventType,
    owner: repo.owner,
    repo: repo.repo,
    branch,
    commitSha: sha,
    prNumber,
    prMerged: payload.pull_request?.merged,
    specFile: core.getInput('spec-file'),
    specDirectory: core.getInput('spec-directory') || '.specsync/specs',
    testFramework: core.getInput('test-framework') || 'jest',
    testLanguage: core.getInput('test-language') || 'typescript',
    failOnMisalignment: core.getInput('fail-on-misalignment') !== 'false',
    confidenceThreshold: parseInt(core.getInput('confidence-threshold') || '70', 10),
  };
}

// ─── Run ──────────────────────────────────────────────────────────────────────

run();

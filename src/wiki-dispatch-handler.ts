import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { SpecSyncContext } from './types';

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

// ─── Wiki Spec Updated Handler ────────────────────────────────────────────────

interface OpenPR {
  number: number;
  head: { ref: string; sha: string };
  title: string;
  body?: string | null;
}

// Find all open PRs that reference the updated spec pages in their alignment analysis files
export async function findBlockedPRsForSpec(
  octokit: Octokit,
  owner: string,
  repo: string,
  updatedSpecPages: string[]
): Promise<OpenPR[]> {
  core.info(`Searching for PRs blocked on spec pages: ${updatedSpecPages.join(', ')}`);

  const { data: openPRs } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });

  const blockedPRs: OpenPR[] = [];

  for (const pr of openPRs) {
    // Check if this PR's branch has a feature-alignment file
    try {
      const { data: analysisFiles } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: 'feature-alignment',
        ref: pr.head.ref,
      });

      if (!Array.isArray(analysisFiles)) continue;

      // Check if any analysis file references the updated spec pages
      for (const file of analysisFiles) {
        if (!('download_url' in file) || !file.download_url) continue;

        const fileResp = await octokit.request('GET {url}', {
          url: file.download_url,
        });

        const content = typeof fileResp.data === 'string'
          ? fileResp.data
          : JSON.stringify(fileResp.data);

        const referencesUpdatedSpec = updatedSpecPages.some(specPage => {
          const specName = specPage.replace('.md', '');
          return content.toLowerCase().includes(specName.toLowerCase());
        });

        if (referencesUpdatedSpec) {
          blockedPRs.push({
            number: pr.number,
            head: {
              ref: pr.head.ref,
              sha: pr.head.sha,
            },
            title: pr.title,
            body: pr.body,
          });
          break; // Don't double-add the same PR
        }
      }
    } catch {
      // No feature-alignment directory — this PR isn't blocked
    }
  }

  core.info(`Found ${blockedPRs.length} blocked PR(s) referencing updated spec(s)`);
  return blockedPRs;
}

// Handle the wiki-spec-updated repository_dispatch event
export async function handleWikiSpecUpdated(
  octokit: Octokit,
  context: SpecSyncContext,
  clientPayload: {
    spec_pages?: string[];
    wiki_sha?: string;
    updated_by?: string;
  }
): Promise<void> {
  const specPages = clientPayload.spec_pages ?? [];
  const updatedBy = clientPayload.updated_by ?? 'unknown';

  core.info(`Wiki spec update detected by ${updatedBy}: ${specPages.join(', ')}`);

  if (specPages.length === 0) {
    core.warning('No spec pages in wiki-spec-updated payload');
    return;
  }

  // Find PRs blocked on the updated spec pages
  const blockedPRs = await findBlockedPRsForSpec(
    octokit,
    context.owner,
    context.repo,
    specPages
  );

  if (blockedPRs.length === 0) {
    core.info('No blocked PRs found for updated spec pages');
    return;
  }

  // Re-trigger analysis for each blocked PR by dispatching a workflow
  for (const pr of blockedPRs) {
    core.info(`Re-evaluating PR #${pr.number} (${pr.title}) against updated spec`);

    try {
      // Post a comment notifying that re-evaluation is happening
      await octokit.rest.issues.createComment({
        owner: context.owner,
        repo: context.repo,
        issue_number: pr.number,
        body: [
          '<!-- specsync-comment -->',
          '## 🔄 SpecSync — Re-evaluating',
          '',
          `The spec page \`${specPages.join(', ')}\` has been updated by @${updatedBy}.`,
          '',
          'SpecSync is re-running the alignment check on this PR...',
        ].join('\n'),
      });

      // Dispatch a new workflow run for the PR branch
      // This is done by creating a workflow dispatch event targeting the PR branch
      await octokit.rest.actions.createWorkflowDispatch({
        owner: context.owner,
        repo: context.repo,
        workflow_id: 'specsync.yml',
        ref: pr.head.ref,
        inputs: {
          triggered_by: 'wiki-spec-updated',
          pr_number: String(pr.number),
          spec_pages: specPages.join(','),
        },
      });

      core.info(`Dispatched re-evaluation for PR #${pr.number}`);
    } catch (err: unknown) {
      const error = err as { message?: string };
      core.warning(`Failed to re-evaluate PR #${pr.number}: ${error.message}`);
    }
  }
}

// ─── Post-Merge Cleanup ───────────────────────────────────────────────────────

export async function cleanupFeatureAlignmentDir(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string
): Promise<void> {
  core.info(`Cleaning up feature-alignment/ directory from ${branch}`);

  try {
    const { data: contents } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: 'feature-alignment',
      ref: branch,
    });

    if (!Array.isArray(contents)) {
      core.info('feature-alignment/ is not a directory or is empty');
      return;
    }

    for (const file of contents) {
      if (!('sha' in file)) continue;

      await octokit.rest.repos.deleteFile({
        owner,
        repo,
        path: file.path,
        message: '[specsync] cleanup: remove alignment analysis post-merge',
        sha: file.sha,
        branch,
      });

      core.info(`Deleted ${file.path}`);
    }

    core.info('Cleanup complete');
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    if (error.status === 404) {
      core.info('No feature-alignment/ directory found — nothing to clean up');
    } else {
      core.warning(`Cleanup failed: ${error.message}`);
    }
  }
}

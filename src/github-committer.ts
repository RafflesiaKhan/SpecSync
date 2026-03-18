import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';
import { GeneratedTestFile, AnalysisFile } from './types';

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

// ─── Git File Committer ───────────────────────────────────────────────────────
// Uses direct file system + git commands (more reliable in Actions than API)

export async function commitTestFiles(
  files: GeneratedTestFile[],
  branch: string
): Promise<void> {
  if (files.length === 0) {
    core.info('No test files to commit');
    return;
  }

  const paths: string[] = [];

  for (const file of files) {
    const fullPath = path.join(process.cwd(), file.path);
    const dir = path.dirname(fullPath);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, file.content, 'utf-8');

    paths.push(file.path);
    core.info(`Wrote test file: ${file.path}`);
  }

  await gitAddAndCommit(
    paths,
    `[specsync] add ${files.length} test file(s) from spec alignment check`
  );
}

export async function commitAnalysisFile(
  analysis: AnalysisFile
): Promise<void> {
  const fullPath = path.join(process.cwd(), analysis.path);
  const dir = path.dirname(fullPath);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, analysis.content, 'utf-8');

  core.info(`Wrote analysis file: ${analysis.path}`);

  await gitAddAndCommit(
    [analysis.path],
    `[specsync] alignment analysis: ${analysis.prNumber ? `PR #${analysis.prNumber}` : `commit ${analysis.commitSha?.slice(0, 7)}`}`
  );
}

export async function deleteAnalysisFile(
  filePath: string
): Promise<void> {
  const fullPath = path.join(process.cwd(), filePath);

  if (!fs.existsSync(fullPath)) {
    core.info(`Analysis file not found, nothing to delete: ${filePath}`);
    return;
  }

  fs.rmSync(fullPath);
  core.info(`Deleted analysis file: ${filePath}`);

  await gitAddAndCommit(
    [filePath],
    `[specsync] cleanup: remove analysis file on alignment`
  );
}

// ─── Git Helpers ──────────────────────────────────────────────────────────────

async function gitAddAndCommit(filePaths: string[], message: string): Promise<void> {
  // Configure git identity for bot commits
  await exec.exec('git', ['config', 'user.name', 'SpecSync Agent'], { silent: true });
  await exec.exec('git', ['config', 'user.email', 'specsync-bot@github.com'], { silent: true });

  // Stage files
  for (const filePath of filePaths) {
    await exec.exec('git', ['add', filePath], { silent: true });
  }

  // Check if there's anything to commit
  let statusOutput = '';
  await exec.exec('git', ['status', '--porcelain'], {
    listeners: {
      stdout: (data: Buffer) => { statusOutput += data.toString(); },
    },
    silent: true,
    ignoreReturnCode: true,
  });

  if (!statusOutput.trim()) {
    core.info('Nothing to commit — files are unchanged');
    return;
  }

  // Commit
  await exec.exec('git', ['commit', '-m', message], { silent: false });

  // Push to the current branch
  const currentBranch = await getCurrentBranch();

  let pushError = '';
  const exitCode = await exec.exec(
    'git',
    ['push', 'origin', `HEAD:${currentBranch}`],
    {
      listeners: {
        stderr: (data: Buffer) => { pushError += data.toString(); },
      },
      ignoreReturnCode: true,
    }
  );

  if (exitCode !== 0) {
    core.error(`Git push failed: ${pushError}`);
    throw new Error(`Failed to push changes to ${currentBranch}`);
  }

  core.info(`Successfully committed and pushed: ${message}`);
}

async function getCurrentBranch(): Promise<string> {
  // On pull_request events GitHub checks out a detached synthetic merge ref
  // (refs/remotes/pull/N/merge), so `git rev-parse --abbrev-ref HEAD` returns
  // "HEAD" — not a pushable branch name.
  // GITHUB_HEAD_REF is the actual PR source branch; use it when available.
  const headRef = process.env.GITHUB_HEAD_REF;      // pull_request source branch
  const refName = process.env.GITHUB_REF_NAME;      // push branch name
  if (headRef) return headRef;
  if (refName) return refName;

  // Fallback for local runs / other event types
  let branch = '';
  await exec.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    listeners: {
      stdout: (data: Buffer) => { branch += data.toString().trim(); },
    },
    silent: true,
  });
  return branch;
}

// ─── GitHub API-based Committer (fallback for Actions that can't use git CLI) ──

export async function commitFileViaAPI(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  content: string,
  message: string
): Promise<void> {
  const encodedContent = Buffer.from(content).toString('base64');

  // Check if file already exists to get its SHA
  let existingSha: string | undefined;
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: branch,
    });

    if (!Array.isArray(data) && 'sha' in data) {
      existingSha = data.sha;
    }
  } catch {
    // File doesn't exist yet — that's fine
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message,
    content: encodedContent,
    branch,
    sha: existingSha,
    committer: {
      name: 'SpecSync Agent',
      email: 'specsync-bot@github.com',
    },
    author: {
      name: 'SpecSync Agent',
      email: 'specsync-bot@github.com',
    },
  });

  core.info(`Committed via API: ${filePath}`);
}

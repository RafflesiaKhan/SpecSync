import * as exec from '@actions/exec';
import { DiffFile, ParsedDiff } from './types';

// Maps file extensions to language names
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  cpp: 'cpp',
  c: 'c',
  kt: 'kotlin',
  swift: 'swift',
};

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TO_LANGUAGE[ext] ?? 'unknown';
}

// Extract function/method names from a unified diff patch
function extractFunctions(patch: string, language: string): string[] {
  const functions: Set<string> = new Set();

  const patterns: Record<string, RegExp[]> = {
    typescript: [
      /^\+.*(?:async\s+)?function\s+(\w+)/m,
      /^\+.*(?:public|private|protected|static|async)?\s+(\w+)\s*\(/m,
      /^\+.*const\s+(\w+)\s*=\s*(?:async\s*)?\(/m,
      /^\+.*const\s+(\w+)\s*=\s*(?:async\s*)?\w+\s*=>/m,
    ],
    javascript: [
      /^\+.*(?:async\s+)?function\s+(\w+)/m,
      /^\+.*const\s+(\w+)\s*=\s*(?:async\s*)?\(/m,
      /^\+.*const\s+(\w+)\s*=\s*(?:async\s*)?\w+\s*=>/m,
    ],
    python: [
      /^\+\s*(?:async\s+)?def\s+(\w+)/m,
    ],
    java: [
      /^\+.*(?:public|private|protected|static|final).*\s+(\w+)\s*\(/m,
    ],
    go: [
      /^\+func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/m,
    ],
  };

  const langPatterns = patterns[language] ?? patterns.typescript;

  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const pattern of langPatterns) {
      const match = line.match(pattern);
      if (match?.[1] && match[1] !== 'if' && match[1] !== 'for' && match[1] !== 'while') {
        functions.add(match[1]);
      }
    }
  }

  return Array.from(functions);
}

// Extract class names from a unified diff patch
function extractClasses(patch: string, language: string): string[] {
  const classes: Set<string> = new Set();

  const patterns: Record<string, RegExp> = {
    typescript: /^\+.*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m,
    javascript: /^\+.*(?:export\s+)?class\s+(\w+)/m,
    python: /^\+class\s+(\w+)/m,
    java: /^\+.*(?:public|private|abstract)?\s*class\s+(\w+)/m,
    go: /^\+type\s+(\w+)\s+struct/m,
  };

  const pattern = patterns[language] ?? patterns.typescript;

  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const match = line.match(pattern);
    if (match?.[1]) {
      classes.add(match[1]);
    }
  }

  return Array.from(classes);
}

// Parse the raw diff text output from `git diff`
function parseDiffText(rawDiff: string): DiffFile[] {
  const files: DiffFile[] = [];

  // Split by diff file headers
  const fileBlocks = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const block of fileBlocks) {
    const lines = block.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.+) b\/(.+)/);
    if (!headerMatch) continue;

    const filePath = headerMatch[2];

    // Determine status
    let status: DiffFile['status'] = 'modified';
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith('new file mode')) status = 'added';
      else if (line.startsWith('deleted file mode')) status = 'deleted';
      else if (line.startsWith('rename to')) status = 'renamed';
      else if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }

    // Extract the patch (from first @@ line onwards)
    const patchStart = lines.findIndex(l => l.startsWith('@@'));
    const patch = patchStart >= 0 ? lines.slice(patchStart).join('\n') : '';

    const language = detectLanguage(filePath);

    files.push({
      path: filePath,
      status,
      additions,
      deletions,
      patch,
      language,
      functions: extractFunctions(patch, language),
      classes: extractClasses(patch, language),
    });
  }

  return files;
}

// Get the diff between HEAD and HEAD~1 (or against base for PRs)
export async function getDiff(baseSha?: string): Promise<ParsedDiff> {
  let rawDiff = '';
  let errorOutput = '';

  const diffArgs = baseSha
    ? ['diff', `${baseSha}...HEAD`, '--unified=5', '--diff-filter=ACDMR']
    : ['diff', 'HEAD~1', 'HEAD', '--unified=5', '--diff-filter=ACDMR'];

  const exitCode = await exec.exec('git', diffArgs, {
    listeners: {
      stdout: (data: Buffer) => { rawDiff += data.toString(); },
      stderr: (data: Buffer) => { errorOutput += data.toString(); },
    },
    ignoreReturnCode: true,
    silent: true,
  });

  if (exitCode !== 0) {
    // Fallback: diff staged changes or last commit
    await exec.exec('git', ['diff', '--cached', '--unified=5', '--diff-filter=ACDMR'], {
      listeners: {
        stdout: (data: Buffer) => { rawDiff += data.toString(); },
      },
      ignoreReturnCode: true,
      silent: true,
    });
  }

  if (!rawDiff.trim()) {
    // Try to get the last commit diff as last resort
    await exec.exec('git', ['show', '--unified=5', 'HEAD'], {
      listeners: {
        stdout: (data: Buffer) => { rawDiff += data.toString(); },
      },
      ignoreReturnCode: true,
      silent: true,
    });
  }

  const files = parseDiffText(rawDiff);

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const changedPaths = files.map(f => f.path).join(', ');
  const summary = `${files.length} file(s) changed: ${changedPaths}. +${totalAdditions}/-${totalDeletions} lines.`;

  return {
    files,
    totalAdditions,
    totalDeletions,
    summary,
  };
}

// Format diff for Claude prompt — truncate large patches to stay within token limits
export function formatDiffForPrompt(diff: ParsedDiff, maxChars = 20000): string {
  const lines: string[] = [
    `## Git Diff Summary`,
    diff.summary,
    '',
    `## Changed Files`,
  ];

  let charCount = lines.join('\n').length;

  for (const file of diff.files) {
    const fileHeader = [
      '',
      `### ${file.path} (${file.status}, ${file.language})`,
      `Functions changed: ${file.functions.join(', ') || 'none detected'}`,
      `Classes changed: ${file.classes.join(', ') || 'none detected'}`,
      `+${file.additions}/-${file.deletions} lines`,
      '',
      '```diff',
    ].join('\n');

    const truncatedPatch = file.patch.length + charCount > maxChars
      ? file.patch.slice(0, maxChars - charCount - 200) + '\n... [truncated for length]'
      : file.patch;

    const fileBlock = fileHeader + '\n' + truncatedPatch + '\n```';
    charCount += fileBlock.length;

    if (charCount > maxChars) {
      lines.push(`\n[Diff truncated — ${diff.files.length - lines.length} more files not shown]`);
      break;
    }

    lines.push(fileBlock);
  }

  return lines.join('\n');
}

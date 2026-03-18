import * as core from '@actions/core';
import Anthropic from '@anthropic-ai/sdk';
import { ParsedDiff, SpecPage, ImpactRadius, GeneratedTestFile, TestGenerationResult } from './types';
import { formatDiffForPrompt } from './diff-parser';
import { formatSpecForPrompt } from './wiki-reader';
import { callClaudeWithRetry, parseJsonResponse } from './claude-utils';

const TEST_SYSTEM_PROMPT = `You are SpecSync Agent — an expert test engineer.

Your job is to generate comprehensive test files based on a feature specification and code diff.
Tests MUST cover the acceptance criteria from the spec, not just what the code happens to do.

Generate clean, runnable test code. Use the specified test framework and language.
Do NOT add placeholder comments like "TODO: implement" — write real test logic.
Follow the naming convention: describe('<functionName>()', () => { it('should ...') }).

Tests are organized into:
- Unit tests: positive cases (happy path), negative cases (error cases), edge cases
- Integration tests: cross-service interactions (only if impact radius requires it)
- Contract tests: API shape validation (only if endpoints were modified)

Return ONLY a JSON array of test file objects. No prose outside the JSON.`;

const TEST_USER_PROMPT = (
  diffText: string,
  specText: string,
  suggestedTestCases: string[],
  framework: string,
  language: string,
  requiresIntegration: boolean,
  requiresContract: boolean,
  modifiedEndpoints: string[]
) => `
Generate test files for the following code change.

${specText}

---

${diffText}

---

Suggested test cases (from alignment analysis):
${suggestedTestCases.map(t => `- ${t}`).join('\n') || '(none — generate from spec)'}

Requirements:
- Framework: ${framework}
- Language: ${language}
- Generate integration tests: ${requiresIntegration}
- Generate contract tests: ${requiresContract}
${modifiedEndpoints.length > 0 ? `- Modified endpoints: ${modifiedEndpoints.join(', ')}` : ''}

Return a JSON array with this structure:
[
  {
    "path": "tests/unit/feature-name.test.${language === 'typescript' ? 'ts' : language === 'python' ? 'py' : 'js'}",
    "content": "<full test file content as a string>",
    "testCount": <number of it/test blocks>,
    "type": "unit" | "integration" | "contract"
  }
]

Test file requirements:
1. Import necessary testing utilities (jest/vitest/pytest as appropriate)
2. Import the actual modules being tested from their paths (infer from the diff)
3. Group tests in describe blocks per function/class
4. Positive tests: verify the happy path matches spec
5. Negative tests: verify proper error handling as specified
6. Edge case tests: cover edge cases listed in the spec
7. Each test has a clear "should ..." description
8. Mock external dependencies appropriately
`;

// ─── Test Generator ───────────────────────────────────────────────────────────

interface GeneratedTestFileRaw {
  path: string;
  content: string;
  testCount: number;
  type: 'unit' | 'integration' | 'contract';
}

export async function generateTests(
  diff: ParsedDiff,
  specs: SpecPage[],
  impact: ImpactRadius,
  suggestedTestCases: string[],
  anthropicApiKey: string,
  framework: string,
  language: string
): Promise<TestGenerationResult> {
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const diffText = formatDiffForPrompt(diff);
  const specText = specs.map(formatSpecForPrompt).join('\n\n---\n\n');

  core.info('Calling Claude API for test generation...');

  const responseText = await callClaudeWithRetry(client, {
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: TEST_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: TEST_USER_PROMPT(
          diffText,
          specText,
          suggestedTestCases,
          framework,
          language,
          impact.requiresIntegrationTests,
          impact.requiresContractTests,
          impact.modifiedEndpoints
        ),
      },
    ],
  });

  const parsedRaw = parseJsonResponse<GeneratedTestFileRaw | GeneratedTestFileRaw[]>(
    responseText,
    'test-generator'
  );

  const parsed: GeneratedTestFileRaw[] = Array.isArray(parsedRaw)
    ? parsedRaw
    : parsedRaw
    ? [parsedRaw]
    : [];

  if (parsed.length === 0) {
    return { files: [], totalTests: 0, framework, language };
  }

  const files: GeneratedTestFile[] = parsed.map(f => ({
    path: sanitizeTestPath(f.path, language),
    content: f.content,
    testCount: typeof f.testCount === 'number' ? f.testCount : countTestCases(f.content),
    type: f.type ?? 'unit',
  }));

  const totalTests = files.reduce((sum, f) => sum + f.testCount, 0);

  core.info(`Generated ${files.length} test file(s) with ${totalTests} total tests`);

  return { files, totalTests, framework, language };
}

// Ensure test paths are under /tests/ and have correct extension
function sanitizeTestPath(rawPath: string, language: string): string {
  const ext = language === 'python' ? '.py'
    : language === 'javascript' ? '.test.js'
    : '.test.ts';

  // Remove leading slashes
  let p = rawPath.replace(/^\/+/, '');

  // Ensure it's under tests/
  if (!p.startsWith('tests/')) {
    p = `tests/${p}`;
  }

  // Ensure correct extension
  if (!p.endsWith('.ts') && !p.endsWith('.js') && !p.endsWith('.py')) {
    p = p + ext;
  }

  return p;
}

// Count test cases in a file by counting `it(` or `test(` occurrences
function countTestCases(content: string): number {
  const matches = content.match(/^\s*(it|test)\s*\(/gm);
  return matches?.length ?? 0;
}

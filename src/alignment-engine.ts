import * as core from '@actions/core';
import Anthropic from '@anthropic-ai/sdk';
import { ParsedDiff, SpecPage, AlignmentResult, Gap, PendingTest } from './types';
import { formatDiffForPrompt } from './diff-parser';
import { formatSpecForPrompt } from './wiki-reader';
import { callClaudeWithRetry, parseJsonResponse } from './claude-utils';

const ALIGNMENT_SYSTEM_PROMPT = `You are SpecSync Agent — an AI architectural guardrail for software development teams.

Your job is to compare a git diff (code change) against a feature specification and determine whether the code aligns with what was specified.

You MUST respond with valid JSON only. No markdown, no prose outside the JSON structure.

Your analysis must be precise, actionable, and fair. Avoid false positives — if code partially implements a requirement, credit the parts that are done. Identify only genuine gaps.

Focus on:
1. Does the code implement the acceptance criteria?
2. Are there obvious missing pieces that the spec requires?
3. Is the code doing things explicitly listed as out-of-scope?
4. Are edge cases addressed?
5. Do API shapes match the API contracts?

Do NOT flag:
- Code style preferences
- Performance optimizations unless specified
- Patterns that differ from your preference but still satisfy the spec
- Comments or documentation gaps
- Internal implementation details not specified`;

const ALIGNMENT_USER_PROMPT = (diffText: string, specText: string) => `
Analyze the following code change against the feature specification.

${specText}

---

${diffText}

---

Respond with this exact JSON structure:

{
  "verdict": "aligned" | "misaligned" | "partial" | "no-spec",
  "confidence": <number 0-100>,
  "summary": "<one sentence describing the overall alignment status>",
  "alignedCriteria": [<list of acceptance criteria IDs that are fully implemented>],
  "gaps": [
    {
      "criteriaId": <number or null>,
      "description": "<specific gap — what is missing or wrong>",
      "severity": "blocking" | "warning",
      "relatedFile": "<file path if identifiable>",
      "relatedFunction": "<function name if identifiable>"
    }
  ],
  "pendingTests": [
    {
      "description": "<test case description that matches acceptance criteria but can't be written because implementation is missing>",
      "type": "unit-positive" | "unit-negative" | "unit-edge" | "integration" | "contract",
      "blockedReason": "<why this test can't be written yet>"
    }
  ],
  "suggestedTestCases": [
    "<test description for aligned criteria — these will be generated as actual test files>"
  ]
}

Verdicts:
- "aligned": Code fully implements all acceptance criteria. Generate tests.
- "partial": Some criteria are met, some are missing. Block PR, report gaps.
- "misaligned": Code does not implement what was specified, or implements out-of-scope features. Block PR.
- "no-spec": Cannot determine alignment (spec is empty or irrelevant to this diff).
`;

// ─── Claude API Caller ────────────────────────────────────────────────────────

interface ClaudeAlignmentResponse {
  verdict: 'aligned' | 'misaligned' | 'partial' | 'no-spec';
  confidence: number;
  summary: string;
  alignedCriteria: number[];
  gaps: Array<{
    criteriaId?: number;
    description: string;
    severity: 'blocking' | 'warning';
    relatedFile?: string;
    relatedFunction?: string;
  }>;
  pendingTests: Array<{
    description: string;
    type: 'unit-positive' | 'unit-negative' | 'unit-edge' | 'integration' | 'contract';
    blockedReason?: string;
  }>;
  suggestedTestCases: string[];
}

export async function checkAlignment(
  diff: ParsedDiff,
  specs: SpecPage[],
  anthropicApiKey: string,
  confidenceThreshold: number
): Promise<AlignmentResult & { suggestedTestCases: string[] }> {
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const diffText = formatDiffForPrompt(diff);
  const specText = specs.length > 0
    ? specs.map(formatSpecForPrompt).join('\n\n---\n\n')
    : '(No spec provided)';

  core.info('Calling Claude API for alignment check...');
  core.debug(`Diff size: ${diffText.length} chars, Spec size: ${specText.length} chars`);

  const responseText = await callClaudeWithRetry(client, {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: ALIGNMENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: ALIGNMENT_USER_PROMPT(diffText, specText) }],
  });

  const parsed = parseJsonResponse<ClaudeAlignmentResponse>(responseText, 'alignment');
  if (!parsed) {
    return {
      verdict: 'no-spec',
      confidence: 0,
      summary: 'SpecSync could not parse the alignment verdict. Manual review required.',
      gaps: [],
      alignedCriteria: [],
      pendingTests: [],
      suggestedTestCases: [],
    };
  }

  core.info(`Alignment verdict: ${parsed.verdict} (confidence: ${parsed.confidence}%)`);

  // Apply confidence threshold — if too uncertain, treat as no-spec
  const effectiveVerdict = parsed.confidence >= confidenceThreshold
    ? parsed.verdict
    : 'no-spec';

  const gaps: Gap[] = (parsed.gaps ?? []).map(g => ({
    criteriaId: g.criteriaId,
    description: g.description,
    severity: g.severity ?? 'blocking',
    relatedFile: g.relatedFile,
    relatedFunction: g.relatedFunction,
  }));

  const pendingTests: PendingTest[] = (parsed.pendingTests ?? []).map(t => ({
    description: t.description,
    type: t.type ?? 'unit-positive',
    blockedReason: t.blockedReason,
  }));

  const firstSpec = specs[0];

  return {
    verdict: effectiveVerdict,
    confidence: parsed.confidence,
    summary: parsed.summary,
    gaps,
    alignedCriteria: parsed.alignedCriteria ?? [],
    pendingTests,
    specPage: firstSpec?.sourceFile,
    specVersion: firstSpec?.version,
    suggestedTestCases: parsed.suggestedTestCases ?? [],
  };
}

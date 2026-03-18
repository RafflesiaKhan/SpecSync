import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { SpecPage, AcceptanceCriteria, APIContract } from './types';

// ─── Spec Page Parser ─────────────────────────────────────────────────────────

function parseSpecPage(content: string, sourceFile: string): SpecPage {
  const lines = content.split('\n');

  const spec: SpecPage = {
    title: '',
    version: '',
    owner: '',
    lastUpdated: '',
    status: 'active',
    objective: '',
    acceptanceCriteria: [],
    outOfScope: [],
    edgeCases: [],
    integrations: {
      calledBy: [],
      calls: [],
      exposes: [],
    },
    apiContracts: [],
    rawContent: content,
    sourceFile,
  };

  let currentSection = '';
  let objectiveLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Title
    if (line.startsWith('# ')) {
      spec.title = line.replace(/^#\s+/, '').replace('Feature: ', '').trim();
      continue;
    }

    // Frontmatter metadata lines
    if (trimmed.startsWith('**Status:**')) {
      spec.status = trimmed.replace('**Status:**', '').trim();
    } else if (trimmed.startsWith('**Version:**')) {
      spec.version = trimmed.replace('**Version:**', '').trim();
    } else if (trimmed.startsWith('**Owner:**')) {
      spec.owner = trimmed.replace('**Owner:**', '').trim();
    } else if (trimmed.startsWith('**Last Updated:**')) {
      spec.lastUpdated = trimmed.replace('**Last Updated:**', '').trim();
    }

    // Section headings
    if (line.startsWith('## ')) {
      currentSection = line.replace(/^##\s+/, '').toLowerCase();
      continue;
    }
    if (line.startsWith('### ')) {
      // Sub-section within API contracts
      if (currentSection === 'api contract' || currentSection === 'api contracts') {
        const contractHeader = line.replace(/^###\s+/, '').trim();
        const methodMatch = contractHeader.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(.+)/i);
        if (methodMatch) {
          const contract: APIContract = {
            method: methodMatch[1].toUpperCase(),
            path: methodMatch[2].trim(),
            errors: [],
          };

          // Read subsequent lines for input/output/errors
          let j = i + 1;
          while (j < lines.length && !lines[j].startsWith('##')) {
            const subLine = lines[j].trim();
            if (subLine.startsWith('Input:')) {
              contract.input = subLine.replace('Input:', '').trim();
            } else if (subLine.startsWith('Output:')) {
              contract.output = subLine.replace('Output:', '').trim();
            } else if (subLine.match(/^\d{3}\s*—/)) {
              contract.errors.push(subLine);
            }
            j++;
          }

          spec.apiContracts.push(contract);
        }
      }
      continue;
    }

    // Parse section content
    switch (currentSection) {
      case 'objective':
        if (trimmed) objectiveLines.push(trimmed);
        break;

      case 'acceptance criteria': {
        const acMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
        if (acMatch) {
          spec.acceptanceCriteria.push({
            id: parseInt(acMatch[1], 10),
            description: acMatch[2].trim(),
          });
        }
        break;
      }

      case 'out of scope': {
        const bullet = trimmed.replace(/^[-*]\s+/, '');
        if (bullet && bullet !== trimmed.slice(0, 1)) {
          spec.outOfScope.push(bullet);
        } else if (trimmed.match(/^[-*]\s+/)) {
          spec.outOfScope.push(bullet);
        }
        break;
      }

      case 'edge cases': {
        const edgeBullet = trimmed.replace(/^[-*]\s+/, '');
        if (trimmed.match(/^[-*]\s+/)) {
          spec.edgeCases.push(edgeBullet);
        }
        break;
      }

      case 'integrations': {
        if (trimmed.startsWith('- Called by:')) {
          spec.integrations.calledBy = trimmed
            .replace('- Called by:', '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        } else if (trimmed.startsWith('- Calls:')) {
          spec.integrations.calls = trimmed
            .replace('- Calls:', '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        } else if (trimmed.startsWith('- Exposes:')) {
          spec.integrations.exposes = trimmed
            .replace('- Exposes:', '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        }
        break;
      }
    }
  }

  spec.objective = objectiveLines.join(' ');
  return spec;
}

// ─── Phase 1: Flat File Reader ────────────────────────────────────────────────

export async function readSpecFromFile(specFilePath: string): Promise<SpecPage | null> {
  if (!specFilePath || !fs.existsSync(specFilePath)) {
    core.warning(`Spec file not found: ${specFilePath}`);
    return null;
  }

  const content = fs.readFileSync(specFilePath, 'utf-8');
  return parseSpecPage(content, specFilePath);
}

// ─── Spec Directory Reader (multiple spec files) ──────────────────────────────

export async function readSpecsFromDirectory(specDir: string): Promise<SpecPage[]> {
  if (!fs.existsSync(specDir)) {
    core.warning(`Spec directory not found: ${specDir}`);
    return [];
  }

  const files = fs.readdirSync(specDir).filter(f => f.endsWith('.md'));
  const specs: SpecPage[] = [];

  for (const file of files) {
    const filePath = path.join(specDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    specs.push(parseSpecPage(content, filePath));
  }

  return specs;
}

// ─── Phase 2: GitHub Wiki API Reader ─────────────────────────────────────────

export async function readSpecFromWiki(
  octokit: ReturnType<typeof import('@actions/github').getOctokit>,
  owner: string,
  repo: string,
  pageTitle: string
): Promise<SpecPage | null> {
  try {
    // GitHub Wiki API endpoint for a specific page
    const response = await octokit.request(
      'GET /repos/{owner}/{repo}/wiki/pages/{title}',
      {
        owner,
        repo,
        title: pageTitle,
        headers: {
          Accept: 'application/vnd.github+json',
        },
      }
    );

    const data = response.data as { content?: string; body?: string };
    const content = data.content ?? data.body ?? '';
    const decoded = Buffer.isBuffer(content) ? content.toString('utf-8') : content;

    return parseSpecPage(decoded, `wiki:${pageTitle}`);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    if (error.status === 404) {
      core.warning(`Wiki page not found: ${pageTitle}`);
    } else {
      core.warning(`Failed to read wiki page ${pageTitle}: ${error.message}`);
    }
    return null;
  }
}

// ─── Spec Matcher ─────────────────────────────────────────────────────────────

// Given a list of changed files, guess which spec pages are relevant
export function matchSpecsToFiles(
  specs: SpecPage[],
  changedFilePaths: string[]
): SpecPage[] {
  if (specs.length === 0) return [];
  if (specs.length === 1) return specs; // Phase 1: single spec file

  const matched = new Set<SpecPage>();

  for (const spec of specs) {
    const titleLower = spec.title.toLowerCase();
    const sourceLower = (spec.sourceFile ?? '').toLowerCase();

    for (const filePath of changedFilePaths) {
      const pathLower = filePath.toLowerCase();

      // Match by common keywords in the path vs spec title
      const titleWords = titleLower.split(/[\s-_]+/).filter(w => w.length > 3);
      for (const word of titleWords) {
        if (pathLower.includes(word)) {
          matched.add(spec);
          break;
        }
      }

      // Match by spec source file name vs changed file path
      if (sourceLower && pathLower.includes(sourceLower.replace('.md', ''))) {
        matched.add(spec);
      }
    }
  }

  // If no match found, return all specs (let Claude figure out relevance)
  return matched.size > 0 ? Array.from(matched) : specs;
}

// ─── Spec Formatter ───────────────────────────────────────────────────────────

export function formatSpecForPrompt(spec: SpecPage): string {
  const sections: string[] = [
    `## Feature Spec: ${spec.title}`,
    `**Version:** ${spec.version || 'unversioned'}`,
    `**Status:** ${spec.status}`,
    spec.owner ? `**Owner:** ${spec.owner}` : '',
    '',
    '### Objective',
    spec.objective || '(not specified)',
    '',
    '### Acceptance Criteria',
  ];

  if (spec.acceptanceCriteria.length > 0) {
    for (const ac of spec.acceptanceCriteria) {
      sections.push(`${ac.id}. ${ac.description}`);
    }
  } else {
    sections.push('(no acceptance criteria defined)');
  }

  if (spec.edgeCases.length > 0) {
    sections.push('', '### Edge Cases');
    for (const ec of spec.edgeCases) {
      sections.push(`- ${ec}`);
    }
  }

  if (spec.outOfScope.length > 0) {
    sections.push('', '### Out of Scope');
    for (const oos of spec.outOfScope) {
      sections.push(`- ${oos}`);
    }
  }

  if (spec.apiContracts.length > 0) {
    sections.push('', '### API Contracts');
    for (const contract of spec.apiContracts) {
      sections.push(`- ${contract.method} ${contract.path}`);
      if (contract.input) sections.push(`  Input: ${contract.input}`);
      if (contract.output) sections.push(`  Output: ${contract.output}`);
      for (const err of contract.errors) {
        sections.push(`  Error: ${err}`);
      }
    }
  }

  return sections.filter(s => s !== '').join('\n');
}

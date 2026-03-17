// ─── Git Diff Types ───────────────────────────────────────────────────────────

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
  language: string;
  functions: string[];
  classes: string[];
}

export interface ParsedDiff {
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  summary: string;
}

// ─── Spec Types ───────────────────────────────────────────────────────────────

export interface AcceptanceCriteria {
  id: number;
  description: string;
}

export interface SpecPage {
  title: string;
  version: string;
  owner: string;
  lastUpdated: string;
  status: string;
  objective: string;
  acceptanceCriteria: AcceptanceCriteria[];
  outOfScope: string[];
  edgeCases: string[];
  integrations: {
    calledBy: string[];
    calls: string[];
    exposes: string[];
  };
  apiContracts: APIContract[];
  rawContent: string;
  sourceFile?: string;
}

export interface APIContract {
  method: string;
  path: string;
  input?: string;
  output?: string;
  errors: string[];
}

// ─── Alignment Types ──────────────────────────────────────────────────────────

export type AlignmentVerdict = 'aligned' | 'misaligned' | 'no-spec' | 'partial';

export interface Gap {
  criteriaId?: number;
  description: string;
  severity: 'blocking' | 'warning';
  relatedFile?: string;
  relatedFunction?: string;
}

export interface PendingTest {
  description: string;
  type: 'unit-positive' | 'unit-negative' | 'unit-edge' | 'integration' | 'contract';
  blockedReason?: string;
}

export interface AlignmentResult {
  verdict: AlignmentVerdict;
  confidence: number; // 0-100
  summary: string;
  gaps: Gap[];
  alignedCriteria: number[];
  pendingTests: PendingTest[]; // tests that can't be written until gaps are fixed
  specPage?: string;
  specVersion?: string;
}

// ─── Impact Mapper Types ──────────────────────────────────────────────────────

export interface ImportEdge {
  from: string;
  to: string;
  symbols: string[];
}

export interface ImpactRadius {
  directFiles: string[];
  transitiveFiles: string[];
  affectedServices: string[];
  modifiedEndpoints: string[];
  requiresIntegrationTests: boolean;
  requiresContractTests: boolean;
}

// ─── Test Generation Types ────────────────────────────────────────────────────

export interface GeneratedTestFile {
  path: string;
  content: string;
  testCount: number;
  type: 'unit' | 'integration' | 'contract';
}

export interface TestGenerationResult {
  files: GeneratedTestFile[];
  totalTests: number;
  framework: string;
  language: string;
}

// ─── Analysis Types ───────────────────────────────────────────────────────────

export interface AnalysisFile {
  path: string;
  content: string;
  prNumber?: number;
  commitSha?: string;
}

// ─── GitHub Context Types ─────────────────────────────────────────────────────

export type EventType =
  | 'push'
  | 'pull_request'
  | 'pull_request_closed'
  | 'repository_dispatch'
  | 'unknown';

export interface SpecSyncContext {
  eventType: EventType;
  owner: string;
  repo: string;
  branch: string;
  commitSha: string;
  prNumber?: number;
  prMerged?: boolean;
  wikiSpecPages?: string[];
  wikiSha?: string;
  specFile: string;
  specDirectory: string;
  testFramework: string;
  testLanguage: string;
  failOnMisalignment: boolean;
  confidenceThreshold: number;
}

// ─── PR Reporter Types ────────────────────────────────────────────────────────

export interface CheckResult {
  title: string;
  summary: string;
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';
  details: string;
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { jsonrepair } from 'jsonrepair';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  agentSpecSchema,
  mapWithConcurrency,
  FRAMEWORK_PATTERNS,
  type FormSchema,
} from '@haive/shared';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { RetryableParseError } from '../../step-definition.js';
import type { AgentColor, AgentSpec } from './_agent-templates.js';
import { resolveParallelCap } from '../../_parallel-cap.js';
import { extractFencedJson } from '../_fenced-json.js';
import {
  countFilesMatching,
  listFilesMatching,
  pathExists,
  resolveConfirmedProject,
} from './_helpers.js';
import {
  FILE_COUNT_THRESHOLD,
  buildTechInventory,
  renderTechInventoryTable,
  type TechInventory,
} from './_tech-inventory.js';
import { noSubagentInstructionLines, readComposerJson } from './_scope.js';
import { composerExcludeDirs } from './_scope-seed.js';

export interface AgentCandidate {
  id: string;
  label: string;
  hint: string;
  count: number;
  recommended: boolean;
  /** 'scan' for deterministic file-pattern matches, 'llm' for AI-suggested,
   *  'bundle' for items pulled in from a custom user bundle. */
  source?: 'scan' | 'llm' | 'bundle';
  /** Full structured body; set for LLM-generated and bundle-sourced agents. */
  body?: AgentSpec;
  /** Why the model set this agent to NOT recommended, shown under its checkbox.
   *  A box that silently unticks itself is the same complaint the Tier-1 safety net
   *  had: a decision with no visible reason. Only set when the model declined it —
   *  a recommended agent needs no justification. */
  declineReason?: string;
}

export interface AgentDiscoveryDetect {
  candidates: AgentCandidate[];
  framework: string | null;
  language: string | null;
  /** Transient — file tree for LLM prompt, stripped before persisting. */
  __fileTree?: string;
  /** Transient — secondary tech inventory, stripped before persisting. */
  __techInventory?: TechInventory;
}

export interface AgentDiscoveryApply {
  accepted: AgentCandidate[];
  declined: AgentCandidate[];
}

const THRESHOLD = 5;

/* ------------------------------------------------------------------ */
/* Baseline agents (always offered, recommended by default)            */
/* ------------------------------------------------------------------ */

export const BASELINE_AGENT_DEFS: { id: string; label: string; hint: string }[] = [
  {
    id: 'code-reviewer',
    label: 'Code reviewer',
    hint: 'reviews code changes for correctness and style',
  },
  { id: 'test-writer', label: 'Test writer', hint: 'writes and maintains automated tests' },
  { id: 'docs-writer', label: 'Docs writer', hint: 'curates project documentation' },
  {
    id: 'refactorer',
    label: 'Refactorer',
    hint: 'performs safe refactoring without changing behavior',
  },
  {
    id: 'migration-author',
    label: 'Migration author',
    hint: 'owns database migrations and schema evolution',
  },
  {
    id: 'api-route-dev',
    label: 'API route developer',
    hint: 'owns HTTP handlers and route definitions',
  },
  { id: 'config-manager', label: 'Config manager', hint: 'owns YAML/TOML configuration files' },
  { id: 'security-auditor', label: 'Security auditor', hint: 'scans for common security issues' },
  {
    id: 'knowledge-miner',
    label: 'Knowledge miner',
    hint: 'mines codebase for patterns worth recording',
  },
  {
    id: 'learning-recorder',
    label: 'Learning recorder',
    hint: 'records lessons learned from workflow runs',
  },
  {
    id: 'integration-tester',
    label: 'Integration tester',
    hint: 'browser-tests UI flows + visual theme fit via Chrome DevTools MCP',
  },
  {
    id: 'code-tracer',
    label: 'Code tracer',
    hint: 'maps callers, callees, and the blast radius of a change',
  },
  {
    id: 'peer-reviewer',
    label: 'Peer reviewer',
    hint: 'constructive code-quality review with severities and positives',
  },
  {
    id: 'security-code-reviewer',
    label: 'Security code reviewer',
    hint: 'diff-focused security review: injection, access control, data exposure',
  },
  {
    id: 'operational-reviewer',
    label: 'Operational reviewer',
    hint: 'observability, rollback, migration safety, backward compatibility, docs',
  },
  {
    id: 'performance-reviewer',
    label: 'Performance reviewer',
    hint: 'N+1 queries, indexes, hot-path blocking IO, concurrency, payload size',
  },
  {
    id: 'pattern-replicator',
    label: 'Pattern replicator',
    hint: 'extracts an existing pattern so new code matches it ("implement X like Y")',
  },
  {
    id: 'markdown-humanizer',
    label: 'Markdown humanizer',
    hint: 'rewrites dense docs into clear prose, preserving language and grammar',
  },
  {
    id: 'auth-bandit',
    label: 'Auth bandit',
    hint: 'adversarial auth-bypass, privilege-escalation, and IDOR testing',
  },
  {
    id: 'chaos-creator',
    label: 'Chaos creator',
    hint: 'resilience testing: partial failures, timeouts, graceful degradation',
  },
  {
    id: 'edge-case-breaker',
    label: 'Edge case breaker',
    hint: 'boundary, null, type-confusion, and extreme-input testing',
  },
  {
    id: 'injection-infector',
    label: 'Injection infector',
    hint: 'SQL/XSS/command/template injection hunting',
  },
  {
    id: 'logic-lunatic',
    label: 'Logic lunatic',
    hint: 'business-logic abuse and workflow-bypass testing',
  },
  {
    id: 'workflow-disruptor',
    label: 'Workflow disruptor',
    hint: 'race conditions, state corruption, and concurrency testing',
  },
  {
    id: 'business-requirements-writer',
    label: 'Business requirements writer',
    hint: 'non-technical requirements doc, written in the input language',
  },
  {
    id: 'spec-quality-reviewer',
    label: 'Spec quality reviewer',
    hint: '14-dimension spec audit with ambiguity hunt and a clear verdict',
  },
  {
    id: 'accessibility-specialist',
    label: 'Accessibility specialist',
    hint: 'WCAG/ARIA/semantic-HTML audit and accessibility requirements',
  },
  {
    id: 'technical-spec-writer',
    label: 'Technical spec writer',
    hint: 'consolidates findings into an actionable technical spec with acceptance criteria',
  },
];

/* ------------------------------------------------------------------ */
/* File-scan patterns (boost recommendation for scannable agents)      */
/* ------------------------------------------------------------------ */

interface Pattern {
  id: string;
  predicate: (rel: string, isDir: boolean) => boolean;
  requireDir?: string;
}

const TEST_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|php|py)$/i;
const REACT_COMPONENT_RE = /\.(tsx|jsx)$/;

const SCAN_PATTERNS: Pattern[] = [
  { id: 'test-writer', predicate: (rel, isDir) => !isDir && TEST_RE.test(rel) },
  {
    id: 'migration-author',
    predicate: (rel, isDir) => {
      if (isDir) return false;
      return (
        rel.startsWith('migrations/') ||
        rel.startsWith('db/migrate/') ||
        rel.startsWith('database/migrations/') ||
        rel.startsWith('prisma/migrations/')
      );
    },
  },
  {
    id: 'api-route-dev',
    predicate: (rel, isDir) => {
      if (isDir) return false;
      return (
        rel.startsWith('app/api/') ||
        rel.startsWith('src/routes/') ||
        rel.startsWith('routes/') ||
        rel.startsWith('src/api/') ||
        rel.startsWith('pages/api/')
      );
    },
  },
  {
    id: 'docs-writer',
    predicate: (rel, isDir) => {
      if (isDir) return false;
      if (!rel.endsWith('.md') && !rel.endsWith('.rst')) return false;
      return rel.startsWith('docs/') || rel.startsWith('documentation/');
    },
  },
  {
    id: 'config-manager',
    predicate: (rel, isDir) => {
      if (isDir) return false;
      return (
        (rel.endsWith('.yml') || rel.endsWith('.yaml') || rel.endsWith('.toml')) &&
        (rel.startsWith('config/') || rel.includes('/config/'))
      );
    },
  },
];

/* ------------------------------------------------------------------ */
/* Framework-specific agents                                           */
/* ------------------------------------------------------------------ */

interface FrameworkAgent {
  id: string;
  label: string;
  hint: string;
  pattern?: Pattern;
}

const FRAMEWORK_AGENTS: Record<string, FrameworkAgent[]> = {
  drupal7: [
    {
      id: 'drupal7-module-dev',
      label: 'Drupal 7 module developer',
      hint: 'owns .module and .install files and hook implementations',
      pattern: {
        id: 'drupal7-module-dev',
        predicate: (rel, isDir) => !isDir && (rel.endsWith('.module') || rel.endsWith('.install')),
      },
    },
  ],
  drupal: [
    {
      id: 'drupal-module-dev',
      label: 'Drupal module developer',
      hint: 'owns module hooks, services, and plugins',
      pattern: {
        id: 'drupal-module-dev',
        predicate: (rel, isDir) => !isDir && (rel.endsWith('.module') || rel.endsWith('.install')),
      },
    },
  ],
  nextjs: [
    {
      id: 'react-component-dev',
      label: 'React component developer',
      hint: 'owns .tsx/.jsx components',
      pattern: {
        id: 'react-component-dev',
        predicate: (rel, isDir) => {
          if (isDir) return false;
          if (!REACT_COMPONENT_RE.test(rel)) return false;
          return (
            rel.startsWith('src/components/') ||
            rel.startsWith('components/') ||
            rel.startsWith('app/')
          );
        },
      },
    },
  ],
  nodejs: [
    {
      id: 'node-package-dev',
      label: 'Node.js package developer',
      hint: 'owns Node.js source files under src/',
    },
    {
      id: 'react-component-dev',
      label: 'React component developer',
      hint: 'owns .tsx/.jsx components',
      pattern: {
        id: 'react-component-dev',
        predicate: (rel, isDir) => {
          if (isDir) return false;
          if (!REACT_COMPONENT_RE.test(rel)) return false;
          return rel.startsWith('src/components/') || rel.startsWith('components/');
        },
      },
    },
  ],
  django: [
    {
      id: 'django-model-dev',
      label: 'Django model developer',
      hint: 'owns models.py files and their migrations',
      pattern: {
        id: 'django-model-dev',
        predicate: (rel, isDir) => !isDir && rel.endsWith('models.py'),
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Scanning                                                            */
/* ------------------------------------------------------------------ */

async function scanPattern(repo: string, pattern: Pattern): Promise<number> {
  if (pattern.requireDir) {
    const dir = path.join(repo, pattern.requireDir);
    if (!(await pathExists(dir))) return 0;
  }
  return countFilesMatching(repo, pattern.predicate, 5);
}

export async function discoverAgentCandidates(
  repo: string,
  framework: string | null,
): Promise<AgentCandidate[]> {
  // Scan file patterns to get match counts
  const fwAgents = framework && FRAMEWORK_AGENTS[framework] ? FRAMEWORK_AGENTS[framework] : [];
  const allPatterns = [
    ...SCAN_PATTERNS,
    ...fwAgents.filter((a) => a.pattern).map((a) => a.pattern!),
  ];
  const seen = new Set<string>();
  const uniquePatterns = allPatterns.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  const scanResults = await mapWithConcurrency(
    uniquePatterns,
    await resolveParallelCap(),
    async (p) => ({ id: p.id, count: await scanPattern(repo, p) }),
  );
  const countById = new Map(scanResults.map((r) => [r.id, r.count]));

  // Build candidate list: baselines first, then framework-specific
  const candidates: AgentCandidate[] = [];
  const usedIds = new Set<string>();

  for (const def of BASELINE_AGENT_DEFS) {
    const count = countById.get(def.id) ?? 0;
    candidates.push({
      id: def.id,
      label: def.label,
      hint: def.hint,
      count,
      recommended: true, // baselines always recommended
    });
    usedIds.add(def.id);
  }

  for (const fa of fwAgents) {
    if (usedIds.has(fa.id)) continue;
    const count = countById.get(fa.id) ?? 0;
    candidates.push({
      id: fa.id,
      label: fa.label,
      hint: fa.hint,
      count,
      recommended: count >= THRESHOLD || true, // framework agents always recommended
    });
    usedIds.add(fa.id);
  }

  return candidates;
}

/* ------------------------------------------------------------------ */
/* File tree + key file collection for LLM context                     */
/* ------------------------------------------------------------------ */

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.ddev',
]);

async function collectFileTree(repoPath: string): Promise<string> {
  const files = await listFilesMatching(
    repoPath,
    (rel, isDir) => {
      const parts = rel.split('/');
      if (parts.some((p) => IGNORE_DIRS.has(p))) return false;
      if (isDir) return false;
      return true;
    },
    4,
  );
  // Cap at 500 lines to keep prompt reasonable
  const capped = files.slice(0, 500);
  const tree = capped.join('\n');
  return capped.length < files.length
    ? tree + `\n[...truncated, ${files.length - capped.length} more files]`
    : tree;
}

async function readTextSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function collectKeyFiles(repoPath: string): Promise<string> {
  const candidates = [
    'package.json',
    'composer.json',
    'README.md',
    'pyproject.toml',
    'Cargo.toml',
    'Gemfile',
    'go.mod',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'gradle.properties',
    'pom.xml',
    'mix.exs',
    'Pipfile',
    'requirements.txt',
    'Dockerfile',
  ];
  const parts: string[] = [];
  for (const name of candidates) {
    const content = await readTextSafe(path.join(repoPath, name));
    if (content !== null) {
      const truncated =
        content.length > 3000 ? content.slice(0, 3000) + '\n[...truncated]' : content;
      parts.push(`--- ${name} ---\n${truncated}`);
    }
  }
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* LLM prompt + parse                                                  */
/* ------------------------------------------------------------------ */

export interface LlmCustomAgentBody {
  title?: string;
  description?: string;
  color?: AgentColor;
  field?: string;
  tools?: string[];
  coreMission?: string;
  responsibilities?: string[];
  whenInvoked?: string[];
  executionSteps?: { title: string; body: string }[];
  outputFormat?: string;
  qualityCriteria?: string[];
  antiPatterns?: string[];
}

interface LlmAgentSuggestion {
  id: string;
  label: string;
  hint: string;
  recommended: boolean;
  body?: LlmCustomAgentBody;
}

/** Categories whose specialist agent always pays off — non-trivial DSL,
 *  protocol, or surface that benefits from focused expertise. Used both by
 *  the LLM prompt (to mark Tier 1 rows) and by the post-LLM safety net (to
 *  inject any Tier 1 row the LLM dropped). */
const MANDATORY_CATEGORIES: ReadonlySet<string> = new Set([
  'build',
  'framework',
  'db',
  'orm',
  'graphics',
  'queue',
  'search',
  'pdf',
  'api',
]);

/** Per-agent and total budgets for the imported bodies below.
 *
 *  Bounded because a bundle can hold many agents and a single imported body is a whole
 *  markdown document — MEASURED, one Drupal reviewer agent's body is 5.8k chars on its own.
 *  Both caps state their elision in the prompt rather than trimming silently, the same rule
 *  the fan-out summary budget follows. */
const BUNDLE_BODY_CHARS = 1_500;
const BUNDLE_BODY_TOTAL_CHARS = 6_000;

/** The bodies of bundle-sourced agents, so "judge it by its BODY" is answerable.
 *
 *  The instruction to judge an imported agent by its body rather than its name predates
 *  anything supplying one: candidates rendered as `id: label — hint`, and `AgentCandidate.
 *  body` — populated for exactly these — was never written into the prompt. MEASURED on a
 *  live run, the model was handed `drupal-reviewer: These MUST pass before committing —
 *  Expert Drupal code reviewer…` and declined it, saying no agent body was supplied and a
 *  commit-gate description alone could not establish Drupal 7 compatibility. It was right;
 *  the three other CLIs accepted the same agent on the same non-evidence. */
function renderBundleAgentBodies(candidates: readonly AgentCandidate[]): string[] {
  const bundled = candidates.filter((c) => c.source === 'bundle' && c.body);
  if (bundled.length === 0) return [];
  const lines: string[] = [
    '## Imported agent bodies (from your custom bundles)',
    '',
    'These are the FULL definitions behind the bundle-sourced rows above — judge them on this,',
    'not on their name or one-line description. A bundle the user imported may still describe',
    'work this repository does not do; say so in `declined` with the reason if it does.',
    '',
  ];
  let spent = 0;
  let omitted = 0;
  for (const c of bundled) {
    if (spent >= BUNDLE_BODY_TOTAL_CHARS) {
      omitted++;
      continue;
    }
    const mission = (c.body?.coreMission ?? '').trim();
    const slice =
      mission.length > BUNDLE_BODY_CHARS ? mission.slice(0, BUNDLE_BODY_CHARS) : mission;
    spent += slice.length;
    lines.push(
      `### ${c.id}`,
      c.body?.description ? `Description: ${c.body.description}` : '',
      slice.length > 0 ? slice : '(this bundle item carries no body text)',
      mission.length > slice.length
        ? `[body truncated at ${BUNDLE_BODY_CHARS} of ${mission.length} chars — judge on what is shown]`
        : '',
      '',
    );
  }
  if (omitted > 0) {
    lines.push(
      `[${omitted} further imported ${omitted === 1 ? 'body' : 'bodies'} omitted for length — treat those rows as unverified and say so if you decline them]`,
      '',
    );
  }
  return lines.filter((l) => l !== '');
}

export function buildAgentDiscoveryPrompt(args: LlmBuildArgs): string {
  const detected = args.detected as AgentDiscoveryDetect;
  const fileTree = detected.__fileTree ?? '(no file tree)';
  const inventory = detected.__techInventory ?? { items: [], scannedManifests: [] };

  const predefinedList = detected.candidates
    .map((c) => `- ${c.id}: ${c.label} — ${c.hint} (${c.count} matching files)`)
    .join('\n');

  const baselineIds = new Set(detected.candidates.map((c) => c.id));
  const inventoryNotInBaseline = inventory.items.filter(
    (it) => !baselineIds.has(`${it.name}-specialist`) && !baselineIds.has(it.name),
  );
  const inventoryTable = renderTechInventoryTable(inventory);
  const mandatoryItems = inventoryNotInBaseline.filter((it) =>
    MANDATORY_CATEGORIES.has(it.category),
  );
  const optionalItems = inventoryNotInBaseline.filter(
    (it) => !MANDATORY_CATEGORIES.has(it.category),
  );
  const formatRow = (it: TechInventory['items'][number]): string =>
    `- ${it.displayName} (${it.category}, ${it.fileCount} files, manifests: ${it.manifests.join(', ') || 'source-only'}) → suggested agent id: \`${it.name}-specialist\``;
  const mandatoryList =
    mandatoryItems.length === 0
      ? '(none — every mandatory-tier technology is already covered by a predefined agent)'
      : mandatoryItems.map(formatRow).join('\n');
  const optionalList =
    optionalItems.length === 0 ? '(none)' : optionalItems.map(formatRow).join('\n');

  return [
    'You are analysing a software repository to recommend which Claude Code subagents should be created for it.',
    '',
    '## Agents vs skills — IMPORTANT',
    'AGENTS = technical / framework expertise (how to write a Drupal hook, how to use TCPDF, how to query PostgreSQL with CTEs, how to call LWJGL OpenGL bindings).',
    'SKILLS = business / domain knowledge (what an "inspection" is, the order-fulfilment state machine, which fields belong to which form).',
    'That split governs the agents YOU PROPOSE: do not invent a custom agent whose value would come from understanding business entities, workflows, or domain rules — those become skills in a later step.',
    'It does NOT govern the predefined list below. Those are curated roles that already earned their place, and several work ON business-facing material by design — a requirements writer produces prose for stakeholders, an adversary attacks business-logic flaws. Judge each on whether THIS project has that work to do, never on whether the role sounds technical enough. Some are dispatched BY NAME by a later workflow step, so declining one removes a tuned definition that step would otherwise use and falls back to a generic persona.',
    'Judge each predefined agent on its own. Declining one is not a reason to decline another that touches the same subject.',
    '',
    ...noSubagentInstructionLines(),
    '## Project info',
    `Framework: ${detected.framework ?? 'unknown'}`,
    `Language: ${detected.language ?? 'unknown'}`,
    '',
    '## Repository file tree',
    '```',
    fileTree,
    '```',
    '',
    '## Key config files',
    (args.detected as { __keyFiles?: string }).__keyFiles ?? '(none)',
    '',
    '## Predefined agents (from deterministic scan)',
    predefinedList,
    '',
    ...renderBundleAgentBodies(detected.candidates),
    `## Secondary technology inventory (deterministic dep scan + import grep, threshold ${FILE_COUNT_THRESHOLD}+ files for non-framework categories)`,
    inventoryTable,
    '',
    '### Tier 1 — REQUIRED specialists (build / framework / db / orm / graphics / queue / search / pdf / api)',
    `Each row below is a candidate surface that may benefit from focused expertise. Emit a \`<name>-specialist\` custom agent for every row unless you can say WHY it does not deserve one, and put every such row in \`skipped\` with its reason. The scanner's bar is only ${FILE_COUNT_THRESHOLD} referencing files, so a row can be a dependency of a dependency rather than something this project works in — judge from the file tree, not from the row's presence. Two reasons are worth stating explicitly when they apply: the row is already covered by a predefined agent above, or its matches are third-party code (a vendored library, a bundled polyfill, contrib) rather than code maintained here. Do NOT skip on a bare "boilerplate" or "common knowledge" label with no evidence.`,
    mandatoryList,
    '',
    '### Tier 2 — OPTIONAL specialists (http / css / state / auth / logging / testing / other)',
    'Propose a `<name>-specialist` for any row where the project clearly customises beyond standard usage (custom logging pipelines, complex Tailwind themes, multi-strategy auth). Skip rows where general developer knowledge plus the predefined agents cover it. Briefly note your reasoning when skipping.',
    optionalList,
    '',
    '## Instructions',
    '1. Review the file tree, key config files, and the technology inventory above.',
    '2. For each predefined agent, decide if it is relevant to this project (true/false). For every one you set to FALSE, add an entry to `declined` saying why — it stays on the form as an unticked box, and without a reason the user is left guessing. Judge a bundle-sourced agent by its BODY, not its name: a bundle the user imported may still describe work this repository does not do.',
    '3. Apply the Tier 1 / Tier 2 rules above when emitting custom agents. Every Tier 1 row must appear in EXACTLY ONE of `custom` or `skipped`. Put a row in `skipped` ONLY when you are not emitting it — `skipped` is the rejection list, not a place to note what you did, and an entry saying "not skipped, emitted below" contradicts itself. A row you leave out of BOTH is read as an oversight and re-added for you, so a deliberate omission survives only if it is in `skipped`.',
    '4. You MAY suggest additional technical agents not in the inventory if the file tree or config files show another framework/library/tool with non-trivial usage that the inventory missed.',
    '5. Do NOT propose agents for business domain concepts (entities, workflows, validation rules, UI flows specific to this app). Those become skills.',
    '6. For each custom agent, provide a FULL structured body with the following fields, tailored to this repository:',
    '   - title: Human-friendly title (Title Case).',
    '   - description: One-line description.',
    '   - color: one of blue, purple, green, gold, red, orange.',
    '   - field: short domain label (e.g. backend, frontend, quality, security, database, graphics, build).',
    '   - tools: subset of [Read, Edit, Write, Grep, Glob, Bash] relevant to the role.',
    '   - coreMission: 1-2 sentences — what this agent exists to do.',
    '   - responsibilities: 3-5 bullets. Each starts with a bolded noun phrase in **double asterisks**, then an em dash, then the explanation.',
    '   - whenInvoked: 2-4 concrete trigger conditions.',
    '   - executionSteps: 3-5 ordered steps, each as { title, body }. The body is one sentence minimum; ground it in this specific repo and this specific technology.',
    '   - outputFormat: a code-block (triple-backtick fenced) showing the structured shape the agent should emit.',
    '   - qualityCriteria: 3-5 bullets describing verifiable post-conditions.',
    '   - antiPatterns: 3-5 bullets describing what this agent MUST NOT do (each a concrete failure mode, not generic advice).',
    '7. Ground every custom agent in THIS repository: across its body, cite at least TWO real paths copied from the file tree above (a directory or a file). An agent whose body would read the same for any project using that technology has not been tailored to this one.',
    '',
    '## Required output format',
    'Emit exactly ONE JSON object inside a ```json fenced code block:',
    '```',
    '{',
    '  "predefined": {',
    '    "<agent-id>": true|false',
    '  },',
    '  "skipped": [',
    '    { "id": "<inventory-row-agent-id>", "reason": "why this row needs no specialist" }',
    '  ],',
    '  "declined": [',
    '    { "id": "<predefined-agent-id>", "reason": "why it is not a fit for THIS repository" }',
    '  ],',
    '  "custom": [',
    '    {',
    '      "id": "my-agent",',
    '      "label": "My agent",',
    '      "hint": "does X",',
    '      "recommended": true,',
    '      "body": {',
    '        "title": "My Agent",',
    '        "description": "One-line description.",',
    '        "color": "blue",',
    '        "field": "backend",',
    '        "tools": ["Read", "Edit", "Write", "Grep", "Glob", "Bash"],',
    '        "coreMission": "...",',
    '        "responsibilities": ["**Thing** — explanation", "..."],',
    '        "whenInvoked": ["trigger 1", "trigger 2"],',
    '        "executionSteps": [ { "title": "Step name", "body": "Step detail." } ],',
    '        "outputFormat": "```\\n<schema>\\n```",',
    '        "qualityCriteria": ["check 1", "check 2"],',
    '        "antiPatterns": ["failure mode 1", "failure mode 2"]',
    '      }',
    '    }',
    '  ]',
    '}',
    '```',
    'Valid JSON only: escape every literal double-quote inside a string value as \\" (and every backslash as \\\\). One unescaped " truncates the JSON and the whole output is rejected — code snippets are the usual offender (write `custom=\\"1\\"`, not `custom="1"`).',
    'Do not emit any prose outside the fenced block. The body field is REQUIRED for every custom agent.',
  ].join('\n');
}

export interface AgentParseDiagnostic {
  parseError: string;
  bodyLength: number;
  errorPosition: number;
  snippet: string;
  /** True when the result was salvaged via jsonrepair after strict JSON.parse failed. */
  repaired?: boolean;
}

interface ParseAgentBodyOpts {
  /** When true (post-jsonrepair), reject results where every field is wrong
   *  shape (e.g. `predefined` came back as a string from a salvaged garbage
   *  fragment). For strict-parse callers, accept normalised empty defaults. */
  rejectAllWrongShapes?: boolean;
}

function parseAgentBody(
  candidate: string,
  opts: ParseAgentBodyOpts = {},
): {
  predefined: Record<string, boolean>;
  custom: LlmAgentSuggestion[];
  skipped: SkippedInventoryRow[];
  declined: SkippedInventoryRow[];
} | null {
  const obj = JSON.parse(candidate) as Record<string, unknown>;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const predefinedIsObject =
    obj.predefined !== undefined &&
    obj.predefined !== null &&
    typeof obj.predefined === 'object' &&
    !Array.isArray(obj.predefined);
  const customIsArray = Array.isArray(obj.custom);
  if (opts.rejectAllWrongShapes) {
    // jsonrepair on garbage like `{"predefined": not-json-here` returns
    // `{ predefined: "not-json-here" }`. Decline when nothing parsed cleanly.
    const predefinedAbsent = obj.predefined === undefined;
    const customAbsent = obj.custom === undefined;
    const predefinedWrong = !predefinedAbsent && !predefinedIsObject;
    const customWrong = !customAbsent && !customIsArray;
    const nothingValid = (predefinedAbsent || predefinedWrong) && (customAbsent || customWrong);
    if (nothingValid) return null;
  }
  return {
    predefined: predefinedIsObject ? (obj.predefined as Record<string, boolean>) : {},
    custom: customIsArray ? (obj.custom as LlmAgentSuggestion[]) : [],
    skipped: parseSkipped(obj.skipped),
    declined: parseSkipped(obj.declined),
  };
}

/** A Tier-1 inventory row the model deliberately declined, with its reason.
 *
 *  The response had no way to say this: an inventory row was either in `custom` or
 *  absent, so a judged rejection and an oversight were the same bytes, and
 *  `injectMissingTier1Specialists` could only assume oversight. MEASURED on a live
 *  Drupal 7 run — the model was shown `Symfony (framework, 4 files)`, whose matches are
 *  a `polyfill-mbstring` vendored inside PhpSpreadsheet, correctly left it out, and the
 *  net put `symfony-specialist` back on the user's form. */
export interface SkippedInventoryRow {
  id: string;
  reason: string;
}

/** Tolerant: a missing field, a non-array, or an entry without a usable id yields
 *  nothing. A malformed rejection must lose the row to the safety net rather than
 *  suppress a specialist on an id nobody can read. */
function parseSkipped(raw: unknown): SkippedInventoryRow[] {
  if (!Array.isArray(raw)) return [];
  const out: SkippedInventoryRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, reason } = entry as { id?: unknown; reason?: unknown };
    if (typeof id !== 'string' || id.trim().length === 0) continue;
    out.push({ id: id.trim(), reason: typeof reason === 'string' ? reason : '' });
  }
  return out;
}

export function parseLlmAgentOutputWithDiagnostic(raw: string): {
  // `skipped`/`declined` are the rejection channels parseAgentBody already returns; naming
  // them here is what lets a typed caller read them at all.
  result: {
    predefined: Record<string, boolean>;
    custom: LlmAgentSuggestion[];
    skipped: SkippedInventoryRow[];
    declined: SkippedInventoryRow[];
  } | null;
  diagnostic: AgentParseDiagnostic | null;
} {
  // Custom agent bodies include an `outputFormat` field that is itself a
  // triple-backtick fenced Markdown block. The outer ```json fence then
  // legitimately contains inner ``` inside string values, so lazy and greedy
  // regexes both warrant a try. Order: strict on both first (preferring the
  // greedy span that matches the full block), then repair as salvage.
  const lazy = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const greedy = raw.match(/```(?:json)?\s*([\s\S]*)```/);
  let lastError: AgentParseDiagnostic | null = null as AgentParseDiagnostic | null;

  for (const candidate of [extractFencedJson(raw), greedy?.[1], lazy?.[1]]) {
    if (!candidate) continue;
    try {
      const result = parseAgentBody(candidate);
      return { result, diagnostic: null };
    } catch (strictErr) {
      const message = strictErr instanceof Error ? strictErr.message : String(strictErr);
      const pos = parseInt((message.match(/position (\d+)/) ?? [])[1] ?? '0', 10);
      lastError = {
        parseError: message,
        bodyLength: candidate.length,
        errorPosition: pos,
        snippet: candidate.slice(Math.max(0, pos - 60), pos + 60),
      };
    }
  }

  // Strict failed on every layout — jsonrepair as salvage. Try greedy first
  // (full block), fall back to lazy. Use strict shape-rejection so we don't
  // accept jsonrepair's coercion of garbage tokens into stringy fields.
  for (const candidate of [extractFencedJson(raw), greedy?.[1], lazy?.[1]]) {
    if (!candidate) continue;
    try {
      const repaired = jsonrepair(candidate);
      const result = parseAgentBody(repaired, { rejectAllWrongShapes: true });
      if (result) {
        lastError = lastError ? { ...lastError, repaired: true } : null;
        return { result, diagnostic: lastError };
      }
    } catch {
      // try the next candidate
    }
  }
  return { result: null, diagnostic: lastError };
}

export function parseLlmAgentOutput(
  raw: string,
): { predefined: Record<string, boolean>; custom: LlmAgentSuggestion[] } | null {
  return parseLlmAgentOutputWithDiagnostic(raw).result;
}

/* ------------------------------------------------------------------ */
/* LLM enrichment merge                                                */
/* ------------------------------------------------------------------ */

const VALID_COLORS: Set<AgentColor> = new Set(['blue', 'purple', 'green', 'gold', 'red', 'orange']);
const DEFAULT_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];

function titleCase(id: string): string {
  return id
    .split(/[-_]/g)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function normaliseExecutionSteps(raw: unknown): { title: string; body: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const o = s as { title?: unknown; body?: unknown };
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      const body = typeof o.body === 'string' ? o.body.trim() : '';
      if (!title || !body) return null;
      return { title, body };
    })
    .filter((s): s is { title: string; body: string } => s !== null);
}

function normaliseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
}

export function buildAgentSpecFromLlm(
  id: string,
  label: string,
  hint: string,
  llmBody: LlmCustomAgentBody | undefined,
): AgentSpec | undefined {
  if (!llmBody || typeof llmBody !== 'object') return undefined;
  const title =
    typeof llmBody.title === 'string' && llmBody.title.trim().length > 0
      ? llmBody.title.trim()
      : label || titleCase(id);
  const description =
    typeof llmBody.description === 'string' && llmBody.description.trim().length > 0
      ? llmBody.description.trim()
      : hint;
  const color: AgentColor =
    llmBody.color && VALID_COLORS.has(llmBody.color as AgentColor)
      ? (llmBody.color as AgentColor)
      : 'purple';
  const field =
    typeof llmBody.field === 'string' && llmBody.field.trim().length > 0
      ? llmBody.field.trim()
      : 'custom';
  const tools = (() => {
    const arr = normaliseStringArray(llmBody.tools);
    return arr.length > 0 ? arr : DEFAULT_TOOLS;
  })();
  const coreMission =
    typeof llmBody.coreMission === 'string' && llmBody.coreMission.trim().length > 0
      ? llmBody.coreMission.trim()
      : `Describe what the ${title} is responsible for in this repository.`;
  const responsibilities = (() => {
    const arr = normaliseStringArray(llmBody.responsibilities);
    return arr.length > 0 ? arr : ['**Responsibility** — describe the core duties of this agent.'];
  })();
  const whenInvoked = (() => {
    const arr = normaliseStringArray(llmBody.whenInvoked);
    return arr.length > 0 ? arr : ['The user explicitly requests this specialist.'];
  })();
  const executionSteps = (() => {
    const arr = normaliseExecutionSteps(llmBody.executionSteps);
    return arr.length > 0
      ? arr
      : [
          {
            title: 'Execute the role',
            body: 'Describe the execution protocol for this agent using the repository conventions.',
          },
        ];
  })();
  const outputFormat =
    typeof llmBody.outputFormat === 'string' && llmBody.outputFormat.trim().length > 0
      ? llmBody.outputFormat.trim()
      : '```\n<replace with schema>\n```';
  const qualityCriteria = (() => {
    const arr = normaliseStringArray(llmBody.qualityCriteria);
    return arr.length > 0 ? arr : ['Verify the output satisfies project conventions.'];
  })();
  const antiPatterns = (() => {
    const arr = normaliseStringArray(llmBody.antiPatterns);
    return arr.length > 0 ? arr : ['Skip the search order and grep blindly.'];
  })();

  return {
    id,
    title,
    description,
    color,
    field,
    tools,
    coreMission,
    responsibilities,
    whenInvoked,
    executionSteps,
    outputFormat,
    qualityCriteria,
    antiPatterns,
  };
}

/** Safety net: ensure every Tier 1 inventory item ends up as a candidate
 *  even if the LLM dropped it. Existing candidates with the same id (or the
 *  bare tech name) are left untouched — bundle/scan/llm sources win over
 *  this synthesised default. */
export function injectMissingTier1Specialists(
  candidates: AgentCandidate[],
  inventory: TechInventory,
  skipped: readonly SkippedInventoryRow[] = [],
): void {
  const existingIds = new Set(candidates.map((c) => c.id));
  // An id the model REJECTED is not a gap to fill. Only a row it neither proposed nor
  // ruled on is treated as dropped — which is what this net was always for.
  const rejected = new Set(skipped.flatMap((r) => [r.id, r.id.replace(/-specialist$/, '')]));
  for (const it of inventory.items) {
    if (!MANDATORY_CATEGORIES.has(it.category)) continue;
    const id = `${it.name}-specialist`;
    if (rejected.has(id) || rejected.has(it.name)) continue;
    if (existingIds.has(id) || existingIds.has(it.name)) continue;
    const label = `${it.displayName} specialist`;
    const hint = `${it.category} expertise for ${it.displayName}`;
    const body = buildAgentSpecFromLlm(id, label, hint, {
      title: `${it.displayName} Specialist`,
      description: `Owns ${it.displayName} (${it.category}) usage in this repository.`,
      field: it.category,
    });
    candidates.push({
      id,
      label,
      hint,
      count: it.fileCount,
      recommended: true,
      source: 'llm',
      ...(body ? { body } : {}),
    });
    existingIds.add(id);
  }
}

function enrichCandidates(
  detected: AgentDiscoveryDetect,
  llmOutput: unknown,
  diagnosticSink?: (diag: AgentParseDiagnostic) => void,
): AgentCandidate[] {
  const candidates: AgentCandidate[] = detected.candidates.map((c) => ({
    ...c,
    source: c.source ?? ('scan' as const),
  }));

  // llmOutput may be: a raw string, a Claude Code JSON wrapper { result: "..." }, or
  // already the parsed { predefined, custom } object. Unwrap as needed.
  let extracted: string | unknown = llmOutput;
  if (
    llmOutput &&
    typeof llmOutput === 'object' &&
    'result' in (llmOutput as Record<string, unknown>)
  ) {
    extracted = (llmOutput as { result: unknown }).result;
  }
  let llmResult: {
    predefined: Record<string, boolean>;
    custom: LlmAgentSuggestion[];
    skipped?: SkippedInventoryRow[];
    declined?: SkippedInventoryRow[];
  } | null;
  if (typeof extracted === 'string') {
    const parsed = parseLlmAgentOutputWithDiagnostic(extracted);
    llmResult = parsed.result;
    // Surface the diagnostic on hard-fail (no result) AND on repair (so
    // callers can count safety-net hits even when we did salvage entries).
    if (parsed.diagnostic && diagnosticSink && (!llmResult || parsed.diagnostic.repaired)) {
      diagnosticSink(parsed.diagnostic);
    }
  } else {
    llmResult = extracted as {
      predefined: Record<string, boolean>;
      custom: LlmAgentSuggestion[];
      skipped?: SkippedInventoryRow[];
      declined?: SkippedInventoryRow[];
    } | null;
  }
  if (llmResult) {
    // Update recommendation flags for predefined agents
    if (llmResult.predefined) {
      const reasonById = new Map((llmResult.declined ?? []).map((d) => [d.id, d.reason]));
      for (const c of candidates) {
        if (c.id in llmResult.predefined) {
          c.recommended = llmResult.predefined[c.id]!;
          // Carried only for a DECLINE. A reason attached to something still ticked
          // would render as an objection to a recommendation.
          const reason = reasonById.get(c.id);
          if (!c.recommended && reason) c.declineReason = reason;
        }
      }
    }

    // Add custom agents suggested by LLM
    if (llmResult.custom) {
      const existingIds = new Set(candidates.map((c) => c.id));
      for (const custom of llmResult.custom) {
        if (!custom.id || existingIds.has(custom.id)) continue;
        const label = custom.label || custom.id;
        const hint = custom.hint || 'AI-suggested agent';
        const body = buildAgentSpecFromLlm(custom.id, label, hint, custom.body);
        candidates.push({
          id: custom.id,
          label,
          hint,
          count: 0,
          recommended: custom.recommended !== false,
          source: 'llm',
          ...(body ? { body } : {}),
        });
        existingIds.add(custom.id);
      }
    }
  }

  /* Tier 1 safety net runs even when the LLM call failed entirely, so the
     user always sees a build / framework / db / orm / graphics / queue /
     search / pdf / api specialist for every inventory hit. */
  if (detected.__techInventory) {
    injectMissingTier1Specialists(candidates, detected.__techInventory, llmResult?.skipped ?? []);
  }

  return candidates;
}

/** Load every agent surfaced by an active custom bundle bound to this repo.
 *  Each item carries its full canonical IR so the form can render it as a
 *  default-checked candidate and 07-generate-files can pick the spec straight
 *  out of the apply output. */
async function loadBundleAgentCandidates(ctx: StepContext): Promise<AgentCandidate[]> {
  const taskRow = await ctx.db
    .select({ repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, ctx.taskId))
    .limit(1);
  const repositoryId = taskRow[0]?.repositoryId ?? null;
  if (!repositoryId) return [];

  const bundles = await ctx.db
    .select({ id: schema.customBundles.id, name: schema.customBundles.name })
    .from(schema.customBundles)
    .where(eq(schema.customBundles.repositoryId, repositoryId));
  if (bundles.length === 0) return [];
  const bundleNameById = new Map(bundles.map((b) => [b.id, b.name]));

  const items = await ctx.db
    .select({
      bundleId: schema.customBundleItems.bundleId,
      sourcePath: schema.customBundleItems.sourcePath,
      normalizedSpec: schema.customBundleItems.normalizedSpec,
    })
    .from(schema.customBundleItems)
    .innerJoin(schema.customBundles, eq(schema.customBundleItems.bundleId, schema.customBundles.id))
    // AGENT items only, as 09_5-skill-generation already selects `kind = 'skill'`.
    // Without it every skill in the bundle was fed to `agentSpecSchema` and warned with
    // ~10 issues on the way out — MEASURED, a one-skill bundle logged a full
    // "failed schema validation" report for `skills/<name>/SKILL.md` on every run. The
    // skill was still picked up by 09_5, so nothing was lost; what was lost is the
    // warning's meaning, since a genuinely broken AGENT reads exactly the same.
    .where(
      and(
        eq(schema.customBundles.repositoryId, repositoryId),
        eq(schema.customBundleItems.kind, 'agent'),
      ),
    );

  const out: AgentCandidate[] = [];
  for (const item of items) {
    const parsed = agentSpecSchema.safeParse(item.normalizedSpec);
    if (!parsed.success) {
      ctx.logger.warn(
        { sourcePath: item.sourcePath, issues: parsed.error.issues },
        'agent-discovery: bundle agent failed schema validation, skipping',
      );
      continue;
    }
    const spec = parsed.data;
    const bundleName = bundleNameById.get(item.bundleId) ?? 'bundle';
    out.push({
      id: spec.id,
      label: spec.title,
      hint: spec.description || `from bundle ${bundleName}`,
      count: 0,
      recommended: true,
      source: 'bundle',
      body: spec,
    });
  }
  return out;
}

/** Fold bundle-sourced agent candidates into the main candidate list. Bundle
 *  wins on ID collision: the existing candidate is replaced (its body field
 *  is upgraded to the bundle IR and source is reset to 'bundle'). New IDs are
 *  appended. */
function mergeBundleCandidates(
  candidates: AgentCandidate[],
  bundleCandidates: AgentCandidate[],
  ctx: StepContext,
): void {
  const byId = new Map(candidates.map((c, i) => [c.id, i]));
  for (const bundleCandidate of bundleCandidates) {
    const existingIdx = byId.get(bundleCandidate.id);
    if (existingIdx === undefined) {
      candidates.push(bundleCandidate);
      byId.set(bundleCandidate.id, candidates.length - 1);
      continue;
    }
    ctx.logger.info(
      { id: bundleCandidate.id },
      'agent-discovery: bundle agent overrides scan candidate of same id',
    );
    candidates[existingIdx] = bundleCandidate;
  }
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const agentDiscoveryStep: StepDefinition<AgentDiscoveryDetect, AgentDiscoveryApply> = {
  metadata: {
    id: '06_5-agent-discovery',
    workflowType: 'onboarding',
    index: 6,
    title: 'Agent discovery',
    description:
      'Scans the repository for file clusters, then uses an LLM to analyse the full project structure and recommend both predefined and custom agents. Falls back to deterministic-only when no CLI provider is available.',
    requiresCli: true,
  },

  async detect(ctx: StepContext): Promise<AgentDiscoveryDetect> {
    await ctx.emitProgress('Loading project metadata...');
    const { framework, primaryLanguage: language } = await resolveConfirmedProject(
      ctx.db,
      ctx.taskId,
    );

    await ctx.emitProgress('Scanning repository for file patterns...');
    const candidates = await discoverAgentCandidates(ctx.repoPath, framework);

    await ctx.emitProgress('Loading bundle agents...');
    const bundleCandidates = await loadBundleAgentCandidates(ctx);
    mergeBundleCandidates(candidates, bundleCandidates, ctx);

    await ctx.emitProgress('Collecting file tree for LLM analysis...');
    const fileTree = await collectFileTree(ctx.repoPath);

    await ctx.emitProgress('Reading key configuration files...');
    const keyFiles = await collectKeyFiles(ctx.repoPath);

    await ctx.emitProgress('Building secondary technology inventory...');
    // Third-party trees are not this project's stack. The framework's own excludePaths
    // name them (`sites/all/libraries/` on Drupal 7), and IGNORE_DIRS cannot — it matches
    // a bare directory NAME, so a library vendored at a path slips through.
    const frameworkPattern = framework
      ? FRAMEWORK_PATTERNS[framework as keyof typeof FRAMEWORK_PATTERNS]
      : undefined;
    // Composer is AUTHORITATIVE where it speaks, and the hardcoded pattern is the
    // fallback: `extra.installer-paths` says where contrib actually lands whatever the
    // docroot is called (`web/`, `docroot/`, the repo root), which no static list can
    // know. The same pair already backs the scope pickers via `computeSeedExcludeGlobs`;
    // without it here, a Drupal site with a non-default docroot had its contrib counted
    // as this project's own stack. `composerExcludeDirs` keeps any path with a `custom`
    // segment in scope, so this never hides hand-written code.
    const techInventory = await buildTechInventory(ctx.repoPath, {
      excludePaths: [
        ...(frameworkPattern?.excludePaths ?? []),
        ...composerExcludeDirs(await readComposerJson(ctx.repoPath)),
      ],
    });

    await ctx.emitProgress(
      `Found ${candidates.length} agent candidates, ${fileTree.split('\n').length} files mapped, ${techInventory.items.length} secondary technologies. Waiting for LLM analysis...`,
    );

    ctx.logger.info(
      {
        framework,
        language,
        candidateCount: candidates.length,
        recommendedCount: candidates.filter((c) => c.recommended).length,
        fileTreeLines: fileTree.split('\n').length,
        techInventorySize: techInventory.items.length,
        techInventoryNames: techInventory.items.map((it) => it.name),
      },
      'agent discovery detect complete',
    );
    return {
      candidates,
      framework,
      language,
      __fileTree: fileTree,
      __keyFiles: keyFiles,
      __techInventory: techInventory,
    } as AgentDiscoveryDetect & { __keyFiles: string };
  },

  llm: {
    requiredCapabilities: [],
    preForm: true,
    buildPrompt: buildAgentDiscoveryPrompt,
    timeoutMs: 60 * 60 * 1000,
    retry: { maxAttempts: 3, retryOn: (e) => e instanceof RetryableParseError },
    // Form-aware: re-roll before the candidate-selection form when the LLM output
    // produced NO usable agent result (total parse failure) — so the user isn't
    // shown a stub-only candidate list on a transient bad turn.
    shouldRetryPreForm: (raw) => {
      let extracted: unknown = raw;
      if (raw && typeof raw === 'object' && 'result' in (raw as Record<string, unknown>)) {
        extracted = (raw as { result: unknown }).result;
      }
      if (typeof extracted !== 'string' || extracted.trim() === '') return false;
      return parseLlmAgentOutputWithDiagnostic(extracted).result === null;
    },
  },

  form(ctx, detected, llmOutput): FormSchema {
    // Merge LLM suggestions into candidates before displaying the form
    const enriched = enrichCandidates(detected, llmOutput, (diag) =>
      ctx.logger.warn(
        {
          parseError: diag.parseError,
          bodyLength: diag.bodyLength,
          errorPosition: diag.errorPosition,
          snippet: diag.snippet,
          repaired: diag.repaired === true,
        },
        diag.repaired
          ? 'agent-discovery: strict JSON.parse failed but jsonrepair salvaged the suggestions'
          : 'agent-discovery: LLM output failed JSON.parse and jsonrepair could not recover',
      ),
    );

    // Pre-selected whatever the model says, because workflow steps name them directly
    // (_agent-selector, 03-phase-0a-discovery, 11-phase-8-learning). The tick is what the
    // user reads, so the sub-text below has to agree with the TICK, not with the
    // `recommended` flag — a box that is checked while saying "Not recommended" is the
    // same unexplained contradiction the reason was added to remove.
    const ALWAYS_SELECTED = new Set([
      'code-reviewer',
      'security-auditor',
      'knowledge-miner',
      'learning-recorder',
    ]);
    const options = enriched.map((c) => ({
      value: c.id,
      label: `${c.label}${c.count > 0 ? ` (${c.count} files)` : ''} — ${c.hint}`,
      ...(c.declineReason
        ? {
            description: ALWAYS_SELECTED.has(c.id)
              ? `Kept regardless — later workflow steps call this agent by name. The model advised against it: ${c.declineReason}`
              : `Not recommended: ${c.declineReason}`,
          }
        : {}),
      ...(c.source === 'llm'
        ? { badge: 'AI-suggested', badgeColor: 'amber' as const }
        : c.source === 'bundle'
          ? { badge: 'From bundle', badgeColor: 'indigo' as const }
          : {}),
    }));
    const defaults = enriched
      .filter((c) => c.recommended || ALWAYS_SELECTED.has(c.id))
      .map((c) => c.id);

    const hasLlm = llmOutput !== undefined && llmOutput !== null;
    const customCount = enriched.filter((c) => c.source === 'llm').length;
    const description = hasLlm
      ? `Agents recommended by AI analysis of your project. ${customCount > 0 ? `${customCount} project-specific agent${customCount > 1 ? 's' : ''} suggested.` : 'No additional project-specific agents suggested.'} Untick any that are not relevant.`
      : 'Agents recommended based on file-pattern analysis. Untick any that are not relevant.';

    return {
      title: 'Recommended agents',
      description,
      fields: [
        {
          type: 'multi-select',
          id: 'acceptedAgents',
          label: 'Agents to include',
          options,
          defaults,
        },
      ],
      submitLabel: 'Accept agents',
    };
  },

  async apply(ctx, args): Promise<AgentDiscoveryApply> {
    const detected = args.detected as AgentDiscoveryDetect;
    const enriched = enrichCandidates(detected, args.llmOutput);

    // Strip transient fields
    delete (detected as unknown as Record<string, unknown>).__fileTree;
    delete (detected as unknown as Record<string, unknown>).__keyFiles;
    delete (detected as unknown as Record<string, unknown>).__techInventory;

    // Apply user selections
    const values = args.formValues as { acceptedAgents?: string[] };
    const accepted = new Set(values.acceptedAgents ?? []);
    const acceptedList = enriched.filter((c) => accepted.has(c.id));
    const declinedList = enriched.filter((c) => !accepted.has(c.id));
    ctx.logger.info(
      {
        acceptedCount: acceptedList.length,
        declinedCount: declinedList.length,
        llmEnriched: args.llmOutput != null,
      },
      'agent discovery apply complete',
    );
    return { accepted: acceptedList, declined: declinedList };
  },
};

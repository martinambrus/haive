import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DetectResult, FormSchema } from '@haive/shared';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import {
  countFilesMatching,
  listFilesMatching,
  loadPreviousStepOutput,
  pathExists,
} from './_helpers.js';

export interface AgentCandidate {
  id: string;
  label: string;
  hint: string;
  count: number;
  recommended: boolean;
  /** 'scan' for deterministic file-pattern matches, 'llm' for AI-suggested. */
  source?: 'scan' | 'llm';
}

export interface AgentDiscoveryDetect {
  candidates: AgentCandidate[];
  framework: string | null;
  language: string | null;
  /** Transient — file tree for LLM prompt, stripped before persisting. */
  __fileTree?: string;
}

export interface AgentDiscoveryApply {
  accepted: AgentCandidate[];
  declined: AgentCandidate[];
}

const THRESHOLD = 5;

/* ------------------------------------------------------------------ */
/* Baseline agents (always offered, recommended by default)            */
/* ------------------------------------------------------------------ */

const BASELINE_AGENT_DEFS: { id: string; label: string; hint: string }[] = [
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
  const scanResults = await Promise.all(
    uniquePatterns.map(async (p) => ({ id: p.id, count: await scanPattern(repo, p) })),
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

interface LlmAgentSuggestion {
  id: string;
  label: string;
  hint: string;
  recommended: boolean;
}

function buildAgentDiscoveryPrompt(args: LlmBuildArgs): string {
  const detected = args.detected as AgentDiscoveryDetect;
  const fileTree = detected.__fileTree ?? '(no file tree)';

  const predefinedList = detected.candidates
    .map((c) => `- ${c.id}: ${c.label} — ${c.hint} (${c.count} matching files)`)
    .join('\n');

  return [
    'You are analysing a software repository to recommend which Claude Code subagents should be created for it.',
    '',
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
    '## Instructions',
    '1. Review the file tree and config files to understand the project structure.',
    '2. For each predefined agent above, decide if it is relevant to this project (true/false).',
    '3. Suggest additional custom agents specific to this project that are NOT in the predefined list.',
    '   Custom agents should cover project-specific concerns like specific frameworks, service layers, or domain patterns you see in the file tree.',
    '   Only suggest custom agents that genuinely add value — do not pad the list.',
    '4. For each custom agent, provide: id (kebab-case), label, hint (one-line description), recommended (true/false).',
    '',
    '## Required output format',
    'Emit exactly ONE JSON object inside a ```json fenced code block:',
    '```',
    '{',
    '  "predefined": {',
    '    "<agent-id>": true|false,',
    '    "...": "..."',
    '  },',
    '  "custom": [',
    '    { "id": "my-agent", "label": "My agent", "hint": "does X", "recommended": true }',
    '  ]',
    '}',
    '```',
    'Do not emit any prose outside the fenced block.',
  ].join('\n');
}

function parseLlmAgentOutput(
  raw: string,
): { predefined: Record<string, boolean>; custom: LlmAgentSuggestion[] } | null {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[1]!) as {
      predefined?: Record<string, boolean>;
      custom?: LlmAgentSuggestion[];
    };
    return {
      predefined: obj.predefined ?? {},
      custom: Array.isArray(obj.custom) ? obj.custom : [],
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* LLM enrichment merge                                                */
/* ------------------------------------------------------------------ */

function enrichCandidates(detected: AgentDiscoveryDetect, llmOutput: unknown): AgentCandidate[] {
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
  const llmResult =
    typeof extracted === 'string'
      ? parseLlmAgentOutput(extracted)
      : (extracted as {
          predefined?: Record<string, boolean>;
          custom?: LlmAgentSuggestion[];
        } | null);
  if (!llmResult) return candidates;

  // Update recommendation flags for predefined agents
  if (llmResult.predefined) {
    for (const c of candidates) {
      if (c.id in llmResult.predefined) {
        c.recommended = llmResult.predefined[c.id]!;
      }
    }
  }

  // Add custom agents suggested by LLM
  if (llmResult.custom) {
    const existingIds = new Set(candidates.map((c) => c.id));
    for (const custom of llmResult.custom) {
      if (!custom.id || existingIds.has(custom.id)) continue;
      candidates.push({
        id: custom.id,
        label: custom.label || custom.id,
        hint: custom.hint || 'AI-suggested agent',
        count: 0,
        recommended: custom.recommended !== false,
        source: 'llm',
      });
      existingIds.add(custom.id);
    }
  }

  return candidates;
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
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (envPrev?.detect as DetectResult | null)?.data as
      | { project?: { framework?: string; primaryLanguage?: string } }
      | undefined;
    const framework = envData?.project?.framework ?? null;
    const language = envData?.project?.primaryLanguage ?? null;

    await ctx.emitProgress('Scanning repository for file patterns...');
    const candidates = await discoverAgentCandidates(ctx.repoPath, framework);

    await ctx.emitProgress('Collecting file tree for LLM analysis...');
    const fileTree = await collectFileTree(ctx.repoPath);

    await ctx.emitProgress('Reading key configuration files...');
    const keyFiles = await collectKeyFiles(ctx.repoPath);

    await ctx.emitProgress(
      `Found ${candidates.length} agent candidates, ${fileTree.split('\n').length} files mapped. Waiting for LLM analysis...`,
    );

    ctx.logger.info(
      {
        framework,
        language,
        candidateCount: candidates.length,
        recommendedCount: candidates.filter((c) => c.recommended).length,
        fileTreeLines: fileTree.split('\n').length,
      },
      'agent discovery detect complete',
    );
    return {
      candidates,
      framework,
      language,
      __fileTree: fileTree,
      __keyFiles: keyFiles,
    } as AgentDiscoveryDetect & { __keyFiles: string };
  },

  llm: {
    requiredCapabilities: [],
    optional: true,
    preForm: true,
    buildPrompt: buildAgentDiscoveryPrompt,
  },

  form(_ctx, detected, llmOutput): FormSchema {
    // Merge LLM suggestions into candidates before displaying the form
    const enriched = enrichCandidates(detected, llmOutput);

    const options = enriched.map((c) => ({
      value: c.id,
      label: `${c.label}${c.count > 0 ? ` (${c.count} files)` : ''} — ${c.hint}`,
      ...(c.source === 'llm' ? { badge: 'AI-suggested', badgeColor: 'amber' as const } : {}),
    }));
    const defaults = enriched.filter((c) => c.recommended).map((c) => c.id);

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

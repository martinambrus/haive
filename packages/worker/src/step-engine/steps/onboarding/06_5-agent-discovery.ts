import path from 'node:path';
import type { DetectResult, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { countFilesMatching, loadPreviousStepOutput, pathExists } from './_helpers.js';

export interface AgentCandidate {
  id: string;
  label: string;
  hint: string;
  count: number;
  recommended: boolean;
}

export interface AgentDiscoveryDetect {
  candidates: AgentCandidate[];
  framework: string | null;
  language: string | null;
}

export interface AgentDiscoveryApply {
  accepted: AgentCandidate[];
  declined: AgentCandidate[];
}

const THRESHOLD = 5;

interface Pattern {
  id: string;
  label: string;
  hint: string;
  predicate: (rel: string, isDir: boolean) => boolean;
  requireDir?: string;
}

const TEST_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|php|py)$/i;
const REACT_COMPONENT_RE = /\.(tsx|jsx)$/;

const GENERIC_PATTERNS: Pattern[] = [
  {
    id: 'test-writer',
    label: 'Test writer',
    hint: 'writes and maintains automated tests',
    predicate: (rel, isDir) => !isDir && TEST_RE.test(rel),
  },
  {
    id: 'migration-author',
    label: 'Migration author',
    hint: 'owns database migrations and schema evolution',
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
    label: 'API route developer',
    hint: 'owns HTTP handlers and route definitions',
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
    label: 'Docs writer',
    hint: 'curates project documentation under docs/',
    predicate: (rel, isDir) => {
      if (isDir) return false;
      if (!rel.endsWith('.md') && !rel.endsWith('.rst')) return false;
      return rel.startsWith('docs/') || rel.startsWith('documentation/');
    },
  },
  {
    id: 'config-manager',
    label: 'Config manager',
    hint: 'owns YAML/TOML configuration files',
    predicate: (rel, isDir) => {
      if (isDir) return false;
      return (
        (rel.endsWith('.yml') || rel.endsWith('.yaml') || rel.endsWith('.toml')) &&
        (rel.startsWith('config/') || rel.includes('/config/'))
      );
    },
  },
];

const FRAMEWORK_PATTERNS: Record<string, Pattern[]> = {
  drupal7: [
    {
      id: 'drupal-module-dev',
      label: 'Drupal module developer',
      hint: 'owns .module and .install files',
      predicate: (rel, isDir) => !isDir && (rel.endsWith('.module') || rel.endsWith('.install')),
    },
  ],
  drupal: [
    {
      id: 'drupal-module-dev',
      label: 'Drupal module developer',
      hint: 'owns .module and .install files',
      predicate: (rel, isDir) => !isDir && (rel.endsWith('.module') || rel.endsWith('.install')),
    },
  ],
  nextjs: [
    {
      id: 'react-component-dev',
      label: 'React component developer',
      hint: 'owns .tsx/.jsx components',
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
  ],
  nodejs: [
    {
      id: 'react-component-dev',
      label: 'React component developer',
      hint: 'owns .tsx/.jsx components',
      predicate: (rel, isDir) => {
        if (isDir) return false;
        if (!REACT_COMPONENT_RE.test(rel)) return false;
        return rel.startsWith('src/components/') || rel.startsWith('components/');
      },
    },
  ],
  django: [
    {
      id: 'django-model-dev',
      label: 'Django model developer',
      hint: 'owns models.py files',
      predicate: (rel, isDir) => !isDir && rel.endsWith('models.py'),
    },
  ],
};

async function scanCandidate(repo: string, pattern: Pattern): Promise<AgentCandidate> {
  if (pattern.requireDir) {
    const dir = path.join(repo, pattern.requireDir);
    if (!(await pathExists(dir))) {
      return {
        id: pattern.id,
        label: pattern.label,
        hint: pattern.hint,
        count: 0,
        recommended: false,
      };
    }
  }
  const count = await countFilesMatching(repo, pattern.predicate, 5);
  return {
    id: pattern.id,
    label: pattern.label,
    hint: pattern.hint,
    count,
    recommended: count >= THRESHOLD,
  };
}

export async function discoverAgentCandidates(
  repo: string,
  framework: string | null,
): Promise<AgentCandidate[]> {
  const patterns = [
    ...GENERIC_PATTERNS,
    ...(framework && FRAMEWORK_PATTERNS[framework] ? FRAMEWORK_PATTERNS[framework] : []),
  ];
  const seen = new Set<string>();
  const unique = patterns.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  return Promise.all(unique.map((p) => scanCandidate(repo, p)));
}

export const agentDiscoveryStep: StepDefinition<AgentDiscoveryDetect, AgentDiscoveryApply> = {
  metadata: {
    id: '06_5-agent-discovery',
    workflowType: 'onboarding',
    index: 6,
    title: 'Agent discovery',
    description:
      'Scans the repository for file clusters that justify dedicated agents and recommends ones that cross the 5-file threshold. The user accepts or declines each recommendation; accepted agents flow into step 07 generate-files.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<AgentDiscoveryDetect> {
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (envPrev?.detect as DetectResult | null)?.data as
      | { project?: { framework?: string; primaryLanguage?: string } }
      | undefined;
    const framework = envData?.project?.framework ?? null;
    const language = envData?.project?.primaryLanguage ?? null;
    const candidates = await discoverAgentCandidates(ctx.repoPath, framework);
    ctx.logger.info(
      {
        framework,
        language,
        candidateCount: candidates.length,
        recommendedCount: candidates.filter((c) => c.recommended).length,
      },
      'agent discovery complete',
    );
    return { candidates, framework, language };
  },

  form(_ctx, detected): FormSchema {
    const options = detected.candidates.map((c) => ({
      value: c.id,
      label: `${c.label} (${c.count} files) — ${c.hint}`,
    }));
    const defaults = detected.candidates.filter((c) => c.recommended).map((c) => c.id);
    return {
      title: 'Recommended agents',
      description:
        'Each recommendation is based on a detected file cluster. Accepted agents will be written in step 07 as .claude/agents/<id>.md files.',
      fields: [
        {
          type: 'multi-select',
          id: 'acceptedAgents',
          label: 'Agents to accept',
          options,
          defaults,
        },
      ],
      submitLabel: 'Accept agents',
    };
  },

  async apply(ctx, args): Promise<AgentDiscoveryApply> {
    const detected = args.detected as AgentDiscoveryDetect;
    const values = args.formValues as { acceptedAgents?: string[] };
    const accepted = new Set(values.acceptedAgents ?? []);
    const acceptedList = detected.candidates.filter((c) => accepted.has(c.id));
    const declinedList = detected.candidates.filter((c) => !accepted.has(c.id));
    ctx.logger.info(
      {
        acceptedCount: acceptedList.length,
        declinedCount: declinedList.length,
      },
      'agent discovery apply complete',
    );
    return { accepted: acceptedList, declined: declinedList };
  },
};

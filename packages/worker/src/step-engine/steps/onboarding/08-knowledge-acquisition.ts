import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching, pathExists } from './_helpers.js';

interface TopicHint {
  id: KbTopicId;
  label: string;
  hints: string[];
}

interface KnowledgeDetect {
  topics: TopicHint[];
}

export type KbTopicId = 'testing' | 'deployment' | 'database' | 'documentation';

interface KnowledgeApply {
  written: { id: string; filePath: string }[];
  source: 'llm' | 'stub';
}

interface KbEntry {
  id: string;
  title: string;
  sections: { heading: string; body: string }[];
}

const TOPIC_DEFINITIONS: { id: KbTopicId; label: string }[] = [
  { id: 'testing', label: 'Testing and verification' },
  { id: 'deployment', label: 'Deployment and infrastructure' },
  { id: 'database', label: 'Database and schema' },
  { id: 'documentation', label: 'Existing documentation' },
];

async function collectTestingHints(repo: string): Promise<string[]> {
  const hints: string[] = [];
  const dirs = ['__tests__', 'test', 'tests', 'spec', 'specs'];
  for (const d of dirs) {
    if (await pathExists(path.join(repo, d))) hints.push(d);
  }
  const configs = [
    'jest.config.js',
    'jest.config.ts',
    'vitest.config.ts',
    'vitest.config.js',
    'phpunit.xml',
    'phpunit.xml.dist',
    'playwright.config.ts',
  ];
  for (const c of configs) {
    if (await pathExists(path.join(repo, c))) hints.push(c);
  }
  const testFiles = await listFilesMatching(
    repo,
    (rel, isDir) => {
      if (isDir) return false;
      return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|php|py)$/i.test(rel);
    },
    4,
  );
  if (testFiles.length > 0) {
    hints.push(`${testFiles.length} test files`);
  }
  return hints;
}

async function collectDeploymentHints(repo: string): Promise<string[]> {
  const hints: string[] = [];
  const files = [
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    '.github/workflows',
    '.gitlab-ci.yml',
    'Procfile',
    'netlify.toml',
    'vercel.json',
    'fly.toml',
    'railway.json',
  ];
  for (const f of files) {
    if (await pathExists(path.join(repo, f))) hints.push(f);
  }
  return hints;
}

async function collectDatabaseHints(repo: string): Promise<string[]> {
  const hints: string[] = [];
  const files = [
    'prisma/schema.prisma',
    'drizzle.config.ts',
    'drizzle.config.js',
    'alembic',
    'alembic.ini',
    'db/schema.rb',
    'database/migrations',
  ];
  for (const f of files) {
    if (await pathExists(path.join(repo, f))) hints.push(f);
  }
  const migDirs = ['migrations', 'migration'];
  for (const d of migDirs) {
    if (await pathExists(path.join(repo, d))) hints.push(d);
  }
  return hints;
}

async function collectDocumentationHints(repo: string): Promise<string[]> {
  const hints: string[] = [];
  const files = [
    'README.md',
    'README.rst',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'docs',
    'documentation',
  ];
  for (const f of files) {
    if (await pathExists(path.join(repo, f))) hints.push(f);
  }
  return hints;
}

export async function scanKnowledgeTopics(repo: string): Promise<TopicHint[]> {
  const [testing, deployment, database, documentation] = await Promise.all([
    collectTestingHints(repo),
    collectDeploymentHints(repo),
    collectDatabaseHints(repo),
    collectDocumentationHints(repo),
  ]);
  const byId: Record<KbTopicId, string[]> = {
    testing,
    deployment,
    database,
    documentation,
  };
  return TOPIC_DEFINITIONS.map((t) => ({
    id: t.id,
    label: t.label,
    hints: byId[t.id],
  }));
}

export function parseKbEntries(raw: unknown): KbEntry[] {
  if (!raw) return [];
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    if (Array.isArray(raw)) return raw.filter(isValidEntry);
    const asObj = raw as Record<string, unknown>;
    if (Array.isArray(asObj.entries)) {
      return (asObj.entries as unknown[]).filter(isValidEntry);
    }
    return [];
  } else {
    return [];
  }
  const entries: KbEntry[] = [];
  const fenceRe = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    const body = match[1];
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) {
        for (const item of parsed) if (isValidEntry(item)) entries.push(item);
      } else if (isValidEntry(parsed)) {
        entries.push(parsed);
      } else if (
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>).entries)
      ) {
        for (const item of (parsed as Record<string, unknown>).entries as unknown[]) {
          if (isValidEntry(item)) entries.push(item);
        }
      }
    } catch {
      continue;
    }
  }
  return entries;
}

function isValidEntry(val: unknown): val is KbEntry {
  if (!val || typeof val !== 'object') return false;
  const v = val as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.title !== 'string') return false;
  if (!Array.isArray(v.sections)) return false;
  for (const s of v.sections as unknown[]) {
    if (!s || typeof s !== 'object') return false;
    const section = s as Record<string, unknown>;
    if (typeof section.heading !== 'string') return false;
    if (typeof section.body !== 'string') return false;
  }
  return true;
}

function entryToMarkdown(entry: KbEntry): string {
  const lines: string[] = [`# ${entry.title}`, ''];
  for (const s of entry.sections) {
    lines.push(`## ${s.heading}`);
    lines.push('');
    lines.push(s.body.trim());
    lines.push('');
  }
  return lines.join('\n');
}

function stubMarkdown(topic: TopicHint): string {
  const lines: string[] = [`# ${topic.label}`, ''];
  if (topic.hints.length === 0) {
    lines.push('No indicators detected for this topic.');
    lines.push('');
    lines.push('Add notes here once the project has content to document for this area.');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('## Detected indicators');
  lines.push('');
  for (const h of topic.hints) lines.push(`- \`${h}\``);
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push(
    'LLM synthesis was skipped for this entry. Fill in human-written context for the above indicators.',
  );
  lines.push('');
  return lines.join('\n');
}

function topicPrompt(topic: TopicHint): string {
  const hintLine = topic.hints.length > 0 ? topic.hints.join(', ') : '(no indicators detected)';
  return `- id: ${topic.id}; title: ${topic.label}; indicators: ${hintLine}`;
}

export const knowledgeAcquisitionStep: StepDefinition<KnowledgeDetect, KnowledgeApply> = {
  metadata: {
    id: '08-knowledge-acquisition',
    workflowType: 'onboarding',
    index: 9,
    title: 'Knowledge base acquisition',
    description:
      'Synthesises knowledge base entries for key project concerns (testing, deployment, database, documentation) from repo indicators and optional CLI synthesis.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<KnowledgeDetect> {
    const topics = await scanKnowledgeTopics(ctx.repoPath);
    ctx.logger.info(
      { topicCount: topics.length, withHints: topics.filter((t) => t.hints.length > 0).length },
      'knowledge topics detected',
    );
    return { topics };
  },

  form(_ctx, detected): FormSchema {
    const options = detected.topics.map((t) => ({
      value: t.id,
      label: t.hints.length > 0 ? `${t.label} (${t.hints.length} hints)` : `${t.label} (no hints)`,
    }));
    const defaults = detected.topics.filter((t) => t.hints.length > 0).map((t) => t.id as string);
    return {
      title: 'Knowledge base topics',
      description:
        'Select the knowledge base topics to generate. Topics with no detected indicators will produce a stub file that you can fill in manually.',
      fields: [
        {
          type: 'multi-select',
          id: 'selectedTopics',
          label: 'Topics to include',
          options,
          defaults: defaults.length > 0 ? defaults : options.map((o) => o.value),
        },
      ],
      submitLabel: 'Generate knowledge base',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    optional: true,
    buildPrompt: (args) => {
      const detected = args.detected as KnowledgeDetect;
      const values = args.formValues as { selectedTopics?: string[] };
      const selected = new Set(values.selectedTopics ?? []);
      const topics = detected.topics.filter((t) => selected.has(t.id));
      const bullets = topics.map(topicPrompt).join('\n');
      return [
        'You are populating a structured knowledge base for an engineering onboarding workflow.',
        'For each topic below, emit ONE JSON object inside a ```json fenced code block.',
        'Every JSON object must have the exact shape:',
        '{',
        '  "id": "<topic id>",',
        '  "title": "<topic title>",',
        '  "sections": [',
        '    { "heading": "<section heading>", "body": "<markdown body>" }',
        '  ]',
        '}',
        'Do not emit any prose outside the fenced blocks. Use existing indicators as ground truth; do not invent facts.',
        '',
        'Topics:',
        bullets,
      ].join('\n');
    },
  },

  async apply(ctx, args): Promise<KnowledgeApply> {
    const detected = args.detected as KnowledgeDetect;
    const values = args.formValues as { selectedTopics?: string[] };
    const selected = new Set(values.selectedTopics ?? []);
    const topics = detected.topics.filter((t) => selected.has(t.id));

    const kbDir = path.join(ctx.repoPath, '.claude', 'knowledge_base');
    await mkdir(kbDir, { recursive: true });

    const entries = parseKbEntries(args.llmOutput ?? null);
    const byId = new Map<string, KbEntry>();
    for (const e of entries) byId.set(e.id, e);

    const written: { id: string; filePath: string }[] = [];
    let usedLlm = 0;
    for (const topic of topics) {
      const filePath = path.join(kbDir, `${topic.id}.md`);
      const entry = byId.get(topic.id);
      const markdown = entry ? entryToMarkdown(entry) : stubMarkdown(topic);
      if (entry) usedLlm += 1;
      await writeFile(filePath, markdown, 'utf8');
      written.push({ id: topic.id, filePath });
    }
    const source: 'llm' | 'stub' = usedLlm > 0 ? 'llm' : 'stub';
    ctx.logger.info(
      { written: written.length, llmEntries: usedLlm, source },
      'knowledge base written',
    );
    return { written, source };
  },
};

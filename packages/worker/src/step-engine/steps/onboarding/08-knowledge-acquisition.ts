import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DetectResult, FormSchema } from '@haive/shared';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching, loadPreviousStepOutput, pathExists } from './_helpers.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface KnowledgeDetect {
  framework: string | null;
  language: string | null;
  /** Transient — file tree for LLM prompt, stripped before persisting. */
  __fileTree?: string;
  /** Transient — README excerpt for LLM prompt context. */
  __readmeExcerpt?: string;
}

interface KnowledgeApply {
  written: { id: string; filePath: string; source: 'llm' | 'stub' }[];
  topicCount: number;
  llmAvailable: boolean;
}

interface KbEntry {
  id: string;
  title: string;
  sections: { heading: string; body: string }[];
  confidence?: 'high' | 'medium' | 'low';
  sourceFiles?: string[];
}

/* ------------------------------------------------------------------ */
/* Context collection helpers                                          */
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

async function collectShortFileTree(repoPath: string): Promise<string> {
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
  const capped = files.slice(0, 100);
  const tree = capped.join('\n');
  return capped.length < files.length
    ? tree + `\n[...truncated, ${files.length - capped.length} more files]`
    : tree;
}

async function readReadmeExcerpt(repoPath: string): Promise<string | null> {
  for (const name of ['README.md', 'README.rst', 'readme.md']) {
    const p = path.join(repoPath, name);
    if (await pathExists(p)) {
      try {
        const full = await readFile(p, 'utf8');
        return full.length > 2000 ? full.slice(0, 2000) + '\n[...truncated]' : full;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* LLM prompt                                                          */
/* ------------------------------------------------------------------ */

function buildKnowledgePrompt(args: LlmBuildArgs): string {
  const detected = args.detected as KnowledgeDetect;
  const fileTree =
    (detected as unknown as Record<string, string>).__fileTree ?? '(no file tree available)';
  const readme =
    (detected as unknown as Record<string, string>).__readmeExcerpt ?? '(no README found)';

  return [
    'You are a senior software architect performing a deep knowledge audit of a codebase.',
    'Your goal: discover ALL significant knowledge topics and extract real, actionable content for each.',
    '',
    '## Project context',
    `Framework: ${detected.framework ?? 'unknown'}`,
    `Language: ${detected.language ?? 'unknown'}`,
    '',
    '## Repository overview (partial file tree)',
    '```',
    fileTree,
    '```',
    '',
    '## README excerpt',
    readme,
    '',
    '## Instructions',
    '',
    'Use your file-reading tools to deeply explore this repository. Do NOT rely only on the partial file tree above.',
    'Systematically investigate:',
    '',
    '1. **Architecture & patterns**: Read key source files to understand the architecture.',
    '   Look for: module boundaries, dependency injection, service layers, state management.',
    '',
    '2. **Testing strategy**: Read test configs AND actual test files to understand patterns.',
    '   Look for: frameworks, fixture patterns, mocking approaches, coverage config, E2E setup.',
    '',
    '3. **Deployment & infrastructure**: Read CI/CD configs, Dockerfiles, IaC files.',
    '   Look for: build pipelines, staging/production differences, secrets management.',
    '',
    '4. **Database & data layer**: Read schema files, migrations, ORM configs.',
    '   Look for: migration patterns, seed data, query patterns, connection management.',
    '',
    '5. **API design**: Read route definitions, middleware, API schemas.',
    '   Look for: authentication patterns, versioning, error handling conventions.',
    '',
    '6. **Code conventions**: Read multiple source files to detect patterns.',
    '   Look for: naming conventions, error handling patterns, logging practices, file organization.',
    '',
    '7. **Documentation**: Read existing docs to avoid duplicating and to find gaps.',
    '',
    '8. **Domain-specific knowledge**: Identify domain concepts unique to this project.',
    '   Look for: business logic, domain vocabulary, industry-specific patterns.',
    '',
    'You are NOT limited to these categories. Discover whatever matters for this specific codebase.',
    'Read at least 10-15 files to get a representative understanding.',
    'For each topic you identify, read the relevant files thoroughly before writing the entry.',
    '',
    '## Output format',
    '',
    'Emit exactly ONE JSON object inside a ```json fenced code block:',
    '```',
    '{',
    '  "entries": [',
    '    {',
    '      "id": "kebab-case-slug",',
    '      "title": "Human Readable Title",',
    '      "confidence": "high|medium|low",',
    '      "sourceFiles": ["path/to/file1.ts", "path/to/file2.ts"],',
    '      "sections": [',
    '        { "heading": "Section Name", "body": "Detailed markdown content..." }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Requirements for each entry:',
    '- id: kebab-case, unique, descriptive (e.g. "testing-strategy", "api-authentication", "state-management")',
    '- title: clear human-readable name',
    '- confidence: "high" if you read the actual files, "medium" if inferred from structure, "low" if speculative',
    '- sourceFiles: list the files you actually read to produce this entry',
    '- sections: at least 2 sections per entry with real extracted content, not generic advice',
    '  - Include actual code patterns, specific config values, real file paths from the project',
    '  - Write as if explaining to a new team member who needs to understand this area',
    '',
    'Aim for 5-15 knowledge entries depending on project complexity.',
    'Do not emit any prose outside the fenced JSON block.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* LLM output parsing                                                  */
/* ------------------------------------------------------------------ */

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
    if (typeof asObj.result === 'string') {
      return parseKbEntries(asObj.result);
    }
    return [];
  } else {
    return [];
  }
  const entries: KbEntry[] = [];

  // Try lazy match first (handles multiple separate JSON blocks),
  // then fall back to greedy (handles embedded triple backticks in JSON strings).
  const lazyRe = /```json\s*([\s\S]*?)```/g;
  const greedyRe = /```json\s*([\s\S]*)```/;

  let match: RegExpExecArray | null;
  while ((match = lazyRe.exec(text)) !== null) {
    collectFromFenceBody(match[1], entries);
  }
  if (entries.length === 0) {
    const greedyMatch = greedyRe.exec(text);
    if (greedyMatch) {
      collectFromFenceBody(greedyMatch[1], entries);
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

function collectFromFenceBody(body: string | undefined, entries: KbEntry[]): void {
  if (!body) return;
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
    // invalid JSON — skip
  }
}

/* ------------------------------------------------------------------ */
/* Markdown generation                                                 */
/* ------------------------------------------------------------------ */

function entryToMarkdown(entry: KbEntry): string {
  const lines: string[] = [`# ${entry.title}`, ''];
  for (const s of entry.sections) {
    lines.push(`## ${s.heading}`);
    lines.push('');
    lines.push(s.body.trim());
    lines.push('');
  }
  if (entry.sourceFiles && entry.sourceFiles.length > 0) {
    lines.push('## Source files');
    lines.push('');
    for (const f of entry.sourceFiles) lines.push(`- \`${f}\``);
    lines.push('');
  }
  return lines.join('\n');
}

function stubMarkdown(title: string): string {
  return [
    `# ${title}`,
    '',
    'LLM synthesis was skipped for this entry.',
    'Fill in human-written context for this topic.',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Enrichment helpers                                                  */
/* ------------------------------------------------------------------ */

function extractEntries(llmOutput: unknown): KbEntry[] {
  if (!llmOutput) return [];
  // Handle Claude Code JSON wrapper { result: "..." }
  let source: unknown = llmOutput;
  if (
    typeof llmOutput === 'object' &&
    llmOutput !== null &&
    'result' in (llmOutput as Record<string, unknown>)
  ) {
    source = (llmOutput as Record<string, unknown>).result;
  }
  return parseKbEntries(source);
}

function confidenceColor(c?: string): 'green' | 'amber' | 'default' {
  if (c === 'high') return 'green';
  if (c === 'medium') return 'amber';
  return 'default';
}

function confidenceLabel(c?: string): string {
  if (c === 'high') return 'High confidence';
  if (c === 'medium') return 'Medium confidence';
  if (c === 'low') return 'Low confidence';
  return 'AI-discovered';
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const knowledgeAcquisitionStep: StepDefinition<KnowledgeDetect, KnowledgeApply> = {
  metadata: {
    id: '08-knowledge-acquisition',
    workflowType: 'onboarding',
    index: 9,
    title: 'Knowledge base acquisition',
    description:
      'Uses an LLM with tool_use to deeply scan the repository and extract knowledge base entries covering architecture, testing, deployment, conventions, and any other significant topics. Falls back to manual topic entry when no CLI provider is available.',
    requiresCli: true,
  },

  async detect(ctx: StepContext): Promise<KnowledgeDetect> {
    await ctx.emitProgress('Loading project metadata...');
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (envPrev?.detect as DetectResult | null)?.data as
      | { project?: { framework?: string; primaryLanguage?: string } }
      | undefined;
    const framework = envData?.project?.framework ?? null;
    const language = envData?.project?.primaryLanguage ?? null;

    await ctx.emitProgress('Collecting file tree for LLM orientation...');
    const fileTree = await collectShortFileTree(ctx.repoPath);

    await ctx.emitProgress('Reading README...');
    const readmeExcerpt = await readReadmeExcerpt(ctx.repoPath);

    await ctx.emitProgress(
      `Project context gathered (${fileTree.split('\n').length} files mapped). Waiting for AI analysis...`,
    );

    ctx.logger.info(
      { framework, language, fileTreeLines: fileTree.split('\n').length },
      'knowledge acquisition detect complete',
    );
    return {
      framework,
      language,
      __fileTree: fileTree,
      __readmeExcerpt: readmeExcerpt ?? undefined,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    optional: true,
    preForm: true,
    buildPrompt: buildKnowledgePrompt,
    timeoutMs: 90 * 60 * 1000, // 90 minutes — large repos need extensive tool_use scanning
  },

  form(_ctx, detected, llmOutput): FormSchema {
    const entries = extractEntries(llmOutput);

    if (entries.length > 0) {
      const totalSources = new Set(entries.flatMap((e) => e.sourceFiles ?? [])).size;
      const options = entries.map((e) => {
        const srcCount = e.sourceFiles?.length ?? 0;
        const sectionCount = e.sections.length;
        const detail =
          srcCount > 0
            ? `${sectionCount} sections from ${srcCount} source files`
            : `${sectionCount} sections`;
        return {
          value: e.id,
          label: `${e.title} — ${detail}`,
          badge: confidenceLabel(e.confidence),
          badgeColor: confidenceColor(e.confidence),
        };
      });
      const defaults = entries.filter((e) => e.confidence !== 'low').map((e) => e.id);

      return {
        title: 'Knowledge base — AI discoveries',
        description: `AI analyzed ${totalSources} source files and discovered ${entries.length} knowledge topics. Review and select the ones to include in your knowledge base.`,
        fields: [
          {
            type: 'multi-select',
            id: 'selectedTopics',
            label: 'Topics to include',
            options,
            defaults: defaults.length > 0 ? defaults : options.map((o) => o.value),
          },
          {
            type: 'textarea',
            id: 'additionalNotes',
            label: 'Additional notes or corrections (optional)',
            rows: 3,
            placeholder:
              'Add any corrections to the discovered topics, or note additional areas the AI may have missed.',
          },
        ],
        submitLabel: 'Generate knowledge base',
      };
    }

    // Fallback: no LLM output available
    const fw = detected.framework;
    const placeholderHints = [
      'testing strategy',
      'deployment and CI/CD',
      'database and migrations',
      fw ? `${fw}-specific patterns` : 'framework patterns',
      'code conventions',
      'API design',
    ];
    return {
      title: 'Knowledge base — manual topic entry',
      description:
        'Automatic knowledge discovery was not available. List the topics you want documented in your knowledge base, one per line. Stub files will be created for each topic.',
      fields: [
        {
          type: 'textarea',
          id: 'manualTopics',
          label: 'Knowledge topics (one per line)',
          rows: 8,
          placeholder: placeholderHints.join('\n'),
        },
      ],
      submitLabel: 'Create knowledge base stubs',
    };
  },

  async apply(ctx, args): Promise<KnowledgeApply> {
    const detected = args.detected as KnowledgeDetect;
    const values = args.formValues as {
      selectedTopics?: string[];
      additionalNotes?: string;
      manualTopics?: string;
    };

    // Strip transient fields
    delete (detected as unknown as Record<string, unknown>).__fileTree;
    delete (detected as unknown as Record<string, unknown>).__readmeExcerpt;

    const kbDir = path.join(ctx.repoPath, '.claude', 'knowledge_base');
    await mkdir(kbDir, { recursive: true });

    const entries = extractEntries(args.llmOutput ?? null);
    const llmAvailable = entries.length > 0;
    const written: { id: string; filePath: string; source: 'llm' | 'stub' }[] = [];

    if (llmAvailable) {
      // LLM path: write selected entries
      const selected = new Set(values.selectedTopics ?? []);
      const byId = new Map(entries.map((e) => [e.id, e]));
      for (const id of selected) {
        const entry = byId.get(id);
        if (!entry) continue;
        const filePath = path.join(kbDir, `${entry.id}.md`);
        await writeFile(filePath, entryToMarkdown(entry), 'utf8');
        written.push({ id: entry.id, filePath, source: 'llm' });
      }
    } else {
      // Fallback path: write stubs from manual topic list
      const raw = typeof values.manualTopics === 'string' ? values.manualTopics : '';
      const topics = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      for (const title of topics) {
        const id = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        if (!id) continue;
        const filePath = path.join(kbDir, `${id}.md`);
        await writeFile(filePath, stubMarkdown(title), 'utf8');
        written.push({ id, filePath, source: 'stub' });
      }
    }

    ctx.logger.info(
      { written: written.length, llmAvailable, topicCount: entries.length },
      'knowledge base written',
    );
    return { written, topicCount: entries.length, llmAvailable };
  },
};

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { jsonrepair } from 'jsonrepair';
import type { DetectResult, FormSchema } from '@haive/shared';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching, loadPreviousStepOutput, pathExists } from './_helpers.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface KnowledgeDetect {
  framework: string | null;
  language: string | null;
  projectName: string | null;
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

type KbCategory = 'general' | 'tech_pattern' | 'anti_pattern' | 'best_practice' | 'quick_reference';

interface KbEntry {
  id: string;
  title: string;
  sections: { heading: string; body: string }[];
  confidence?: 'high' | 'medium' | 'low';
  sourceFiles?: string[];
  /** Uppercase stem (no extension) like "ARCHITECTURE" to force a canonical filename
   *  at the KB root. Only used for root-level standards; tech/anti entries ignore it. */
  canonical?: string;
  /** Determines which subdir the entry lands in. Defaults to `general`. */
  category?: KbCategory;
  /** Required when `category` is `tech_pattern` or `anti_pattern`. The technology or
   *  framework the pattern covers — becomes the subdir / filename stem. */
  tech?: string;
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
    '## Required coverage (mandatory)',
    '',
    'Emit ONE entry per canonical root file, AND one tech_pattern + anti_pattern + best_practice + quick_reference entry per major technology this repo actually uses. Do not silently skip a canonical file when it does not apply — emit it with `confidence: "low"` and a single section explaining why it is not applicable (e.g. "Not applicable: this is a pure library with no deployment surface"). Hard floor:',
    '',
    '- All 7 canonical root files MUST appear: ARCHITECTURE, API_REFERENCE, CODING_STANDARDS, TESTING_STANDARDS, SECURITY_STANDARDS, DEPLOYMENT, BUSINESS_LOGIC.',
    '- For each major technology / library / framework identified (e.g. gradle, lwjgl2, java8, node-pty, drupal-entity-api), emit:',
    '    - one tech_pattern entry (HOW it is used in this repo)',
    '    - one anti_pattern entry (mistakes specific to that tech in this repo)',
    '    - one best_practice entry (recommended usage in this repo)',
    '    - one quick_reference entry (cheat sheet of the most common operations)',
    '- Topic entries (loose root-level files) are allowed for cross-cutting concerns that do not fit a canonical or tech bucket.',
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
    '      "category": "general | tech_pattern | anti_pattern | best_practice | quick_reference",',
    '      "canonical": "ARCHITECTURE | API_REFERENCE | CODING_STANDARDS | TESTING_STANDARDS | SECURITY_STANDARDS | DEPLOYMENT | BUSINESS_LOGIC | (omit for topic-specific entries)",',
    '      "tech": "<required when category is tech_pattern, anti_pattern, best_practice, or quick_reference — e.g. node-pty, gradle, lwjgl2>",',
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
    '- confidence: "high" if you read the actual files, "medium" if inferred from structure, "low" if speculative or marked not-applicable',
    '- sourceFiles: list the files you actually read to produce this entry',
    '- category:',
    '    * "general" — broad project knowledge. With `canonical` set maps to a canonical root file; without it maps to a kebab-case root file.',
    '    * "tech_pattern" — HOW a specific technology is used in THIS repo. Routes to TECH_PATTERNS/<tech>/INDEX.md.',
    '    * "anti_pattern" — pitfalls/mistakes for a technology. Routes to ANTI_PATTERNS/<tech>-mistakes.md.',
    '    * "best_practice" — recommended usage of a technology in this repo. Routes to BEST_PRACTICES/<tech>-best-practices.md.',
    '    * "quick_reference" — cheat sheet of common operations for a technology. Routes to QUICK_REFERENCE/<tech>/cheat-sheet.md.',
    '- canonical: optional. Use when the entry matches one of the standard root-level files (ARCHITECTURE, API_REFERENCE, CODING_STANDARDS, TESTING_STANDARDS, SECURITY_STANDARDS, DEPLOYMENT, BUSINESS_LOGIC). Produce AT MOST ONE entry per canonical name.',
    '- tech: required when category is tech_pattern, anti_pattern, best_practice, or quick_reference. kebab-case (e.g. node-pty, drupal-form-api, rails-ar, gradle, lwjgl2).',
    '- sections: at least 2 sections per entry with real extracted content, not generic advice.',
    '  - Include actual code patterns, specific config values, real file paths from the project.',
    '  - Cite repo paths with line ranges (e.g. `build.gradle:13-41`) wherever possible.',
    '  - Write as if explaining to a new team member who needs to understand this area.',
    '',
    'Aim for 15-30 knowledge entries depending on project complexity. Cover ALL 7 canonical root files first, then for each major technology emit the four tech entries (pattern, anti-pattern, best-practice, quick-reference).',
    'Do not emit any prose outside the fenced JSON block.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* LLM output parsing                                                  */
/* ------------------------------------------------------------------ */

export interface KbParseDiagnostic {
  parseError: string;
  bodyLength: number;
  errorPosition: number;
  snippet: string;
  /** True when entries were salvaged via jsonrepair after strict JSON.parse failed.
   *  Diagnostic is still attached so callers can log how often the safety net trips. */
  repaired?: boolean;
  recoveredCount?: number;
}

export function parseKbEntriesWithDiagnostic(raw: unknown): {
  entries: KbEntry[];
  diagnostic: KbParseDiagnostic | null;
} {
  if (!raw) return { entries: [], diagnostic: null };
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    if (Array.isArray(raw)) return { entries: raw.filter(isValidEntry), diagnostic: null };
    const asObj = raw as Record<string, unknown>;
    if (Array.isArray(asObj.entries)) {
      return {
        entries: (asObj.entries as unknown[]).filter(isValidEntry),
        diagnostic: null,
      };
    }
    if (typeof asObj.result === 'string') {
      return parseKbEntriesWithDiagnostic(asObj.result);
    }
    return { entries: [], diagnostic: null };
  } else {
    return { entries: [], diagnostic: null };
  }
  const entries: KbEntry[] = [];
  // eslint-disable-next-line prefer-const -- mutated via recordError closure; TS narrows it to never otherwise
  let lastError: KbParseDiagnostic | null = null as KbParseDiagnostic | null;

  const recordError = (body: string, err: unknown, repaired?: { recoveredCount: number }): void => {
    const message = err instanceof Error ? err.message : String(err);
    const pos = parseInt((message.match(/position (\d+)/) ?? [])[1] ?? '0', 10);
    lastError = {
      parseError: message,
      bodyLength: body.length,
      errorPosition: pos,
      snippet: body.slice(Math.max(0, pos - 60), pos + 60),
      ...(repaired ? { repaired: true, recoveredCount: repaired.recoveredCount } : {}),
    };
  };

  // Pass 1: strict-only across viable fence layouts. Lazy first (multiple
  // separate clean JSON blocks), then greedy (one block whose JSON strings
  // legitimately contain inner ``` markdown samples — strict still parses).
  // Skipping repair here is essential: repairing each lazy fragment would
  // "salvage" 1–2 entries and short-circuit the greedy pass that would
  // recover the full set.
  for (const m of text.matchAll(/```json\s*([\s\S]*?)```/g)) {
    collectStrict(m[1], entries);
  }
  if (entries.length === 0) {
    const greedy = text.match(/```json\s*([\s\S]*)```/);
    if (greedy) collectStrict(greedy[1], entries);
  }
  // Pass 2: strict failed on every layout. Try jsonrepair on the greedy
  // body, then on an unterminated fence as a last-ditch effort.
  if (entries.length === 0) {
    const greedy = text.match(/```json\s*([\s\S]*)```/);
    if (greedy) collectRepaired(greedy[1], entries, recordError);
  }
  if (entries.length === 0) {
    const unterminated = text.match(/```json\s*([\s\S]*)$/);
    if (unterminated) collectRepaired(unterminated[1], entries, recordError);
  }
  // Expose the diagnostic whenever entries are missing OR when a repair was
  // necessary to obtain them (so callers can count safety-net hits).
  const expose = entries.length === 0 || lastError?.repaired === true;
  return { entries, diagnostic: expose ? lastError : null };
}

export function parseKbEntries(raw: unknown): KbEntry[] {
  return parseKbEntriesWithDiagnostic(raw).entries;
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

function pushFromParsed(parsed: unknown, entries: KbEntry[]): number {
  const before = entries.length;
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
  return entries.length - before;
}

function collectStrict(body: string | undefined, entries: KbEntry[]): void {
  if (!body) return;
  try {
    pushFromParsed(JSON.parse(body), entries);
  } catch {
    // strict-only pass; salvage happens later
  }
}

function collectRepaired(
  body: string | undefined,
  entries: KbEntry[],
  recordError?: (body: string, err: unknown, repaired?: { recoveredCount: number }) => void,
): void {
  if (!body) return;
  let strictErr: unknown;
  try {
    pushFromParsed(JSON.parse(body), entries);
    return;
  } catch (err) {
    strictErr = err;
  }
  // Strict parse failed — jsonrepair handles the common LLM tail event of a
  // single dropped quote / missing comma in 20K+ chars of output. The caller
  // logs the strict-error fingerprint so we can count safety-net hits.
  try {
    const repaired = jsonrepair(body);
    const recoveredCount = pushFromParsed(JSON.parse(repaired), entries);
    if (recordError) {
      recordError(body, strictErr, recoveredCount > 0 ? { recoveredCount } : undefined);
    }
  } catch {
    if (recordError) recordError(body, strictErr);
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

const CANONICAL_STEMS = new Set([
  'ARCHITECTURE',
  'API_REFERENCE',
  'CODING_STANDARDS',
  'TESTING_STANDARDS',
  'SECURITY_STANDARDS',
  'DEPLOYMENT',
  'BUSINESS_LOGIC',
]);

function normalizeTech(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

function normalizeCanonical(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const stem = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!stem) return null;
  return CANONICAL_STEMS.has(stem) ? stem : null;
}

export interface RoutedEntry {
  entry: KbEntry;
  /** Path relative to `.claude/knowledge_base/` — includes subdirs. */
  relPath: string;
  bucket: 'core' | 'tech_pattern' | 'anti_pattern' | 'best_practice' | 'quick_reference' | 'topic';
  /** Canonical stem for core entries, tech slug for tech/anti/best/quick entries, entry id for topic. */
  key: string;
}

/** Dedupes by (bucket, key) — first entry wins when the LLM emits two with the same canonical/tech. */
export function routeEntries(entries: KbEntry[]): RoutedEntry[] {
  const out: RoutedEntry[] = [];
  const seen = new Set<string>();
  const push = (r: RoutedEntry) => {
    const k = `${r.bucket}:${r.key}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };
  for (const entry of entries) {
    const canonical = normalizeCanonical(entry.canonical);
    const category = entry.category ?? 'general';
    if (canonical) {
      push({ entry, relPath: `${canonical}.md`, bucket: 'core', key: canonical });
      continue;
    }
    if (category === 'tech_pattern') {
      const tech = normalizeTech(entry.tech);
      if (tech) {
        push({
          entry,
          relPath: `TECH_PATTERNS/${tech}/INDEX.md`,
          bucket: 'tech_pattern',
          key: tech,
        });
        continue;
      }
    }
    if (category === 'anti_pattern') {
      const tech = normalizeTech(entry.tech);
      if (tech) {
        push({
          entry,
          relPath: `ANTI_PATTERNS/${tech}-mistakes.md`,
          bucket: 'anti_pattern',
          key: tech,
        });
        continue;
      }
    }
    if (category === 'best_practice') {
      const tech = normalizeTech(entry.tech);
      if (tech) {
        push({
          entry,
          relPath: `BEST_PRACTICES/${tech}-best-practices.md`,
          bucket: 'best_practice',
          key: tech,
        });
        continue;
      }
    }
    if (category === 'quick_reference') {
      const tech = normalizeTech(entry.tech);
      if (tech) {
        push({
          entry,
          relPath: `QUICK_REFERENCE/${tech}/cheat-sheet.md`,
          bucket: 'quick_reference',
          key: tech,
        });
        continue;
      }
    }
    push({ entry, relPath: `${entry.id}.md`, bucket: 'topic', key: entry.id });
  }
  return out;
}

export function kbIndexMarkdown(routed: RoutedEntry[], projectName: string | null): string {
  const core = routed.filter((r) => r.bucket === 'core');
  const tech = routed.filter((r) => r.bucket === 'tech_pattern');
  const anti = routed.filter((r) => r.bucket === 'anti_pattern');
  const best = routed.filter((r) => r.bucket === 'best_practice');
  const quick = routed.filter((r) => r.bucket === 'quick_reference');
  const topic = routed.filter((r) => r.bucket === 'topic');
  const lines: string[] = ['# Knowledge Base Index', ''];
  if (projectName) lines.push(projectName + '.', '');

  if (core.length > 0) {
    lines.push('## Core Files', '');
    for (const r of core) lines.push(`- ${r.relPath} - ${r.entry.title}`);
    lines.push('');
  }
  if (tech.length > 0) {
    lines.push('## Tech Patterns', '');
    for (const r of tech) lines.push(`- ${r.relPath} - ${r.entry.title}`);
    lines.push('');
  }
  if (best.length > 0) {
    lines.push('## Best Practices', '');
    for (const r of best) lines.push(`- ${r.relPath} - ${r.entry.title}`);
    lines.push('');
  }
  if (anti.length > 0) {
    lines.push('## Anti-Patterns', '');
    for (const r of anti) lines.push(`- ${r.relPath} - ${r.entry.title}`);
    lines.push('');
  }
  if (quick.length > 0) {
    lines.push('## Quick References', '');
    for (const r of quick) lines.push(`- ${r.relPath} - ${r.entry.title}`);
    lines.push('');
  }
  if (topic.length > 0) {
    lines.push('## Topics', '');
    for (const r of topic) lines.push(`- ${r.relPath} - ${r.entry.title}`);
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
  return extractEntriesWithDiagnostic(llmOutput).entries;
}

function extractEntriesWithDiagnostic(llmOutput: unknown): {
  entries: KbEntry[];
  diagnostic: KbParseDiagnostic | null;
} {
  if (!llmOutput) return { entries: [], diagnostic: null };
  let source: unknown = llmOutput;
  if (
    typeof llmOutput === 'object' &&
    llmOutput !== null &&
    'result' in (llmOutput as Record<string, unknown>)
  ) {
    source = (llmOutput as Record<string, unknown>).result;
  }
  return parseKbEntriesWithDiagnostic(source);
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
      | { project?: { framework?: string; primaryLanguage?: string; name?: string } }
      | undefined;
    const framework = envData?.project?.framework ?? null;
    const language = envData?.project?.primaryLanguage ?? null;
    const projectName = envData?.project?.name ?? null;

    await ctx.emitProgress('Collecting file tree for LLM orientation...');
    const fileTree = await collectShortFileTree(ctx.repoPath);

    await ctx.emitProgress('Reading README...');
    const readmeExcerpt = await readReadmeExcerpt(ctx.repoPath);

    await ctx.emitProgress(
      `Project context gathered (${fileTree.split('\n').length} files mapped). Waiting for AI analysis...`,
    );

    ctx.logger.info(
      { framework, language, projectName, fileTreeLines: fileTree.split('\n').length },
      'knowledge acquisition detect complete',
    );
    return {
      framework,
      language,
      projectName,
      __fileTree: fileTree,
      __readmeExcerpt: readmeExcerpt ?? undefined,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    preForm: true,
    buildPrompt: buildKnowledgePrompt,
    timeoutMs: 90 * 60 * 1000, // 90 minutes — large repos need extensive tool_use scanning
  },

  form(ctx, detected, llmOutput): FormSchema {
    const { entries, diagnostic } = extractEntriesWithDiagnostic(llmOutput);

    if (diagnostic?.repaired) {
      ctx.logger.warn(
        {
          parseError: diagnostic.parseError,
          bodyLength: diagnostic.bodyLength,
          errorPosition: diagnostic.errorPosition,
          snippet: diagnostic.snippet,
          recoveredCount: diagnostic.recoveredCount,
        },
        'kb-acquisition: strict JSON.parse failed but jsonrepair salvaged the entries',
      );
    } else if (entries.length === 0 && llmOutput && diagnostic) {
      ctx.logger.warn(
        {
          parseError: diagnostic.parseError,
          bodyLength: diagnostic.bodyLength,
          errorPosition: diagnostic.errorPosition,
          snippet: diagnostic.snippet,
        },
        'kb-acquisition: LLM output failed JSON.parse and jsonrepair could not recover',
      );
    }

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
        ],
        submitLabel: 'Generate knowledge base',
      };
    }

    // Fallback: no LLM output available, or LLM emitted unparseable JSON.
    const fw = detected.framework;
    const placeholderHints = [
      'testing strategy',
      'deployment and CI/CD',
      'database and migrations',
      fw ? `${fw}-specific patterns` : 'framework patterns',
      'code conventions',
      'API design',
    ];
    const description = diagnostic
      ? `The AI ran but its JSON output failed to parse (${diagnostic.parseError} — body length ${diagnostic.bodyLength}, error at position ${diagnostic.errorPosition}). List the topics you want documented manually, one per line; stub files will be created for each.`
      : 'Automatic knowledge discovery was not available. List the topics you want documented in your knowledge base, one per line. Stub files will be created for each topic.';
    return {
      title: diagnostic
        ? 'Knowledge base — AI output unparseable'
        : 'Knowledge base — manual topic entry',
      description,
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
    const routedForIndex: RoutedEntry[] = [];

    if (llmAvailable) {
      // LLM path: filter to user-selected entries, then route into the canonical
      // KB layout (core / TECH_PATTERNS / ANTI_PATTERNS / topic).
      const selected = new Set(values.selectedTopics ?? []);
      const selectedEntries = entries.filter((e) => selected.has(e.id));
      const routed = routeEntries(selectedEntries);
      for (const r of routed) {
        const filePath = path.join(kbDir, r.relPath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, entryToMarkdown(r.entry), 'utf8');
        written.push({ id: r.entry.id, filePath, source: 'llm' });
        routedForIndex.push(r);
      }
    } else {
      // Fallback path: write stubs from manual topic list at the KB root (flat).
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
        const relPath = `${id}.md`;
        const filePath = path.join(kbDir, relPath);
        await writeFile(filePath, stubMarkdown(title), 'utf8');
        written.push({ id, filePath, source: 'stub' });
        routedForIndex.push({
          entry: { id, title, sections: [] },
          relPath,
          bucket: 'topic',
          key: id,
        });
      }
    }

    if (routedForIndex.length > 0) {
      const indexPath = path.join(kbDir, 'INDEX.md');
      await writeFile(indexPath, kbIndexMarkdown(routedForIndex, detected.projectName), 'utf8');
    }

    ctx.logger.info(
      { written: written.length, llmAvailable, topicCount: entries.length },
      'knowledge base written',
    );
    return { written, topicCount: entries.length, llmAvailable };
  },
};

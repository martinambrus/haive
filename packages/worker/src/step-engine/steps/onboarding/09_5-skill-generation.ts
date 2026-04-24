import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { CliProviderName, DetectResult, FormSchema } from '@haive/shared';
import { getCliProviderMetadata } from '@haive/shared';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching, loadPreviousStepOutput, pathExists } from './_helpers.js';
import type { KbFileSummary } from './09-qa.js';

const DEFAULT_PROJECT_SKILLS_DIR = '.claude/skills';

async function resolveSkillTargetDirs(ctx: StepContext): Promise<string[]> {
  const rows = await ctx.db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.userId, ctx.userId),
    columns: { name: true, enabled: true },
  });
  const targets = new Set<string>();
  for (const row of rows) {
    if (!row.enabled) continue;
    const dir = getCliProviderMetadata(row.name as CliProviderName).projectSkillsDir;
    if (dir) targets.add(dir);
  }
  return targets.size > 0 ? Array.from(targets) : [DEFAULT_PROJECT_SKILLS_DIR];
}

interface SkillGenDetect {
  framework: string | null;
  language: string | null;
  kbFiles: KbFileSummary[];
  /** Repo-relative directories where skills should be written. One entry per
   *  unique `projectSkillsDir` across all *enabled* CLI providers (claude/zai/amp
   *  collapse to `.claude/skills`; gemini has `.gemini/skills`; codex has
   *  `.agents/skills`). Apply writes each skill + sub-skills to every target. */
  skillTargetDirs: string[];
  /** Transient — file tree handed to the LLM prompt; stripped before persisting. */
  __fileTree?: string;
}

interface SkillGenApply {
  written: {
    id: string;
    /** Canonical path inside the first target dir (kept for backwards compat
     *  with log/UI consumers). */
    filePath: string;
    /** Every target dir this skill was mirrored into. */
    mirroredDirs: string[];
    subSkillCount: number;
  }[];
  totalSubSkills: number;
  droppedFromCap: number;
  rejectedIds: string[];
}

interface SkillKeyConcept {
  term: string;
  definition: string;
}

interface SkillNamedBlock {
  name: string;
  body: string;
}

interface SkillPitfall {
  title: string;
  body: string;
}

interface SkillCodeLocation {
  label: string;
  path: string;
}

export interface SkillSubSkill {
  /** Filename slug — kebab-case, no extension. Becomes `sub-skills/<slug>.md`. */
  slug: string;
  /** Full unique frontmatter `name` — by convention `<parent-id>-<slug>`. */
  name: string;
  /** H1 title rendered at the top of the sub-skill file. */
  title: string;
  /** Activation description shown in sub-skill frontmatter. */
  description: string;
  /** Optional grouping shown in parent SKILL.md's `## Sub-Skills` section. */
  category?: string;
  /** Short line shown next to the sub-skill link in the parent SKILL.md. */
  summary: string;
  /** Full markdown body of the sub-skill file (appears after the Identification block). */
  body: string;
  /** Optional extra rows for the Identification block (Parent row is auto-added). */
  identification?: { label: string; value: string }[];
}

export interface SkillRelated {
  /** Path from this skill's dir — e.g. `../statistics/SKILL.md`. */
  path: string;
  summary: string;
}

export interface SkillEntry {
  id: string;
  title: string;
  description: string;
  /** Fallback catch-all body when structured sections are absent. */
  instructions?: string;
  quickStart?: string;
  overview?: string;
  keyConcepts?: SkillKeyConcept[];
  /** Optional markdown table block — rendered under `## Quick Reference`. */
  quickReference?: string;
  decisionTree?: string;
  implementationPatterns?: SkillNamedBlock[];
  pitfalls?: SkillPitfall[];
  codeLocations?: SkillCodeLocation[];
  usage?: string;
  /** Progressive-disclosure leaves. Each entry writes to `sub-skills/<slug>.md`. */
  subSkills?: SkillSubSkill[];
  /** Cross-references to other skills in the same workspace. */
  relatedSkills?: SkillRelated[];
  /** Common-patterns block — shown under `## Common Patterns`. */
  commonPatterns?: SkillNamedBlock[];
}

const DEFAULT_MAX_SKILLS = 15;
const HARD_MAX_SKILLS = 30;
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.ddev',
  '.claude',
]);

/* ------------------------------------------------------------------ */
/* Detect helpers                                                      */
/* ------------------------------------------------------------------ */

function parseKbFile(text: string): { title: string; sectionHeadings: string[] } {
  const lines = text.split('\n');
  let title = '';
  const sectionHeadings: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!title) {
      const h1 = /^#\s+(.+)$/.exec(line);
      if (h1 && h1[1]) {
        title = h1[1].trim();
        continue;
      }
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2 && h2[1]) sectionHeadings.push(h2[1].trim());
  }
  return { title, sectionHeadings };
}

async function listKbFiles(repoRoot: string): Promise<KbFileSummary[]> {
  const kbDir = path.join(repoRoot, '.claude', 'knowledge_base');
  if (!(await pathExists(kbDir))) return [];
  const out: KbFileSummary[] = [];
  await collectKbDir(kbDir, kbDir, out);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

async function collectKbDir(rootDir: string, current: string, out: KbFileSummary[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectKbDir(rootDir, full, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    let text: string;
    try {
      text = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseKbFile(text);
    const relInsideKb = path.relative(rootDir, full);
    out.push({
      id: relInsideKb.replace(/\.md$/, ''),
      title: parsed.title || relInsideKb,
      relPath: path.join('.claude', 'knowledge_base', relInsideKb),
      sectionHeadings: parsed.sectionHeadings,
    });
  }
}

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
  const capped = files.slice(0, 150);
  const tree = capped.join('\n');
  return capped.length < files.length
    ? tree + `\n[...truncated, ${files.length - capped.length} more files]`
    : tree;
}

/* ------------------------------------------------------------------ */
/* ID sanitization                                                     */
/* ------------------------------------------------------------------ */

/** Coerce an LLM-proposed skill id into a safe kebab-case directory name.
 *  Strips a trailing `-skill` artefact (heritage from earlier prompts that
 *  appended it to KB filenames) and rejects empty results. */
export function sanitizeSkillId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let id = raw
    .trim()
    .toLowerCase()
    .replace(/[_\s/\\.]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (id.endsWith('-skill')) id = id.slice(0, -'-skill'.length).replace(/-+$/g, '');
  if (id.length === 0) return null;
  if (id.length > 64) id = id.slice(0, 64).replace(/-+$/g, '');
  return id;
}

/* ------------------------------------------------------------------ */
/* LLM output parsing                                                  */
/* ------------------------------------------------------------------ */

export class SkillGenParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillGenParseError';
  }
}

export function parseSkillEntries(raw: unknown): SkillEntry[] {
  if (!raw) return [];
  let source: unknown = raw;
  if (typeof raw === 'object' && raw !== null && 'result' in (raw as Record<string, unknown>)) {
    source = (raw as Record<string, unknown>).result;
  }
  if (Array.isArray(source)) {
    return source.filter(isValidSkill);
  }
  if (typeof source === 'object' && source !== null) {
    const asObj = source as Record<string, unknown>;
    if (Array.isArray(asObj.skills)) {
      return (asObj.skills as unknown[]).filter(isValidSkill);
    }
    return [];
  }
  if (typeof source !== 'string') return [];
  const out: SkillEntry[] = [];
  const fenceRe = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  const bodies: string[] = [];
  while ((match = fenceRe.exec(source)) !== null) {
    if (match[1]) bodies.push(match[1]);
  }
  if (bodies.length === 0) bodies.push(source);
  for (const body of bodies) {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) {
        for (const item of parsed) if (isValidSkill(item)) out.push(item);
      } else if (isValidSkill(parsed)) {
        out.push(parsed);
      } else if (
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>).skills)
      ) {
        for (const item of (parsed as Record<string, unknown>).skills as unknown[]) {
          if (isValidSkill(item)) out.push(item);
        }
      }
    } catch {
      // fall through to salvage scan below
    }
  }
  if (out.length === 0) {
    // Fall back to scanning the entire source — fences inside sub-skill bodies
    // (e.g. ```javascript) can trip up the non-greedy outer fence regex.
    const scanTargets = bodies.includes(source) ? bodies : [...bodies, source];
    for (const body of scanTargets) {
      for (const candidate of extractBalancedObjects(body)) {
        try {
          const parsed = JSON.parse(candidate);
          if (isValidSkill(parsed)) {
            out.push(parsed);
          } else if (
            typeof parsed === 'object' &&
            parsed !== null &&
            Array.isArray((parsed as Record<string, unknown>).skills)
          ) {
            for (const item of (parsed as Record<string, unknown>).skills as unknown[]) {
              if (isValidSkill(item)) out.push(item);
            }
          }
        } catch {
          continue;
        }
      }
    }
  }
  return dedupeById(out);
}

function extractBalancedObjects(source: string): string[] {
  const out: string[] = [];
  const candidateRe = /\{\s*"/g;
  let cursor = 0;
  while (cursor < source.length) {
    candidateRe.lastIndex = cursor;
    const m = candidateRe.exec(source);
    if (!m) break;
    const end = findBalancedObjectEnd(source, m.index);
    if (end < 0) break;
    out.push(source.slice(m.index, end + 1));
    cursor = end + 1;
  }
  return out;
}

function findBalancedObjectEnd(source: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function dedupeById(entries: SkillEntry[]): SkillEntry[] {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const e of entries) {
    const key = typeof e.id === 'string' ? e.id.trim().toLowerCase() : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function isValidSkill(val: unknown): val is SkillEntry {
  if (!val || typeof val !== 'object') return false;
  const v = val as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.trim().length === 0) return false;
  if (typeof v.title !== 'string' || v.title.trim().length === 0) return false;
  if (typeof v.description !== 'string' || v.description.trim().length === 0) return false;
  const hasBody =
    typeof v.instructions === 'string' ||
    typeof v.quickStart === 'string' ||
    typeof v.overview === 'string' ||
    Array.isArray(v.keyConcepts) ||
    typeof v.decisionTree === 'string' ||
    Array.isArray(v.implementationPatterns) ||
    Array.isArray(v.pitfalls) ||
    Array.isArray(v.codeLocations) ||
    (Array.isArray(v.subSkills) && (v.subSkills as unknown[]).length > 0);
  return hasBody;
}

function isValidSubSkill(val: unknown): val is SkillSubSkill {
  if (!val || typeof val !== 'object') return false;
  const v = val as Record<string, unknown>;
  return (
    typeof v.slug === 'string' &&
    v.slug.trim().length > 0 &&
    typeof v.name === 'string' &&
    v.name.trim().length > 0 &&
    typeof v.title === 'string' &&
    v.title.trim().length > 0 &&
    typeof v.description === 'string' &&
    v.description.trim().length > 0 &&
    typeof v.summary === 'string' &&
    v.summary.trim().length > 0 &&
    typeof v.body === 'string' &&
    v.body.trim().length > 0
  );
}

export function sanitizeSubSkills(entry: SkillEntry): SkillSubSkill[] {
  if (!entry.subSkills) return [];
  const seen = new Set<string>();
  const out: SkillSubSkill[] = [];
  for (const raw of entry.subSkills) {
    if (!isValidSubSkill(raw)) continue;
    const slug = raw.slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ ...raw, slug });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Markdown rendering                                                  */
/* ------------------------------------------------------------------ */

function renderKeyConcepts(items: SkillKeyConcept[]): string[] {
  return items
    .filter((c) => c && typeof c.term === 'string' && typeof c.definition === 'string')
    .map((c) => `- **${c.term.trim()}** — ${c.definition.trim()}`);
}

function renderNamedBlocks(items: SkillNamedBlock[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (!item || typeof item.name !== 'string' || typeof item.body !== 'string') continue;
    out.push(`### ${item.name.trim()}`, '', item.body.trim(), '');
  }
  return out;
}

function renderPitfalls(items: SkillPitfall[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (!item || typeof item.title !== 'string' || typeof item.body !== 'string') continue;
    out.push(`### ${item.title.trim()}`, '', item.body.trim(), '');
  }
  return out;
}

function renderCodeLocations(items: SkillCodeLocation[]): string[] {
  return items
    .filter((c) => c && typeof c.label === 'string' && typeof c.path === 'string')
    .map((c) => `- **${c.label.trim()}** — \`${c.path.trim()}\``);
}

function renderSubSkillsBlock(subs: SkillSubSkill[]): string[] {
  if (subs.length === 0) return [];
  const groups = new Map<string, SkillSubSkill[]>();
  for (const s of subs) {
    const key = s.category && s.category.trim().length > 0 ? s.category.trim() : 'Topics';
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  const out: string[] = ['## Sub-Skills', ''];
  for (const [cat, list] of groups) {
    if (groups.size > 1) out.push(`### ${cat}`, '');
    for (const s of list) {
      out.push(`- [sub-skills/${s.slug}.md](./sub-skills/${s.slug}.md) - ${s.summary.trim()}`);
    }
    out.push('');
  }
  return out;
}

function decisionTreeFromSubSkills(subs: SkillSubSkill[]): string {
  const lines = ['```', 'Working in this domain?'];
  for (const s of subs) lines.push(`|-- ${s.title}? -> See sub-skills/${s.slug}.md`);
  lines.push('```');
  return lines.join('\n');
}

function renderRelatedSkills(items: SkillRelated[]): string[] {
  return items
    .filter((r) => r && typeof r.path === 'string' && typeof r.summary === 'string')
    .map((r) => `- [${r.path.trim()}](${r.path.trim()}) - ${r.summary.trim()}`);
}

function yamlDescription(desc: string): string {
  const clean = desc.trim();
  if (clean.length <= 120 && !clean.includes('\n')) return `description: ${clean}`;
  const wrapped = clean.replace(/\s+/g, ' ').match(/.{1,78}(?:\s|$)/g) ?? [clean];
  return ['description: >', ...wrapped.map((line) => `  ${line.trim()}`)].join('\n');
}

export function skillToMarkdown(entry: SkillEntry): string {
  const subs = sanitizeSubSkills(entry);
  const fm = ['---', `name: ${entry.id}`, yamlDescription(entry.description), '---', ''].join('\n');
  const body: string[] = [`# ${entry.title}`, ''];

  if (entry.quickStart && entry.quickStart.trim().length > 0) {
    body.push('## Quick Start', '', entry.quickStart.trim(), '');
  }

  body.push('## Overview', '');
  body.push((entry.overview ?? entry.description).trim(), '');

  if (entry.keyConcepts && entry.keyConcepts.length > 0) {
    const rendered = renderKeyConcepts(entry.keyConcepts);
    if (rendered.length > 0) {
      body.push('## Key Concepts', '', ...rendered, '');
    }
  }

  if (entry.quickReference && entry.quickReference.trim().length > 0) {
    body.push('## Quick Reference', '', entry.quickReference.trim(), '');
  }

  if (entry.decisionTree && entry.decisionTree.trim().length > 0) {
    body.push('## Decision Tree', '', entry.decisionTree.trim(), '');
  } else if (subs.length > 0) {
    body.push('## Decision Tree', '', decisionTreeFromSubSkills(subs), '');
  }

  body.push(...renderSubSkillsBlock(subs));

  if (entry.relatedSkills && entry.relatedSkills.length > 0) {
    const rendered = renderRelatedSkills(entry.relatedSkills);
    if (rendered.length > 0) {
      body.push('## Related Skills', '', ...rendered, '');
    }
  }

  if (entry.implementationPatterns && entry.implementationPatterns.length > 0) {
    const rendered = renderNamedBlocks(entry.implementationPatterns);
    if (rendered.length > 0) {
      body.push('## Implementation Patterns', '', ...rendered);
    }
  }

  if (entry.commonPatterns && entry.commonPatterns.length > 0) {
    const rendered = renderNamedBlocks(entry.commonPatterns);
    if (rendered.length > 0) {
      body.push('## Common Patterns', '', ...rendered);
    }
  }

  if (entry.pitfalls && entry.pitfalls.length > 0) {
    const rendered = renderPitfalls(entry.pitfalls);
    if (rendered.length > 0) {
      body.push('## Pitfalls and Edge Cases', '', ...rendered);
    }
  }

  if (entry.codeLocations && entry.codeLocations.length > 0) {
    const rendered = renderCodeLocations(entry.codeLocations);
    if (rendered.length > 0) {
      body.push('## Code Locations', '', ...rendered, '');
    }
  }

  if (entry.instructions && entry.instructions.trim().length > 0) {
    body.push('## Additional Notes', '', entry.instructions.trim(), '');
  }

  if (entry.usage && entry.usage.trim().length > 0) {
    body.push('## Usage', '', entry.usage.trim(), '');
  }

  return fm + body.join('\n');
}

export function subSkillToMarkdown(parentId: string, sub: SkillSubSkill): string {
  const fm = ['---', `name: ${sub.name}`, yamlDescription(sub.description), '---', ''].join('\n');
  const ident: string[] = ['## Identification', ''];
  if (sub.identification) {
    for (const row of sub.identification) {
      if (!row || typeof row.label !== 'string' || typeof row.value !== 'string') continue;
      ident.push(`- **${row.label.trim()}**: ${row.value.trim()}`);
    }
  }
  ident.push(`- **Parent**: [${parentId}/SKILL.md](../SKILL.md)`);
  ident.push('');

  return [fm, `# ${sub.title}`, '', ...ident, sub.body.trim(), ''].join('\n');
}

export function skillsReadmeMarkdown(
  written: { id: string; title: string; description: string }[],
  skillsDir: string = DEFAULT_PROJECT_SKILLS_DIR,
): string {
  const rows = [...written].sort((a, b) => a.id.localeCompare(b.id));
  const lines: string[] = [
    '# Skills Index',
    '',
    'Domain-specific knowledge for this codebase. Agents load a SKILL.md when working on the matching domain, then drill down into `sub-skills/` as needed.',
    '',
    '## Skill Architecture',
    '',
    '- **SKILLS**: business/domain knowledge (WHAT to build). Live here.',
    '- **Progressive disclosure**: metadata (always) -> SKILL.md (when triggered) -> sub-skills (when specific topic needed).',
    '',
    '## Domains',
    '',
    '| Skill | Summary |',
    '|-------|---------|',
  ];
  for (const r of rows) {
    const desc = r.description.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
    lines.push(`| [${r.id}](./${r.id}/SKILL.md) | ${desc} |`);
  }
  lines.push('');
  lines.push('## Directory Layout');
  lines.push('');
  lines.push('```');
  lines.push(`${skillsDir}/`);
  lines.push('  {domain}/');
  lines.push('    SKILL.md                 # domain overview with YAML frontmatter');
  lines.push('    sub-skills/');
  lines.push('      {topic}.md             # drill-down docs (one per topic)');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* LLM prompt                                                          */
/* ------------------------------------------------------------------ */

function buildPrompt(args: LlmBuildArgs): string {
  const detected = args.detected as SkillGenDetect;
  const values = args.formValues as { maxSkills?: number; domainHints?: string };
  const maxSkills = clampMaxSkills(values.maxSkills);
  const hints = typeof values.domainHints === 'string' ? values.domainHints.trim() : '';

  const fileTree = detected.__fileTree ?? '(no file tree available)';
  const kbList =
    detected.kbFiles.length > 0
      ? detected.kbFiles
          .map(
            (f) =>
              `- ${f.relPath} — ${f.title}` +
              (f.sectionHeadings.length > 0
                ? `\n    sections: ${f.sectionHeadings.slice(0, 8).join('; ')}`
                : ''),
          )
          .join('\n')
      : '(no knowledge base files yet)';

  const primarySkillsDir = detected.skillTargetDirs[0] ?? DEFAULT_PROJECT_SKILLS_DIR;
  const mirroredDirsNote =
    detected.skillTargetDirs.length > 1
      ? ` (mirrored to ${detected.skillTargetDirs.map((d) => `\`${d}/\``).join(', ')} so every enabled CLI sees the same skills)`
      : '';
  return [
    'You are a senior software engineer generating Claude Code SKILLS for this specific codebase.',
    '',
    '## Critical definitions',
    '',
    '- **AGENTS** capture technical expertise (HOW to use a framework). They live in `.claude/agents/`. NOT your concern here.',
    '- **SKILLS** capture business/domain capabilities of THIS project — discrete features the code',
    `  exposes that an agent might need to understand or modify. They live in \`${primarySkillsDir}/\`${mirroredDirsNote}.`,
    '- A skill is a CAPABILITY DOMAIN, NOT a documentation chapter.',
    '',
    '## What a good skill looks like',
    '',
    'GOOD skill ids (kebab-case, name a discrete capability):',
    '  parallel-detection, pty-wrapping, hook-installation, rate-limit-detection,',
    '  session-timing, settings-management, sound-notifications, stall-detection,',
    '  task-tracking, timing-log, statistics, update-checking',
    '',
    'BAD skill ids (DO NOT EMIT THESE — they mirror documentation taxonomies, not capabilities):',
    '  api-reference, architecture, business-logic, coding-standards, deployment,',
    '  index, security-standards, anything ending in `-skill`, anything matching a',
    '  knowledge-base filename verbatim.',
    '',
    'Note: KB files like `BUSINESS_LOGIC.md`, `ARCHITECTURE.md` are REFERENCE MATERIAL that you',
    'CONSULT to understand the project. They are NOT skills. Do not propose a skill per KB file.',
    '',
    '## Project context',
    '',
    `Framework: ${detected.framework ?? 'unknown'}`,
    `Language: ${detected.language ?? 'unknown'}`,
    '',
    '## Existing knowledge base (consult these for domain understanding)',
    '',
    kbList,
    '',
    '## Repository overview (partial file tree)',
    '',
    '```',
    fileTree,
    '```',
    '',
    hints.length > 0 ? `## User-supplied hints about likely skill domains\n\n${hints}\n` : '',
    '## Your task',
    '',
    'Use your file-reading tools (Read, Grep, Glob) to deeply explore this repository:',
    '1. Read the knowledge base files listed above for domain context.',
    '2. Scan the source tree (src/, lib/, bin/, app/, packages/, modules/, etc.) — each focused module',
    '   or feature flag often corresponds to a skill domain.',
    '3. Identify CAPABILITY-BASED skill domains. Each domain should be something a future agent',
    '   would need to understand WHEN modifying or extending that part of the code.',
    `4. Produce between 3 and ${maxSkills} skills. Quality over quantity. If the codebase is small,`,
    '   produce fewer skills.',
    '',
    '## Required structure per skill',
    '',
    `Each skill is a directory \`${primarySkillsDir}/<id>/\` containing:`,
    '  - `SKILL.md` — concise overview with YAML frontmatter (the loader)',
    '  - `sub-skills/<slug>.md` — 3 to 8 leaf documents covering distinct facets of the domain',
    '',
    'SKILL.md MUST be lightweight (under ~1000 tokens of body). It indexes the sub-skills.',
    'Sub-skills carry the detail. Each sub-skill is a focused leaf doc.',
    '',
    '## JSON output format',
    '',
    'Emit ONE JSON object inside a single ```json fenced code block:',
    '',
    '```json',
    '{',
    '  "skills": [',
    '    {',
    '      "id": "<kebab-case capability id — NOT a KB filename, NOT ending in -skill>",',
    '      "title": "<Title Case skill title>",',
    '      "description": "<activation description for SKILL.md frontmatter — include trigger keywords>",',
    '      "quickStart": "<short code block or command demonstrating typical usage — optional>",',
    '      "overview": "<1-2 paragraphs: what this domain covers, when an agent invokes it, why it exists in this codebase>",',
    '      "keyConcepts": [ { "term": "<term>", "definition": "<one-sentence definition>" } ],',
    '      "quickReference": "<optional markdown table summarising constants and sources>",',
    '      "decisionTree": "<optional markdown block routing the reader to the right sub-skill>",',
    '      "relatedSkills": [ { "path": "../<other-skill>/SKILL.md", "summary": "<one line>" } ],',
    '      "codeLocations": [ { "label": "<human label>", "path": "<concrete repo-relative path>" } ],',
    '      "subSkills": [',
    '        {',
    '          "slug": "<kebab-case filename, no extension>",',
    '          "name": "<full frontmatter name — convention: <skill-id>-<slug>>",',
    '          "title": "<H1 title of the sub-skill file>",',
    '          "description": "<activation description in sub-skill frontmatter>",',
    '          "category": "<optional grouping shown under ## Sub-Skills in parent>",',
    '          "summary": "<short line shown beside the sub-skill link in parent SKILL.md>",',
    '          "body": "<full markdown body with ## Purpose, ## Process, ## Code Pattern, ## Pitfalls, ## Related>",',
    '          "identification": [ { "label": "Function", "value": "lib/foo.mjs::bar" } ]',
    '        }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '## Hard rules',
    '',
    '- Ground every claim in concrete repo paths (e.g. `lib/wrapper.mjs::startWrapper`, NOT "the wrapper module").',
    '- Each skill MUST have at least 3 sub-skills (and at most 8).',
    `- Cap: at most ${maxSkills} top-level skills. Quality over quantity.`,
    '- Skill ids: kebab-case, lowercase, no `-skill` suffix, no underscores, max 64 chars.',
    '- Do NOT emit prose outside the fenced JSON block.',
    '- Do NOT propose generic skills like "general-knowledge", "project-overview", "documentation".',
    '- If the codebase has fewer than 3 distinct capability domains, emit fewer skills — never pad.',
  ]
    .filter((line) => line !== '')
    .concat([''])
    .join('\n');
}

function clampMaxSkills(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_MAX_SKILLS;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > HARD_MAX_SKILLS) return HARD_MAX_SKILLS;
  return n;
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const skillGenerationStep: StepDefinition<SkillGenDetect, SkillGenApply> = {
  metadata: {
    id: '09_5-skill-generation',
    workflowType: 'onboarding',
    index: 11,
    title: 'Skill generation',
    description:
      'LLM scans the repository and the knowledge base, identifies capability-based domain skills, and writes .claude/skills/<id>/SKILL.md plus sub-skills/<slug>.md files for each.',
    requiresCli: true,
    providerSensitive: true,
  },

  async detect(ctx: StepContext): Promise<SkillGenDetect> {
    await ctx.emitProgress('Loading project metadata...');
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (envPrev?.detect as DetectResult | null)?.data as
      | { project?: { framework?: string; primaryLanguage?: string } }
      | undefined;
    const framework = envData?.project?.framework ?? null;
    const language = envData?.project?.primaryLanguage ?? null;

    const skillTargetDirs = await resolveSkillTargetDirs(ctx);

    await ctx.emitProgress('Listing existing knowledge base...');
    const kbFiles = await listKbFiles(ctx.repoPath);

    await ctx.emitProgress('Collecting file tree for LLM orientation...');
    const fileTree = await collectShortFileTree(ctx.repoPath);

    ctx.logger.info(
      { framework, language, kbFileCount: kbFiles.length, skillTargetDirs },
      'skill-generation detect complete',
    );
    return { framework, language, kbFiles, skillTargetDirs, __fileTree: fileTree };
  },

  form(_ctx, _detected): FormSchema {
    return {
      title: 'Generate domain skills',
      description: [
        'The LLM will scan the repository and the knowledge base, then propose CAPABILITY-based domain skills',
        '(e.g. "parallel-detection", "pty-wrapping" — never "API_REFERENCE-skill" or "ARCHITECTURE-skill").',
        'Each skill is written as `.claude/skills/<id>/SKILL.md` plus 3-8 sub-skill files under `sub-skills/`.',
      ].join(' '),
      fields: [
        {
          type: 'number',
          id: 'maxSkills',
          label: 'Maximum number of skills to generate',
          description:
            'Cap on top-level skills. The LLM may produce fewer if the codebase is small.',
          default: DEFAULT_MAX_SKILLS,
          min: 1,
          max: HARD_MAX_SKILLS,
          step: 1,
        },
        {
          type: 'textarea',
          id: 'domainHints',
          label: 'Domain hints for the LLM (optional)',
          description: [
            'List capabilities you know exist in this codebase, one per line — the LLM treats them as hints,',
            'not requirements. Leave blank to let the LLM discover everything.',
            '',
            'Examples (for a CLI wrapper project):',
            '- parallel session detection',
            '- PTY child process management',
            '- rate-limit warnings from upstream',
          ].join('\n'),
          rows: 6,
          placeholder: 'one domain hint per line, or leave blank',
        },
      ],
      submitLabel: 'Generate skills',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use', 'file_write'],
    buildPrompt,
    timeoutMs: 60 * 60 * 1000,
    bypassStub: () => ({
      skills: [
        {
          id: 'fixture-skill',
          title: 'Fixture skill',
          description:
            'Synthetic skill emitted by the bypass stub so smoke tests can exercise the full skill-write pipeline without a real CLI provider.',
          overview:
            'Smoke-test placeholder. Real skill generation is gated on a live LLM with file-reading tools.',
          subSkills: [
            {
              slug: 'fixture-leaf-a',
              name: 'fixture-skill-fixture-leaf-a',
              title: 'Fixture leaf A',
              description: 'Synthetic sub-skill A for smoke coverage.',
              summary: 'first sub-skill',
              body: '## Purpose\n\nSmoke-test sub-skill A.',
            },
            {
              slug: 'fixture-leaf-b',
              name: 'fixture-skill-fixture-leaf-b',
              title: 'Fixture leaf B',
              description: 'Synthetic sub-skill B for smoke coverage.',
              summary: 'second sub-skill',
              body: '## Purpose\n\nSmoke-test sub-skill B.',
            },
            {
              slug: 'fixture-leaf-c',
              name: 'fixture-skill-fixture-leaf-c',
              title: 'Fixture leaf C',
              description: 'Synthetic sub-skill C for smoke coverage.',
              summary: 'third sub-skill',
              body: '## Purpose\n\nSmoke-test sub-skill C.',
            },
          ],
        },
      ],
    }),
  },

  async apply(ctx, args): Promise<SkillGenApply> {
    const values = args.formValues as { maxSkills?: number };
    const maxSkills = clampMaxSkills(values.maxSkills);

    const detected = args.detected as SkillGenDetect;
    const targetDirs =
      detected.skillTargetDirs && detected.skillTargetDirs.length > 0
        ? detected.skillTargetDirs
        : [DEFAULT_PROJECT_SKILLS_DIR];

    const entries = parseSkillEntries(args.llmOutput ?? null);
    if (entries.length === 0) {
      throw new SkillGenParseError(
        'LLM produced no valid skill entries — surface failure for retry.',
      );
    }

    const seenIds = new Set<string>();
    const rejectedIds: string[] = [];
    const accepted: SkillEntry[] = [];
    for (const entry of entries) {
      const cleanId = sanitizeSkillId(entry.id);
      if (!cleanId) {
        rejectedIds.push(String(entry.id));
        continue;
      }
      if (seenIds.has(cleanId)) {
        rejectedIds.push(`${entry.id} (duplicate of ${cleanId})`);
        continue;
      }
      seenIds.add(cleanId);
      accepted.push({ ...entry, id: cleanId });
    }

    if (accepted.length === 0) {
      throw new SkillGenParseError(
        'No skill entries survived id sanitization — surface failure for retry.',
      );
    }

    const droppedFromCap = Math.max(0, accepted.length - maxSkills);
    const final = accepted.slice(0, maxSkills);

    const written: SkillGenApply['written'] = [];
    const summaryForReadme: { id: string; title: string; description: string }[] = [];
    let totalSubSkills = 0;

    // Render each skill + sub-skill markdown once; mirror to every target dir.
    for (const entry of final) {
      const skillMd = skillToMarkdown(entry);
      const subs = sanitizeSubSkills(entry);
      const renderedSubs = subs.map((sub) => ({
        slug: sub.slug,
        content: subSkillToMarkdown(entry.id, sub),
      }));

      let primaryPath = '';
      for (const targetDir of targetDirs) {
        const parts = targetDir.split('/').filter((p) => p.length > 0);
        const dir = path.join(ctx.repoPath, ...parts, entry.id);
        await mkdir(dir, { recursive: true });
        const filePath = path.join(dir, 'SKILL.md');
        await writeFile(filePath, skillMd, 'utf8');
        if (!primaryPath) primaryPath = filePath;

        if (renderedSubs.length > 0) {
          const subDir = path.join(dir, 'sub-skills');
          await mkdir(subDir, { recursive: true });
          for (const rs of renderedSubs) {
            const subPath = path.join(subDir, `${rs.slug}.md`);
            await writeFile(subPath, rs.content, 'utf8');
          }
        }
      }

      totalSubSkills += renderedSubs.length;
      written.push({
        id: entry.id,
        filePath: primaryPath,
        mirroredDirs: targetDirs,
        subSkillCount: renderedSubs.length,
      });
      summaryForReadme.push({ id: entry.id, title: entry.title, description: entry.description });
    }

    if (summaryForReadme.length > 0) {
      for (const targetDir of targetDirs) {
        const parts = targetDir.split('/').filter((p) => p.length > 0);
        const readmePath = path.join(ctx.repoPath, ...parts, 'README.md');
        await mkdir(path.dirname(readmePath), { recursive: true });
        await writeFile(readmePath, skillsReadmeMarkdown(summaryForReadme, targetDir), 'utf8');
      }
    }

    ctx.logger.info(
      {
        written: written.length,
        totalSubSkills,
        droppedFromCap,
        rejectedIds: rejectedIds.length,
      },
      'skills written',
    );
    return { written, totalSubSkills, droppedFromCap, rejectedIds };
  },
};

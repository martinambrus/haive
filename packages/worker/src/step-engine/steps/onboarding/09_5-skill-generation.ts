import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { DetectResult, FormSchema } from '@haive/shared';
import { skillEntrySchema } from '@haive/shared';
import type { AgentMiningDispatch, StepContext, StepDefinition } from '../../step-definition.js';
import {
  listFilesMatching,
  loadPreviousStepOutput,
  pathExists,
  resolveSkillTargetDirs,
} from './_helpers.js';
import { extractFencedJsonObjects, parseJsonLoose } from '../_fenced-json.js';
import { jsonrepair } from 'jsonrepair';
import type { KbFileSummary } from './09-qa.js';
import { buildSkillContractBlocks } from './_skill-prompt.js';

const DEFAULT_PROJECT_SKILLS_DIR = '.claude/skills';

interface SkillGenDetect {
  framework: string | null;
  language: string | null;
  kbFiles: KbFileSummary[];
  /** Business-capability names derived deterministically from BUSINESS_LOGIC.md
   *  H2 sections. Fed to the prompt as a coverage checklist and used to enforce
   *  a minimum skill count so a single under-producing LLM pass cannot collapse
   *  to one skill. Empty when no BUSINESS_LOGIC.md exists. */
  requiredDomains: string[];
  /** Repo-relative directories where skills should be written. One entry per
   *  unique `projectSkillsDir` across all *enabled* CLI providers (claude/zai/amp
   *  collapse to `.claude/skills`; gemini has `.gemini/skills`; codex has
   *  `.agents/skills`). Apply writes each skill + sub-skills to every target. */
  skillTargetDirs: string[];
  /** Skills imported from custom bundles for this repo. Written to disk first
   *  in apply(); their IDs are also passed to the LLM so it can avoid
   *  regenerating any of them. */
  bundleSkills: SkillEntry[];
  /** Transient — file tree handed to the LLM prompt; stripped before persisting. */
  __fileTree?: string;
}

interface SkillGenApply {
  written: {
    id: string;
    /** Carried so the README index can be rebuilt from the cumulative set on
     *  every loop iteration without re-reading the prior skill files. */
    title: string;
    description: string;
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
  /** LLM skills dropped because they carried zero sub-skills (the truncation
   *  signal). Empty on a clean pass; surfaced for visibility in the step output. */
  droppedForSubSkills: string[];
  /* --- Loop control state (carried across iterations; read by loop.shouldContinue,
   *  which has no access to formValues). Each apply() returns the CUMULATIVE result
   *  so the loop's final pass output is the complete library. --- */
  /** Clamped skill cap from the form (caps the cumulative LLM-skill count). */
  maxSkills: number;
  /** deterministic = iterate the BUSINESS_LOGIC.md capability list (>=3 known);
   *  discovery = generate-next-until-the-model-signals-done (small/no BL.md). */
  mode: 'deterministic' | 'discovery';
  /** Deterministic target skill count (capability-list length, capped). 0 in
   *  discovery mode (bounded by maxSkills instead). */
  targetCount: number;
  /** Count of NEW valid LLM skills produced by the most recent pass. 0 = dry. */
  lastBatchCount: number;
  /** Cumulative LLM-generated skill count (excludes bundle skills); capped by maxSkills. */
  llmSkillCount: number;
  /** Consecutive dry passes. Bounds in-loop re-rolls before the loop gives up. */
  consecutiveEmpty: number;
}

// Skill IR types (SkillEntry, SkillSubSkill, supporting shapes) live in
// @haive/shared so the bundle parser, web UI, and worker share one source
// of truth. Re-exported here so existing worker imports keep resolving.
import type {
  SkillCodeLocation,
  SkillEntry,
  SkillKeyConcept,
  SkillNamedBlock,
  SkillPitfall,
  SkillRelated,
  SkillSubSkill,
} from '@haive/shared';
export type {
  SkillCodeLocation,
  SkillEntry,
  SkillKeyConcept,
  SkillNamedBlock,
  SkillPitfall,
  SkillRelated,
  SkillSubSkill,
};

const DEFAULT_MAX_SKILLS = 15;
const HARD_MAX_SKILLS = 30;
/** Consecutive dry (zero-new-skill) loop passes tolerated before the skill-gen
 *  loop gives up — bounds in-loop re-rolls of a flaky/empty single-skill pass. */
const MAX_EMPTY_PASSES = 2;
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

export async function listKbFiles(repoRoot: string): Promise<KbFileSummary[]> {
  const kbDir = path.join(repoRoot, '.claude', 'knowledge_base');
  if (!(await pathExists(kbDir))) return [];
  const out: KbFileSummary[] = [];
  await collectKbDir(kbDir, kbDir, out);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

// Section headings that are document scaffolding rather than business
// capabilities — excluded when deriving required skill domains.
const NON_DOMAIN_SECTION_RE =
  /^(overview|index|introduction|intro|summary|table of contents|contents|notes?|references?|see also|glossary|source files?|files?|file list|directory (layout|structure)|structure)$/i;

/** Deterministically derive the project's business-capability domains from the
 *  knowledge base — the H2 sections of BUSINESS_LOGIC.md. Each section is a
 *  capability that should map to a skill. Returns [] when BUSINESS_LOGIC.md is
 *  absent, so callers degrade gracefully. */
export function deriveRequiredDomains(kbFiles: KbFileSummary[]): string[] {
  const biz = kbFiles.find(
    (f) => /(^|\/)business[_-]?logic\.md$/i.test(f.relPath) || /business[_-]?logic/i.test(f.id),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const heading of biz?.sectionHeadings ?? []) {
    const name = heading.trim();
    if (!name || NON_DOMAIN_SECTION_RE.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
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

export async function collectShortFileTree(repoPath: string): Promise<string> {
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

/** Load every skill surfaced by an active custom bundle bound to this repo.
 *  Bundle skills are written to disk first in apply() and their IDs are
 *  passed to the LLM so it can avoid regenerating any of them (bundle wins
 *  on collision). */
async function loadBundleSkills(ctx: StepContext): Promise<SkillEntry[]> {
  const taskRow = await ctx.db
    .select({ repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, ctx.taskId))
    .limit(1);
  const repositoryId = taskRow[0]?.repositoryId ?? null;
  if (!repositoryId) return [];

  const items = await ctx.db
    .select({
      sourcePath: schema.customBundleItems.sourcePath,
      normalizedSpec: schema.customBundleItems.normalizedSpec,
    })
    .from(schema.customBundleItems)
    .innerJoin(schema.customBundles, eq(schema.customBundleItems.bundleId, schema.customBundles.id))
    .where(
      and(
        eq(schema.customBundles.repositoryId, repositoryId),
        eq(schema.customBundleItems.kind, 'skill'),
      ),
    );

  const out: SkillEntry[] = [];
  for (const item of items) {
    const parsed = skillEntrySchema.safeParse(item.normalizedSpec);
    if (!parsed.success) continue;
    out.push(parsed.data);
  }
  return out;
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

/** Push every valid SkillEntry found in a parsed JSON value into `out`. Accepts a
 *  bare array, a single skill object, or a `{ skills: [...] }` wrapper. */
function collectSkillsFrom(parsed: unknown, out: SkillEntry[]): void {
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
      collectSkillsFrom(JSON.parse(body), out);
    } catch {
      // fall through to salvage scan below
    }
  }
  if (out.length === 0) {
    // Fall back to scanning the entire source — fences inside sub-skill bodies
    // (e.g. ```javascript) can trip up the non-greedy outer fence regex.
    const scanTargets = bodies.includes(source) ? bodies : [...bodies, source];
    for (const body of scanTargets) {
      for (const candidate of extractFencedJsonObjects(body)) {
        try {
          collectSkillsFrom(JSON.parse(candidate), out);
        } catch {
          // strict parse failed; try a jsonrepair pass on this object candidate
          try {
            collectSkillsFrom(JSON.parse(jsonrepair(candidate)), out);
          } catch {
            continue;
          }
        }
      }
    }
  }
  // Final salvage tier: jsonrepair the whole source via parseJsonLoose. The only
  // tier that recovers an unterminated string / dropped comma / truncated tail the
  // balance-scan above cannot slice (e.g. an unescaped quote inside a sub-skill
  // body). Mirrors the salvage used by 09-qa / 09_1 / 09_2.
  if (out.length === 0) {
    const loose = parseJsonLoose(source);
    if (loose) collectSkillsFrom(loose, out);
  }
  return dedupeById(out);
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

/** True when the entry has at least one valid sub-skill after sanitization.
 *  A truncated LLM pass often yields a skill that passes isValidSkill but
 *  carries zero sub-skills; apply() drops those (the prompt mandates >=3) so a
 *  partial pass cannot ship a half-written skill library. */
export function hasSubSkills(entry: SkillEntry): boolean {
  return sanitizeSubSkills(entry).length > 0;
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

/** Loop chunking plan. deterministic = the BUSINESS_LOGIC.md capability list is
 *  large enough (>=3) to drive an exact per-capability iteration count; discovery
 *  = let the model surface capabilities until it signals done. See the step loop. */
function computeDomainPlan(
  detected: SkillGenDetect,
  maxSkills: number,
): { mode: 'deterministic' | 'discovery'; domains: string[] } {
  const required = detected.requiredDomains ?? [];
  if (required.length >= 3) {
    return { mode: 'deterministic', domains: required.slice(0, maxSkills) };
  }
  return { mode: 'discovery', domains: required };
}

/** Skill ids already on disk (bundle + every prior loop pass). The newest loop
 *  pass's cumulative `written` already folds in the bundle skills, so on
 *  iteration 0 (no prior passes) fall back to the bundle ids directly. */
function coveredSkillIds(
  previousIterations: { applyOutput: unknown }[],
  bundleSkills: SkillEntry[],
): string[] {
  const last = previousIterations.at(-1)?.applyOutput as SkillGenApply | undefined;
  if (last?.written && last.written.length > 0) return last.written.map((w) => w.id);
  return bundleSkills.map((s) => s.id);
}

/** Per-skill prompt. Each loop pass asks for EXACTLY ONE new skill so the output
 *  of any single CLI invocation stays small — the fix for output-token truncation
 *  on CLIs (e.g. Amp) whose single-response ceiling we cannot raise. Deterministic
 *  mode walks the capability checklist; discovery mode asks for the next uncovered
 *  capability and lets the model return an empty array to signal done. */
function buildSkillPrompt(
  detected: SkillGenDetect,
  formValues: Record<string, unknown>,
  previousIterations: { applyOutput: unknown }[],
  truncationRetries = 0,
  targetCapability?: string,
): string {
  const values = formValues as { maxSkills?: number; domainHints?: string };
  const maxSkills = clampMaxSkills(values.maxSkills);
  const hints = typeof values.domainHints === 'string' ? values.domainHints.trim() : '';
  const plan = computeDomainPlan(detected, maxSkills);
  const covered = coveredSkillIds(previousIterations, detected.bundleSkills ?? []);
  const requiredDomains = detected.requiredDomains ?? [];
  // Shrink the request on a re-dispatch after the model hit its output cap, so the
  // retry fits. truncationRetries=0 reproduces the normal 8 / 100-250 mandate.
  const maxSub = Math.max(3, 8 - 2 * truncationRetries); // 8, 6, 4, then floor 3
  const bodyLen = truncationRetries > 0 ? '80-150' : '100-250';
  const shrinkNote =
    truncationRetries > 0
      ? `## A previous attempt was cut off — produce a SMALLER skill\n\nThe last attempt at this skill exceeded the model's output-token limit and was truncated. This time emit at most ${maxSub} sub-skills with ${bodyLen}-line bodies and be concise. A COMPLETE smaller skill is required; a cut-off response fails again.\n`
      : '';

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
  const bundleSkillIds = (detected.bundleSkills ?? []).map((s) => s.id);
  const reservedSection =
    bundleSkillIds.length > 0
      ? [
          '## Reserved skill ids (already imported from custom bundles — DO NOT regenerate)',
          '',
          ...bundleSkillIds.map((id) => `- ${id}`),
          '',
        ].join('\n')
      : '';
  const coveredSection =
    covered.length > 0
      ? [
          '## Skills ALREADY generated (do NOT regenerate or duplicate any of these)',
          '',
          ...covered.map((id) => `- ${id}`),
          '',
          'Pick a DIFFERENT, not-yet-covered capability. You MAY reference these by id in `relatedSkills`.',
          '',
        ].join('\n')
      : '';
  const checklistSection =
    requiredDomains.length > 0
      ? [
          '## Business capabilities to cover (from BUSINESS_LOGIC.md)',
          '',
          'These ARE capability domains (not documentation chapters). Name the skill for the capability',
          'and ground it in the relevant code, not just the KB text.',
          '',
          ...requiredDomains.map((d) => `- ${d}`),
          '',
        ].join('\n')
      : '';

  // Single-skill task line. When targetCapability is set (a parallel agentMining
  // dispatch pins one capability), generate exactly that one. Otherwise the
  // sequential modes pick the next uncovered capability / discover one.
  const taskLine = targetCapability
    ? `Produce EXACTLY ONE skill for this specific capability: "${targetCapability}". Name the skill for this capability and ground it in the relevant code, not just the KB text.`
    : plan.mode === 'deterministic'
      ? 'From the capability checklist above, pick the FIRST capability NOT yet represented by an already-generated skill, and produce EXACTLY ONE skill for it. The orchestrator calls you once per capability until all are covered.'
      : `Produce EXACTLY ONE skill for the next distinct capability NOT already covered. The orchestrator calls you repeatedly. When every distinct capability this codebase exposes is already covered (up to ${maxSkills} total), return an empty array: \`{ "skills": [] }\` — do NOT pad with generic filler.`;

  return [
    'You are a senior software engineer generating ONE Claude Code SKILL for this specific codebase.',
    '',
    shrinkNote,
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
    'Note: KB files like `BUSINESS_LOGIC.md`, `ARCHITECTURE.md` are REFERENCE MATERIAL you CONSULT to',
    'understand the project — do not NAME a skill after a KB file (api-reference, architecture).',
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
    reservedSection,
    coveredSection,
    checklistSection,
    '## Repository overview (partial file tree)',
    '',
    '```',
    fileTree,
    '```',
    '',
    hints.length > 0 ? `## User-supplied hints about likely skill domains\n\n${hints}\n` : '',
    '## Your task',
    '',
    'Use your file-reading tools (Read, Grep, Glob) to deeply explore this repository, then:',
    taskLine,
    '',
    '## Required structure for the skill',
    '',
    'DO NOT write, create, edit, or install any files on disk. You are NOT the installer.',
    'The orchestrator that called you will create the file tree from your JSON response;',
    'attempts to invoke `write_file`, `edit_file`, shell `cat > ...`, `mkdir`, `cp`, `mv`,',
    'or any other file-modifying tool will cause the whole step to fail. Use only',
    'read-only exploration tools (Read, Grep, Glob, Bash for read-only commands).',
    '',
    `Conceptually the skill maps to a directory \`${primarySkillsDir}/<id>/\` containing:`,
    '  - `SKILL.md` — concise overview with YAML frontmatter (the loader)',
    `  - \`sub-skills/<slug>.md\` — 3 to ${maxSub} leaf documents covering distinct facets of the domain`,
    '',
    'This is the SHAPE the orchestrator will materialise from your JSON, not a',
    'set of files you create yourself. Your only output is the JSON below.',
    '',
    'SKILL.md MUST be lightweight (under ~1000 tokens of body). It indexes the sub-skills.',
    `Sub-skills carry the detail. Each sub-skill is a focused leaf doc and SHOULD be ${bodyLen} lines.`,
    '',
    ...buildSkillContractBlocks(maxSub, bodyLen),
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
    // A weak local model can corrupt the generated skill library (mann1x's
    // caliber case); block local Ollama here by default.
    unsafeForLocalModels: true,
  },

  async detect(ctx: StepContext): Promise<SkillGenDetect> {
    await ctx.emitProgress('Loading project metadata...');
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (envPrev?.detect as DetectResult | null)?.data as
      | { project?: { framework?: string; primaryLanguage?: string } }
      | undefined;
    const framework = envData?.project?.framework ?? null;
    const language = envData?.project?.primaryLanguage ?? null;

    const skillTargetDirs = await resolveSkillTargetDirs(ctx.db, ctx.userId, [
      DEFAULT_PROJECT_SKILLS_DIR,
    ]);

    await ctx.emitProgress('Listing existing knowledge base...');
    const kbFiles = await listKbFiles(ctx.repoPath);
    const requiredDomains = deriveRequiredDomains(kbFiles);

    await ctx.emitProgress('Loading bundle skills...');
    const bundleSkills = await loadBundleSkills(ctx);

    await ctx.emitProgress('Collecting file tree for LLM orientation...');
    const fileTree = await collectShortFileTree(ctx.repoPath);

    ctx.logger.info(
      {
        framework,
        language,
        kbFileCount: kbFiles.length,
        requiredDomainCount: requiredDomains.length,
        skillTargetDirs,
        bundleSkillCount: bundleSkills.length,
      },
      'skill-generation detect complete',
    );
    return {
      framework,
      language,
      kbFiles,
      requiredDomains,
      skillTargetDirs,
      bundleSkills,
      __fileTree: fileTree,
    };
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
    // Deterministic mode runs the bulk generation in PARALLEL via agentMining at
    // iteration 0, so skip the sequential bulk llm call there. Iterations > 0 are the
    // loop's gap-fill for any capability the parallel batch missed — let llm run then.
    // Discovery mode (no fixed list to parallelize) always runs llm.
    skipIf: ({ detected, formValues, iteration }) =>
      computeDomainPlan(
        detected as SkillGenDetect,
        clampMaxSkills((formValues as { maxSkills?: number }).maxSkills),
      ).mode === 'deterministic' && (iteration ?? 0) === 0,
    // Iteration 0 prompt; iterations > 0 use loop.buildIterationPrompt below. Each
    // pass asks for ONE skill so a single CLI invocation never blows the model's
    // output-token ceiling (the Amp max_tokens failure this step is chunked to fix).
    buildPrompt: (args) =>
      buildSkillPrompt(
        args.detected as SkillGenDetect,
        (args.formValues ?? {}) as Record<string, unknown>,
        [],
      ),
    timeoutMs: 60 * 60 * 1000,
    // No llm.retry: step-runner skips llm.retry for loop steps (they own their
    // re-dispatch counting). Flaky/empty passes are re-rolled inside the loop via
    // the consecutive-empty counter — see loop.shouldContinue + apply() below.
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

  // Parallel bulk (deterministic only): one cli-exec per BUSINESS_LOGIC capability,
  // fanned out via the agent-mining barrier (read-only, no worktrees, capped by
  // MAX_PARALLEL_AGENTS). apply() ingests these at iteration 0; any capability whose
  // parallel call failed is gap-filled by the loop's sequential shrink-retry below.
  // Returns [] for discovery (no fixed list) and under test bypass, leaving the
  // llm + loop path to run unchanged.
  agentMining: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 60 * 60 * 1000,
    async selectAgents({ detected, formValues }): Promise<AgentMiningDispatch[]> {
      if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
      const det = detected as SkillGenDetect;
      const fv = formValues as Record<string, unknown>;
      const maxSkills = clampMaxSkills((fv as { maxSkills?: number }).maxSkills);
      const plan = computeDomainPlan(det, maxSkills);
      if (plan.mode !== 'deterministic') return [];
      return plan.domains.map((capability, i) => ({
        // Unique per capability (task_step_agent_minings is keyed by (step, agentId)).
        agentId: `cap-${i}-${sanitizeSkillId(capability) ?? 'x'}`.slice(0, 120),
        agentTitle: capability,
        prompt: buildSkillPrompt(det, fv, [], 0, capability),
      }));
    },
  },

  // Chunked generation: one skill per LLM pass so a single CLI invocation never
  // exceeds the model's output-token ceiling (the Amp max_tokens failure). apply()
  // returns the CUMULATIVE library each pass, so the loop's final output is whole.
  loop: {
    // Generous ceiling; shouldContinue drives the real count. Allows up to the hard
    // skill cap plus in-loop re-rolls of flaky/empty passes. (resolveLoopBudget
    // falls through to this because the form field is `maxSkills`, not maxIterations.)
    maxIterations: HARD_MAX_SKILLS * 2 + 4,
    buildIterationPrompt: ({ detected, formValues, previousIterations, truncationRetries }) =>
      buildSkillPrompt(
        detected as SkillGenDetect,
        formValues as Record<string, unknown>,
        previousIterations,
        truncationRetries ?? 0,
      ),
    shouldContinue: ({ applyOutput }) => {
      const out = applyOutput as SkillGenApply;
      if (out.mode === 'deterministic') {
        // One skill per capability; stop once every capability is covered.
        if (out.llmSkillCount >= out.targetCount) return false;
        if (out.lastBatchCount > 0) return true;
        // Dry pass with capabilities still uncovered: re-roll within budget.
        return out.consecutiveEmpty < MAX_EMPTY_PASSES;
      }
      // Discovery: bounded by maxSkills. The model signals done with an empty array.
      if (out.llmSkillCount >= out.maxSkills) return false;
      if (out.lastBatchCount > 0) return true;
      if (out.llmSkillCount >= 1) return false; // model says done and we have skills
      return out.consecutiveEmpty < MAX_EMPTY_PASSES; // nothing yet → re-roll
    },
  },

  async apply(ctx, args): Promise<SkillGenApply> {
    const values = args.formValues as { maxSkills?: number };
    const maxSkills = clampMaxSkills(values.maxSkills);

    const detected = args.detected as SkillGenDetect;
    const targetDirs =
      detected.skillTargetDirs && detected.skillTargetDirs.length > 0
        ? detected.skillTargetDirs
        : [DEFAULT_PROJECT_SKILLS_DIR];

    const bundleSkills = detected.bundleSkills ?? [];
    const plan = computeDomainPlan(detected, maxSkills);

    // Prior cumulative state — each loop pass extends the previous one so the
    // loop's final output is the complete library. Iteration 0 has no prior.
    const prior =
      (args.previousIterations.at(-1)?.applyOutput as SkillGenApply | undefined) ?? null;
    const priorWritten = prior?.written ?? [];

    // Ids already on disk: bundle ids + everything prior passes wrote.
    const seenIds = new Set<string>([
      ...bundleSkills.map((s) => s.id),
      ...priorWritten.map((w) => w.id),
    ]);

    // This pass asked for ONE new skill. Accept it only if new, valid, sub-skill-
    // bearing, and under the LLM cap. Empty/duplicate/zero-sub-skill output is a
    // dry pass — the loop re-rolls or stops (shouldContinue + give-up check below)
    // instead of throwing, since loop steps get no llm.retry.
    let llmSkillCount = prior?.llmSkillCount ?? 0;
    let droppedFromCap = prior?.droppedFromCap ?? 0;
    const rejectedThisPass: string[] = [];
    const droppedForSubSkillsThisPass: string[] = [];
    const accepted: SkillEntry[] = [];
    // Candidate skills for this pass. Iteration 0 in deterministic mode comes from the
    // parallel agentMining batch (one result per capability); the loop's sequential
    // gap-fill (iterations > 0) and discovery mode come from llmOutput. Mining results
    // are ingested only at iteration 0 — on later passes they are already in
    // prior.written and would just dedup-reject.
    const candidates: SkillEntry[] = [];
    if (args.iteration === 0) {
      for (const r of args.agentMiningResults ?? []) {
        if (r.status === 'done') candidates.push(...parseSkillEntries(r.output ?? r.rawOutput));
      }
    }
    candidates.push(...parseSkillEntries(args.llmOutput ?? null));
    for (const entry of candidates) {
      const cleanId = sanitizeSkillId(entry.id);
      if (!cleanId) {
        rejectedThisPass.push(String(entry.id));
        continue;
      }
      if (seenIds.has(cleanId)) {
        rejectedThisPass.push(`${entry.id} (duplicate of ${cleanId})`);
        continue;
      }
      // Zero sub-skills = the truncation/under-production signal the prompt forbids.
      if (!hasSubSkills(entry)) {
        droppedForSubSkillsThisPass.push(cleanId);
        continue;
      }
      if (llmSkillCount >= maxSkills) {
        droppedFromCap += 1;
        rejectedThisPass.push(`${entry.id} (over maxSkills cap of ${maxSkills})`);
        continue;
      }
      seenIds.add(cleanId);
      accepted.push({ ...entry, id: cleanId });
      llmSkillCount += 1;
    }

    // Bundle skills are user-supplied and written once, on the first pass.
    const toWrite: SkillEntry[] = args.iteration === 0 ? [...bundleSkills, ...accepted] : accepted;

    // Render + write each new skill (and the bundle on pass 0) to every target dir.
    const newWritten: SkillGenApply['written'] = [];
    let newSubSkills = 0;
    for (const entry of toWrite) {
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

      newSubSkills += renderedSubs.length;
      newWritten.push({
        id: entry.id,
        title: entry.title,
        description: entry.description,
        filePath: primaryPath,
        mirroredDirs: targetDirs,
        subSkillCount: renderedSubs.length,
      });
    }

    const written = [...priorWritten, ...newWritten];

    // Rebuild the README index from the cumulative set every pass (deterministic,
    // code-only, no tokens) so it stays complete as skills accrue.
    if (written.length > 0) {
      for (const targetDir of targetDirs) {
        const parts = targetDir.split('/').filter((p) => p.length > 0);
        const readmePath = path.join(ctx.repoPath, ...parts, 'README.md');
        await mkdir(path.dirname(readmePath), { recursive: true });
        await writeFile(
          readmePath,
          skillsReadmeMarkdown(
            written.map((w) => ({ id: w.id, title: w.title, description: w.description })),
            targetDir,
          ),
          'utf8',
        );
      }
    }

    const lastBatchCount = accepted.length;
    const consecutiveEmpty = lastBatchCount > 0 ? 0 : (prior?.consecutiveEmpty ?? 0) + 1;
    const droppedForSubSkills = [
      ...(prior?.droppedForSubSkills ?? []),
      ...droppedForSubSkillsThisPass,
    ];
    const rejectedIds = [...(prior?.rejectedIds ?? []), ...rejectedThisPass];
    const totalSubSkills = (prior?.totalSubSkills ?? 0) + newSubSkills;

    // Give-up / floor enforcement: a dry pass after the re-roll budget is spent.
    // Loop steps get no llm.retry, so throwing here fails the step (the desired
    // terminal outcome) only when nothing usable was produced, or the
    // BUSINESS_LOGIC.md coverage floor (>=3 capabilities -> >=3 skills) is unmet.
    // Otherwise return the cumulative library and let shouldContinue stop the loop.
    if (lastBatchCount === 0 && consecutiveEmpty >= MAX_EMPTY_PASSES) {
      if (written.length === 0) {
        throw new SkillGenParseError(
          'Skill generation produced no skills after repeated empty passes — surface failure.',
        );
      }
      const minSkills = plan.mode === 'deterministic' ? Math.min(3, plan.domains.length) : 0;
      if (minSkills > 0 && llmSkillCount < minSkills) {
        throw new SkillGenParseError(
          `Only ${llmSkillCount} skill(s) generated but the project has ` +
            `${(detected.requiredDomains ?? []).length} business capabilities ` +
            `(minimum ${minSkills}) — surface failure for fuller coverage.`,
        );
      }
    }

    ctx.logger.info(
      {
        iteration: args.iteration,
        mode: plan.mode,
        newThisPass: lastBatchCount,
        totalWritten: written.length,
        llmSkillCount,
        totalSubSkills,
        consecutiveEmpty,
        droppedFromCap,
      },
      'skill-generation loop pass written',
    );

    return {
      written,
      totalSubSkills,
      droppedFromCap,
      rejectedIds,
      droppedForSubSkills,
      maxSkills,
      mode: plan.mode,
      targetCount: plan.mode === 'deterministic' ? plan.domains.length : 0,
      lastBatchCount,
      llmSkillCount,
      consecutiveEmpty,
    };
  },
};

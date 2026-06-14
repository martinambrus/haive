import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { jsonrepair } from 'jsonrepair';
import type { DetectResult, FormSchema } from '@haive/shared';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching, loadPreviousStepOutput, pathExists } from './_helpers.js';
import {
  resolveStackVersions,
  type ConfirmedStackValues,
  type GlobalKbCategory,
  type GlobalKbFacets,
} from '@haive/shared/global-kb';
import {
  clearTaskPromotedDrafts,
  globalKbTopicKey,
  promoteToGlobalKbDraft,
} from '../_global-kb-promote.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface KnowledgeDetect {
  framework: string | null;
  frameworkMajor: string | null;
  language: string | null;
  projectName: string | null;
  /** Major-version anchors for language/datastore-level global knowledge (PHP, the
   *  datastore), overlaid with the user's 02-confirmation overrides. Null when
   *  undetectable → such knowledge cannot be version-anchored and stays local. */
  phpMajor: string | null;
  nodeMajor: string | null;
  database: string | null;
  dbMajor: string | null;
  /** Installed direct deps as `name@major` (from 01-env-detect). Used to scope and
   *  to VERIFY a global entry's module/package version anchor. */
  packages: string[];
  /** Custom-vs-dependency code path prefixes (from 01-env-detect). `include` = this
   *  repo's own custom code; `exclude` = contrib/core/vendor. Used to tell repo-private
   *  code from public modules when deciding global vs local. */
  customCode: { include: string[]; exclude: string[] };
  /** Transient — file tree for LLM prompt, stripped before persisting. */
  __fileTree?: string;
  /** Transient — README excerpt for LLM prompt context. */
  __readmeExcerpt?: string;
  /** Transient — pre-existing KB files (from a prior orchestration) the LLM
   *  should reuse + re-place rather than regenerate. Stripped before persisting. */
  __existingKb?: ExistingKbFile[];
}

interface ExistingKbFile {
  /** Path under `.claude/knowledge_base/`, e.g. `ARCHITECTURE.md` or `old/notes.md`. */
  relPath: string;
  title: string;
}

interface KnowledgeApply {
  written: {
    id: string;
    filePath: string;
    source: 'llm' | 'stub' | 'existing' | 'updated' | 'global';
  }[];
  topicCount: number;
  llmAvailable: boolean;
  /** Count of entries promoted to the global KB as drafts (not written to disk). */
  globalPromoted: number;
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
  /** Routing decision (plan §5.4). `global` promotes the entry to the cross-repo
   *  KB as a draft instead of writing it into this repo's
   *  `.claude/knowledge_base/`. Defaults to `local`. */
  scope?: 'local' | 'global';
  /** Version/variant facets for a `global` entry (defaulted from the detected
   *  stack when the LLM omits them). Ignored for `local` entries. */
  facets?: GlobalKbFacets;
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

/** Pre-existing knowledge-base files (e.g. copied in from a prior orchestration)
 *  that the LLM should reuse + re-place rather than regenerate. Empty when the KB
 *  dir is absent — then the step behaves exactly as a fresh from-scratch mining.
 *  Reuses listFilesMatching + readFile (already imported); deliberately
 *  self-contained so it doesn't couple to the skill/qa steps. */
async function scanExistingKb(repoPath: string): Promise<ExistingKbFile[]> {
  const kbDir = path.join(repoPath, '.claude', 'knowledge_base');
  if (!(await pathExists(kbDir))) return [];
  const rels = await listFilesMatching(kbDir, (rel, isDir) => !isDir && rel.endsWith('.md'), 6);
  const out: ExistingKbFile[] = [];
  for (const rel of rels) {
    if (rel === 'INDEX.md') continue; // generated index, not content
    let title = rel;
    try {
      const text = await readFile(path.join(kbDir, rel), 'utf8');
      const m = text.match(/^#\s+(.+)$/m);
      if (m?.[1]) title = m[1].trim();
    } catch {
      /* keep the relPath as the title */
    }
    out.push({ relPath: rel, title });
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
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
  const existingKb = detected.__existingKb ?? [];
  const existingKbLines =
    existingKb.length > 0
      ? [
          '## Existing knowledge base (reuse + re-place — do NOT regenerate)',
          '',
          'These knowledge_base files already exist (e.g. copied in from a prior',
          'orchestration). READ each one with your tools, then for EACH file choose ONE:',
          '  - KEEP it verbatim: emit a `placements` entry mapping its path to its correct',
          '    slot in the canonical layout below (content is MOVED unchanged); OR',
          '  - IMPROVE it: if the file is STALE or INCOMPLETE versus the current code, emit an',
          '    `updates` entry for that path with improved `sections`. When improving you MUST',
          '    preserve all still-correct content, revise ONLY what is outdated, and add',
          '    genuinely new findings — never drop correct sections or rewrite from scratch.',
          '  Prefer KEEP unless a file is genuinely stale; either way it lands at its canonical',
          '  slot. Emit `entries` ONLY for topics that no existing file covers (genuine gaps).',
          '',
          ...existingKb.map((f) => `- ${f.relPath} — ${f.title}`),
          '',
        ]
      : [];

  return [
    'You are a senior software architect performing a deep knowledge audit of a codebase.',
    'Your goal: discover ALL significant knowledge topics and extract real, actionable content for each.',
    '',
    '## Project context',
    `Framework: ${detected.framework ?? 'unknown'}`,
    `Language: ${detected.language ?? 'unknown'}`,
    `Installed dependencies (name@major — use these EXACT tokens for module/package facets): ${
      detected.packages.length ? detected.packages.join(', ') : '(none detected)'
    }`,
    `This repo's OWN custom code lives under: ${
      detected.customCode.include.length ? detected.customCode.include.join(', ') : '(unknown)'
    }. Public/vendor code that is NOT this repo's: ${
      detected.customCode.exclude.length ? detected.customCode.exclude.join(', ') : '(unknown)'
    }.`,
    `PHP major version: ${detected.phpMajor ?? 'unknown'}. Datastore: ${
      detected.database ?? 'unknown'
    }${detected.dbMajor ? ` ${detected.dbMajor}` : ''}. Use these for language/datastore facets (phpMajor, and database + dbMajor).`,
    '',
    '## Repository overview (partial file tree)',
    '```',
    fileTree,
    '```',
    '',
    '## README excerpt',
    readme,
    '',
    ...existingKbLines,
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
    'If an existing KB file already covers a canonical or tech topic (you mapped it via `placements`), that topic is already satisfied — do NOT also emit an entry for it.',
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
    '      "scope": "local | global",',
    '      "facets": { "framework": ["<token>"], "language": ["<lang>"], "phpMajor": ["<n>"], "nodeMajor": ["<n>"] },',
    '      "sections": [',
    '        { "heading": "Section Name", "body": "Detailed markdown content..." }',
    '      ]',
    '    }',
    '  ],',
    '  "placements": [',
    '    { "path": "<existing knowledge_base file path from the list above>", "canonical": "ARCHITECTURE | API_REFERENCE | CODING_STANDARDS | TESTING_STANDARDS | SECURITY_STANDARDS | DEPLOYMENT | BUSINESS_LOGIC | (omit)", "category": "general | tech_pattern | anti_pattern | best_practice | quick_reference", "tech": "<tech slug, required when category is a tech bucket>", "scope": "local | global (omit for local)" }',
    '  ],',
    '  "updates": [',
    '    { "path": "<existing knowledge_base file to IMPROVE>", "title": "...", "canonical": "ARCHITECTURE | API_REFERENCE | CODING_STANDARDS | TESTING_STANDARDS | SECURITY_STANDARDS | DEPLOYMENT | BUSINESS_LOGIC | (omit)", "category": "general | tech_pattern | anti_pattern | best_practice | quick_reference", "tech": "<tech slug when a tech bucket>", "sections": [ { "heading": "Section", "body": "improved markdown — preserve correct content, revise stale parts, add new findings" } ] }',
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
    `- scope: choose "global" ONLY for a self-contained house standard about a PUBLIC subject — the framework core, a contrib/community module, a public package (the framework itself or one appearing in the installed dependencies above), the LANGUAGE itself (e.g. PHP), or the DATASTORE engine (e.g. MySQL/MariaDB). Explain it from that subject's OWN public API/docs/spec so the article stands alone WITHOUT this repo. A subject can be global even when it is specific (a single contrib module, or a single PHP/DB version); "global" means the subject is PUBLIC, not that it is framework- or language-agnostic. Even a fully custom, frameworkless project still yields global knowledge: generic PHP-only or MySQL/MariaDB-only practices that hold for ANY project on that PHP/DB version. Choose "local" (the DEFAULT) if the entry does ANY of: (a) names a function, class, hook, route, table, env var or config key defined in THIS repo's own custom code (as opposed to a documented part of a public API); (b) relies on a custom/project helper or sanitizer that is not part of a public API; (c) cites a file path under this repo's own custom code; (d) lists this repo's source files, or describes how THIS app is wired, its architecture or its business logic; (e) mixes portable advice with repo-specific detail (e.g. generic MySQL guidance entangled with THIS project's schema/queries) — keep the whole entry local unless the portable part stands fully on its own (pure generic PHP/SQL knowledge is NOT "mixed"). Anchor every global entry to an installed MAJOR version from the context above: a module/package entry sets facets.packages=["name@major"] (and is NOT filed as generic framework/language); a framework-general entry sets framework[+frameworkMajor]; a pure PHP entry sets language=["php"] + phpMajor; a pure datastore entry sets database (e.g. ["mysql"], or ["mysql","mariadb"] for engine-agnostic SQL) + dbMajor. If you cannot anchor it to an installed major (framework, package, PHP, or DB), choose "local". tech_pattern and general/canonical entries are ALWAYS "local". Rule of thumb: if deleting this repo would make the article wrong or meaningless, it is "local". When genuinely torn, choose "local".`,
    `- facets: ONLY for scope="global"; they scope which projects later retrieve the entry. MODULE/PACKAGE entry → facets.packages=["name@major"] from the installed dependencies above (do NOT also set framework/language). FRAMEWORK-general entry → framework=["${detected.framework ?? ''}"]${detected.frameworkMajor ? `, frameworkMajor=["${detected.frameworkMajor}"]` : ''}. PURE PHP entry → language=["php"]${detected.phpMajor ? `, phpMajor=["${detected.phpMajor}"]` : ''}. PURE DATASTORE entry → database=["${detected.database ?? 'mysql'}"]${detected.dbMajor ? `, dbMajor=["${detected.dbMajor}"]` : ''} (list multiple engines for engine-agnostic SQL). Every global entry MUST carry at least one installed major-version anchor (package@major, frameworkMajor, phpMajor, nodeMajor, or dbMajor) — if none applies, make the entry "local". Omitted dimensions apply to all.`,
    '- sections: at least 2 sections per entry with real extracted content, not generic advice.',
    '  - For LOCAL entries: include actual code patterns, specific config values, and real repo file paths with line ranges (e.g. `build.gradle:13-41`).',
    "  - For GLOBAL entries: cite ONLY the public subject's own API, config keys and official docs — never this repo's file paths, source-file lists or custom function names. If you can only explain it by pointing at this repo's own files, it is not global; mark it \"local\".",
    '  - Title and write each GLOBAL entry by the SUBJECT alone (e.g. "Vitest Quick Reference", NOT "Vitest Quick Reference for <thisProject>"); never put this project\'s name or package scope in a global title or body.',
    '  - Write as if explaining to a new team member who needs to understand this area.',
    '- placements: for each ACCURATE existing file, one object with its current `path` plus',
    '  the canonical/category/tech slot it belongs in (content moved verbatim). Omit BOTH',
    '  canonical and tech to leave a file exactly where it is. ANTI_PATTERNS, BEST_PRACTICES',
    '  and QUICK_REFERENCE files are house standards about a third-party framework / library /',
    '  plugin and are routed to the shared Global KB by DEFAULT (moved out of this repo as a',
    '  draft). Set `scope: "local"` on such a placement when the file names this repo\'s own custom code, paths, custom functions or business logic — anything not portable to another project on the same stack;',
    '  tech_pattern and general/canonical files always stay local.',
    '- updates: for each STALE or incomplete existing file, one object with its `path`, the',
    '  canonical/category/tech slot, and improved `sections` (preserve correct content,',
    '  revise outdated parts, add new findings). Use placements OR updates for a file, never',
    '  both. Both arrays are empty when there are no existing files.',
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

export interface KbPlacement {
  /** relPath under `.claude/knowledge_base/` of an existing file to re-place. */
  path: string;
  canonical?: string;
  category?: KbCategory;
  tech?: string;
  /** When 'global', this existing file is a reusable house standard: on apply it
   *  is MOVED to the cross-repo Global KB as a draft and deleted locally, instead
   *  of being re-placed in this repo. Defaults to 'local'. */
  scope?: 'local' | 'global';
}

function isValidPlacement(val: unknown): val is KbPlacement {
  if (!val || typeof val !== 'object') return false;
  const p = (val as Record<string, unknown>).path;
  return typeof p === 'string' && p.length > 0;
}

/** Best-effort extraction of the `placements` array (existing-KB re-placements).
 *  Kept SEPARATE from the entries parser — whose fence handling is deliberately
 *  tuned (see project memory) — so it can't regress it; mirrors the same fence
 *  layouts + jsonrepair safety net. */
export function parseKbPlacements(raw: unknown): KbPlacement[] {
  if (!raw) return [];
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.placements)) return (o.placements as unknown[]).filter(isValidPlacement);
    if (typeof o.result === 'string') return parseKbPlacements(o.result);
    return [];
  }
  if (typeof raw !== 'string') return [];
  const out: KbPlacement[] = [];
  const collect = (body: string | undefined): void => {
    if (!body || out.length > 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      try {
        parsed = JSON.parse(jsonrepair(body));
      } catch {
        return;
      }
    }
    const arr = (parsed as Record<string, unknown> | null)?.placements;
    if (Array.isArray(arr)) for (const p of arr) if (isValidPlacement(p)) out.push(p);
  };
  for (const m of raw.matchAll(/```json\s*([\s\S]*?)```/g)) collect(m[1]);
  if (out.length === 0) collect(raw.match(/```json\s*([\s\S]*)```/)?.[1]);
  if (out.length === 0) collect(raw.match(/```json\s*([\s\S]*)$/)?.[1]);
  return out;
}

export interface KbUpdate {
  /** relPath under `.claude/knowledge_base/` of the existing file to improve. */
  path: string;
  title: string;
  canonical?: string;
  category?: KbCategory;
  tech?: string;
  confidence?: 'high' | 'medium' | 'low';
  sourceFiles?: string[];
  sections: { heading: string; body: string }[];
}

function isValidUpdate(val: unknown): val is KbUpdate {
  if (!val || typeof val !== 'object') return false;
  const v = val as Record<string, unknown>;
  if (typeof v.path !== 'string' || v.path.length === 0) return false;
  if (typeof v.title !== 'string') return false;
  if (!Array.isArray(v.sections) || v.sections.length === 0) return false;
  for (const s of v.sections as unknown[]) {
    if (!s || typeof s !== 'object') return false;
    const section = s as Record<string, unknown>;
    if (typeof section.heading !== 'string' || typeof section.body !== 'string') return false;
  }
  return true;
}

/** Best-effort extraction of the `updates` array — improved replacements for stale
 *  existing KB files. Separate from the entries parser (deliberately tuned), like
 *  parseKbPlacements; mirrors the same fence layouts + jsonrepair safety net. */
export function parseKbUpdates(raw: unknown): KbUpdate[] {
  if (!raw) return [];
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.updates)) return (o.updates as unknown[]).filter(isValidUpdate);
    if (typeof o.result === 'string') return parseKbUpdates(o.result);
    return [];
  }
  if (typeof raw !== 'string') return [];
  const out: KbUpdate[] = [];
  const collect = (body: string | undefined): void => {
    if (!body || out.length > 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      try {
        parsed = JSON.parse(jsonrepair(body));
      } catch {
        return;
      }
    }
    const arr = (parsed as Record<string, unknown> | null)?.updates;
    if (Array.isArray(arr)) for (const u of arr) if (isValidUpdate(u)) out.push(u);
  };
  for (const m of raw.matchAll(/```json\s*([\s\S]*?)```/g)) collect(m[1]);
  if (out.length === 0) collect(raw.match(/```json\s*([\s\S]*)```/)?.[1]);
  if (out.length === 0) collect(raw.match(/```json\s*([\s\S]*)$/)?.[1]);
  return out;
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

/** Facets for a promoted global entry: the LLM's facets win, with framework /
 *  language filled from the detected stack when the LLM omitted them. A
 *  module-scoped entry (one that already carries a `packages` facet) is left scoped
 *  to its module/package alone — auto-stamping the whole framework/language would
 *  mislabel module know-how as generic stack knowledge and over-retrieve it. */
export function defaultGlobalFacets(entry: KbEntry, detected: KnowledgeDetect): GlobalKbFacets {
  const f: GlobalKbFacets = { ...(entry.facets ?? {}) };
  if (f.packages?.length) return f;
  // An entry the agent scoped to the language and/or datastore (and NOT the
  // framework) stays scoped to that dimension — don't widen it to the framework.
  const langOrDbScoped = !!(f.language?.length || f.database?.length) && !f.framework?.length;
  if (!langOrDbScoped) {
    if (!f.framework?.length && detected.framework) f.framework = [detected.framework];
    if (!f.frameworkMajor?.length && detected.frameworkMajor) {
      f.frameworkMajor = [detected.frameworkMajor];
    }
    if (!f.language?.length && detected.language) f.language = [detected.language.toLowerCase()];
  }
  // Stamp the detected major for a language/datastore-scoped entry that named the
  // dimension but omitted the major, so php-only / db-only globals can anchor.
  if (
    !f.framework?.length &&
    !f.phpMajor?.length &&
    detected.phpMajor &&
    f.language?.some((l) => l.toLowerCase() === 'php')
  ) {
    f.phpMajor = [detected.phpMajor];
  }
  if (!f.dbMajor?.length && detected.dbMajor && f.database?.length) {
    f.dbMajor = [detected.dbMajor];
  }
  return f;
}

/** Derive version-anchor facets for a deterministically-promoted tech-bucket entry
 *  from its `tech` slug + the detected stack, anchoring to what is actually
 *  installed: PHP → language+phpMajor; a datastore → database+dbMajor (installed
 *  engine + major); a detected dependency → packages; the framework →
 *  framework+frameworkMajor. When nothing anchors (e.g. jquery/fckeditor with no
 *  detectable version), no anchor is added and the caller keeps the entry local. */
export function techAnchorFacets(
  techRaw: string | undefined,
  base: GlobalKbFacets,
  detected: KnowledgeDetect,
): GlobalKbFacets {
  const f: GlobalKbFacets = { ...base };
  if (f.packages?.length) return f; // already module-scoped
  const tech = (techRaw ?? '').trim().toLowerCase();
  if (!tech) return f;

  // PHP language knowledge.
  if (tech === 'php' && detected.phpMajor) {
    f.language = ['php'];
    f.phpMajor = [detected.phpMajor];
    return f;
  }
  // Datastore knowledge — anchor to the INSTALLED engine + major.
  const isDbTech =
    ['mysql', 'mariadb', 'maria', 'sql'].includes(tech) || tech === detected.database;
  if (isDbTech && detected.database && detected.dbMajor) {
    const engines = new Set<string>([detected.database]);
    if (tech === 'mysql' || tech === 'mariadb') engines.add(tech);
    f.database = [...engines];
    f.dbMajor = [detected.dbMajor];
    return f;
  }
  // A detected dependency whose package name matches the tech slug.
  const pkg = detected.packages.find((p) => {
    const name = (p.split('@')[0] ?? '').toLowerCase();
    return name === tech || name.split('/').pop() === tech;
  });
  if (pkg) {
    f.packages = [pkg];
    return f;
  }
  // The framework itself.
  if (detected.framework && tech === detected.framework.toLowerCase() && detected.frameworkMajor) {
    f.framework = [detected.framework];
    f.frameworkMajor = [detected.frameworkMajor];
    return f;
  }
  return f; // no anchor derivable → caller keeps it local
}

/** Default global facets from the detected stack alone (no entry) — used when a
 *  re-routed existing file is promoted to a global draft. */
function detectedDefaultFacets(detected: KnowledgeDetect): GlobalKbFacets {
  const f: GlobalKbFacets = {};
  if (detected.framework) f.framework = [detected.framework];
  if (detected.frameworkMajor) f.frameworkMajor = [detected.frameworkMajor];
  if (detected.language) f.language = [detected.language.toLowerCase()];
  return f;
}

/* ------------------------------------------------------------------ */
/* Global-scope backstop: deterministically demote mis-tagged entries */
/* ------------------------------------------------------------------ */

/** Source-file extensions used to recognise a bare (root-level) repo file citation
 *  such as `core_functions.php:115-161`, which has no directory slash. */
const CODE_FILE_EXT =
  'php|inc|module|install|theme|phtml|engine|profile|js|jsx|mjs|cjs|ts|tsx|py|rb|go|java|rs|c|cc|cpp|h|hpp|sql|sh|pl|twig|vue|tpl';

/** Path-like tokens cited in markdown prose/code spans. Captures both
 *  directory-qualified paths (`src/foo/bar.php[:12-20]`) AND bare root-level source
 *  filenames (`core_functions.php[:115-161]`), so a citation of a repo file at the
 *  project root is still detected. Strips a trailing `:line`/`:line-line` range and
 *  a leading `./`, and dedupes. Over-capture (URLs, prose, non-existent files) is
 *  harmless — callers confirm against the real filesystem. */
export function extractCitedPaths(text: string): string[] {
  const out = new Set<string>();
  const slashed = /(?:^|[\s`("[])((?:\.\/)?[\w.-]+(?:\/[\w.-]+)+)(?::\d+(?:-\d+)?)?/g;
  for (let m = slashed.exec(text); m; m = slashed.exec(text)) {
    const raw = m[1];
    if (!raw) continue;
    const rel = raw.replace(/^\.\//, '');
    if (!(rel.split('/').pop() ?? '').includes('.')) continue; // need a file extension
    out.add(rel);
  }
  const bare = new RegExp(`(?:^|[\\s\`("\\[])([\\w-]+\\.(?:${CODE_FILE_EXT}))\\b`, 'gi');
  for (let m = bare.exec(text); m; m = bare.exec(text)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

/** Split a path into non-empty segments (leading `./` and trailing `/` stripped). */
function pathSegments(p: string): string[] {
  return p
    .replace(/^\.?\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
}

/** Whether `prefix`'s segments appear as a contiguous run anywhere in `pathSegs`,
 *  so a prefix holds across a `web/` docroot and through nested dependency dirs
 *  (e.g. `modules/custom` matches `web/modules/custom/foo/foo.module`). */
function pathHasPrefix(pathSegs: string[], prefix: string): boolean {
  const pre = pathSegments(prefix);
  if (pre.length === 0) return false;
  for (let i = 0; i + pre.length <= pathSegs.length; i++) {
    let ok = true;
    for (let j = 0; j < pre.length; j++) {
      if (pathSegs[i + j] !== pre[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** True when `rel` lives under one of the repo's custom-code prefixes and not under
 *  a dependency (contrib/core/vendor) prefix. */
export function isRepoOwnPath(
  rel: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  const pathSegs = pathSegments(rel);
  return (
    include.some((p) => pathHasPrefix(pathSegs, p)) &&
    !exclude.some((p) => pathHasPrefix(pathSegs, p))
  );
}

/** Common shared files whose presence does NOT make an article repo-specific. */
const SHARED_MANIFEST_BASENAMES = new Set([
  'composer.json',
  'composer.lock',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'readme.md',
  'license',
  'dockerfile',
  'docker-compose.yml',
  '.gitignore',
]);

/** Fallback repo-own test for projects with NO custom-code include prefixes (e.g.
 *  framework=general): a cited path is repo-own unless it sits under a dependency /
 *  ignored dir or is a known shared manifest. The caller still confirms the path
 *  resolves on disk, so only real in-repo files count (e.g. a root-level
 *  `core_functions.php`). */
export function isLikelyRepoOwnPath(rel: string, exclude: readonly string[]): boolean {
  const pathSegs = pathSegments(rel);
  if (pathSegs.length === 0) return false;
  if (pathSegs.some((s) => IGNORE_DIRS.has(s))) return false;
  if (exclude.some((p) => pathHasPrefix(pathSegs, p))) return false;
  const base = (pathSegs[pathSegs.length - 1] ?? '').toLowerCase();
  return !SHARED_MANIFEST_BASENAMES.has(base);
}

/** A global entry must be anchored to an INSTALLED major version: a `packages`
 *  facet matching an installed `name@major`, the detected framework major, or an
 *  explicit language major. Otherwise it cannot be version-scoped → keep local. */
export function hasInstalledVersionAnchor(
  facets: GlobalKbFacets,
  detected: {
    packages: string[];
    frameworkMajor: string | null;
    phpMajor: string | null;
    nodeMajor: string | null;
    dbMajor: string | null;
  },
): boolean {
  const norm = (s: string): string => s.trim().toLowerCase();
  const installed = new Set(detected.packages.map(norm));
  if (facets.packages?.some((p) => installed.has(norm(p)))) return true;
  // Every other anchor must MATCH what was actually detected/installed — a major
  // the agent invented (not in this project's stack) is not a valid anchor.
  const majorMatches = (values: string[] | undefined, detectedMajor: string | null): boolean =>
    !!(values?.length && detectedMajor && values.map(norm).includes(norm(detectedMajor)));
  return (
    majorMatches(facets.frameworkMajor, detected.frameworkMajor) ||
    majorMatches(facets.phpMajor, detected.phpMajor) ||
    majorMatches(facets.nodeMajor, detected.nodeMajor) ||
    majorMatches(facets.dbMajor, detected.dbMajor)
  );
}

/** First cited or sourced path that points at THIS repo's own custom code and
 *  exists on disk. Non-null → the knowledge depends on repo-private code, so it is
 *  not a portable house standard. No custom-code prefixes known → never fires. */
async function repoOwnRef(
  sectionsText: string,
  sourceFiles: string[] | undefined,
  detect: KnowledgeDetect,
  repoPath: string,
): Promise<string | null> {
  const { include, exclude } = detect.customCode;
  const candidates = [
    ...extractCitedPaths(sectionsText),
    ...(sourceFiles ?? []).map((s) => s.replace(/^\.\//, '').replace(/:\d+(?:-\d+)?$/, '')),
  ];
  for (const rel of candidates) {
    const repoOwn =
      include.length > 0 ? isRepoOwnPath(rel, include, exclude) : isLikelyRepoOwnPath(rel, exclude);
    if (repoOwn && (await pathExists(path.join(repoPath, rel)))) return rel;
  }
  return null;
}

/* Repo-defined-symbol backstop: a "global" article must not lean on a function or
 * class DEFINED in this repo (e.g. a custom helper like GetPHPVariables). */
const REPO_SYMBOL_FILE_CAP = 4000;
const REPO_SYMBOL_CAP = 40000;
const SYMBOL_SCAN_EXT: Record<string, string[]> = {
  php: ['.php', '.inc', '.module', '.install', '.theme', '.phtml', '.profile', '.engine'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  typescript: ['.ts', '.tsx'],
  python: ['.py'],
  ruby: ['.rb'],
  go: ['.go'],
};

/** Names of functions / classes / traits / interfaces DEFINED in this repo's own
 *  source (dependency/ignored dirs excluded). Best-effort and bounded; returns an
 *  empty set on any failure (the symbol backstop then simply never fires). */
async function collectRepoSymbols(repoPath: string, detect: KnowledgeDetect): Promise<Set<string>> {
  const symbols = new Set<string>();
  const lang = (detect.language ?? '').toLowerCase();
  const exts = SYMBOL_SCAN_EXT[lang] ?? ['.php', '.js', '.ts', '.py'];
  try {
    const files = await listFilesMatching(
      repoPath,
      (rel, isDir) => {
        if (isDir) return false;
        if (rel.split('/').some((p) => IGNORE_DIRS.has(p))) return false;
        const low = rel.toLowerCase();
        return exts.some((e) => low.endsWith(e));
      },
      10,
    );
    for (const rel of files.slice(0, REPO_SYMBOL_FILE_CAP)) {
      let text: string;
      try {
        text = await readFile(path.join(repoPath, rel), 'utf8');
      } catch {
        continue;
      }
      const body = text.length > 200_000 ? text.slice(0, 200_000) : text;
      const defRe = /\b(?:function|class|trait|interface)\s+([A-Za-z_]\w{4,})/g;
      for (let m = defRe.exec(body); m; m = defRe.exec(body)) {
        if (m[1]) symbols.add(m[1]);
      }
      if (symbols.size > REPO_SYMBOL_CAP) break;
    }
  } catch {
    // best effort — no symbol backstop on failure
  }
  return symbols;
}

/** First identifier in `text` used as a call / `new`/`::` reference that is also a
 *  repo-defined symbol — the article leans on repo-private code. Null when the
 *  symbol set is empty or nothing matches. (Min 5 chars to avoid prose collisions.) */
export function bodyUsesRepoSymbol(text: string, symbols: ReadonlySet<string>): string | null {
  if (symbols.size === 0) return null;
  const re = /\b([A-Za-z_]\w{4,})\s*\(|\bnew\s+([A-Za-z_]\w{4,})|\b([A-Za-z_]\w{4,})::/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name && symbols.has(name)) return name;
  }
  return null;
}

/** First level-1 markdown heading, else a Title-Cased name from the file path. */
export function titleFromMarkdown(content: string, relPath: string): string {
  const heading = content.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (heading) return heading;
  const stem = relPath.replace(/\.md$/i, '').split('/').pop() ?? relPath;
  return stem.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Map an existing KB file's subdir to a global category for re-routing. */
export function inferCategoryFromPath(relPath: string): GlobalKbCategory {
  if (relPath.startsWith('ANTI_PATTERNS/')) return 'anti_pattern';
  if (relPath.startsWith('BEST_PRACTICES/')) return 'best_practice';
  if (relPath.startsWith('QUICK_REFERENCE/')) return 'quick_reference';
  if (relPath.startsWith('TECH_PATTERNS/')) return 'tech_pattern';
  return 'general';
}

/** Whether an existing-file placement routes to the Global KB. anti_pattern /
 *  best_practice / quick_reference files are house standards ABOUT a third-party
 *  technology, so they default to global regardless of the per-file LLM scope tag,
 *  which proved unreliable (weak agents mark everything "local"). The user keeps
 *  one local by unticking the re-route in the form, and the apply backstop keeps
 *  repo-specific or unversioned files local anyway. An explicit `scope: 'global'`
 *  also promotes a general/canonical file; tech_pattern (how THIS repo uses a tech)
 *  and general/canonical files otherwise stay local. */
export function isGlobalRoutedPlacement(p: KbPlacement): boolean {
  if (p.scope === 'global') return true;
  return (
    p.category === 'anti_pattern' ||
    p.category === 'best_practice' ||
    p.category === 'quick_reference'
  );
}

/** Best-effort tech slug from an existing KB file path, used for the cross-repo
 *  dedup key when the placement carries no explicit `tech`. */
export function placementTech(relPath: string): string | null {
  if (relPath.startsWith('QUICK_REFERENCE/')) {
    const seg = relPath.slice('QUICK_REFERENCE/'.length).split('/')[0] ?? '';
    return seg.replace(/\.md$/i, '') || null;
  }
  for (const [prefix, suffix] of [
    ['ANTI_PATTERNS/', '-mistakes'],
    ['BEST_PRACTICES/', '-best-practices'],
  ] as const) {
    if (relPath.startsWith(prefix)) {
      let stem = relPath.slice(prefix.length).replace(/\.md$/i, '');
      if (stem.endsWith(suffix)) stem = stem.slice(0, -suffix.length);
      return stem || null;
    }
  }
  return null;
}

function entryToMarkdown(entry: KbEntry, opts: { includeSourceFiles?: boolean } = {}): string {
  const { includeSourceFiles = true } = opts;
  const lines: string[] = [`# ${entry.title}`, ''];
  for (const s of entry.sections) {
    lines.push(`## ${s.heading}`);
    lines.push('');
    lines.push(s.body.trim());
    lines.push('');
  }
  if (includeSourceFiles && entry.sourceFiles && entry.sourceFiles.length > 0) {
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

/** Destination relPath (under .claude/knowledge_base/) for re-placing an existing
 *  file, mirroring routeEntries' canonical/tech routing. Null when the placement
 *  names no canonical/tech target — the file is then left exactly where it is. */
export function routePlacement(p: KbPlacement): string | null {
  const canonical = normalizeCanonical(p.canonical);
  if (canonical) return `${canonical}.md`;
  const tech = normalizeTech(p.tech);
  if (tech) {
    switch (p.category) {
      case 'tech_pattern':
        return `TECH_PATTERNS/${tech}/INDEX.md`;
      case 'anti_pattern':
        return `ANTI_PATTERNS/${tech}-mistakes.md`;
      case 'best_practice':
        return `BEST_PRACTICES/${tech}-best-practices.md`;
      case 'quick_reference':
        return `QUICK_REFERENCE/${tech}/cheat-sheet.md`;
    }
  }
  return null;
}

/** Index bucket for an on-disk KB file, inferred from its relPath — so INDEX.md
 *  can be rebuilt from the final directory contents (existing + re-placed + new). */
function bucketFromRelPath(relPath: string): RoutedEntry['bucket'] {
  if (relPath.startsWith('TECH_PATTERNS/')) return 'tech_pattern';
  if (relPath.startsWith('ANTI_PATTERNS/')) return 'anti_pattern';
  if (relPath.startsWith('BEST_PRACTICES/')) return 'best_practice';
  if (relPath.startsWith('QUICK_REFERENCE/')) return 'quick_reference';
  if (!relPath.includes('/') && CANONICAL_STEMS.has(relPath.replace(/\.md$/, ''))) return 'core';
  return 'topic';
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
      | {
          project?: {
            framework?: string;
            frameworkMajor?: string | null;
            primaryLanguage?: string;
            name?: string;
            packages?: string[];
          };
          paths?: { customCodePaths?: { include?: string[]; exclude?: string[] } };
          stack?: {
            runtimeVersions?: Record<string, string>;
            database?: { type?: string | null; version?: string | null } | null;
          };
        }
      | undefined;
    const framework = envData?.project?.framework ?? null;
    const frameworkMajor = envData?.project?.frameworkMajor ?? null;
    const language = envData?.project?.primaryLanguage ?? null;
    const projectName = envData?.project?.name ?? null;
    const packages = envData?.project?.packages ?? [];
    const customCode = {
      include: envData?.paths?.customCodePaths?.include ?? [],
      exclude: envData?.paths?.customCodePaths?.exclude ?? [],
    };
    // User overrides from the project-details form (02) win over raw detection for
    // the PHP/DB version anchors, mirroring how 07-generate-files reads confirmed
    // values — so a manually-entered PHP/DB version actually scopes the global KB.
    const confirmedPrev = await loadPreviousStepOutput(
      ctx.db,
      ctx.taskId,
      '02-detection-confirmation',
    );
    const confirmed =
      (confirmedPrev?.output as { values?: ConfirmedStackValues } | null)?.values ?? null;
    const { phpMajor, nodeMajor, database, dbMajor } = resolveStackVersions(
      envData ?? {},
      confirmed,
    );

    await ctx.emitProgress('Collecting file tree for LLM orientation...');
    const fileTree = await collectShortFileTree(ctx.repoPath);

    await ctx.emitProgress('Reading README...');
    const readmeExcerpt = await readReadmeExcerpt(ctx.repoPath);

    const existingKb = await scanExistingKb(ctx.repoPath);
    if (existingKb.length > 0) {
      await ctx.emitProgress(
        `Found ${existingKb.length} existing KB file(s) — the AI will reuse and re-place them.`,
      );
    }

    await ctx.emitProgress(
      `Project context gathered (${fileTree.split('\n').length} files mapped). Waiting for AI analysis...`,
    );

    ctx.logger.info(
      { framework, language, projectName, fileTreeLines: fileTree.split('\n').length },
      'knowledge acquisition detect complete',
    );
    return {
      framework,
      frameworkMajor,
      language,
      projectName,
      phpMajor,
      nodeMajor,
      database,
      dbMajor,
      packages,
      customCode,
      __fileTree: fileTree,
      __readmeExcerpt: readmeExcerpt ?? undefined,
      __existingKb: existingKb.length > 0 ? existingKb : undefined,
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
    const placements = parseKbPlacements(llmOutput);
    const updates = parseKbUpdates(llmOutput);

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

    // Existing files the LLM flagged for the cross-repo KB. Shown as a deselectable
    // list so the user controls the (destructive) move BEFORE apply: ticked → moved
    // to a Global KB draft + deleted locally; unticked → kept here (re-placed
    // verbatim). Drives both the reroute field and the message breakdown below.
    const globalPlacements = placements.filter(isGlobalRoutedPlacement);
    const localPlacementCount = placements.length - globalPlacements.length;
    const rerouteField: FormSchema['fields'][number] | null =
      globalPlacements.length > 0
        ? {
            type: 'multi-select',
            id: 'rerouteGlobal',
            label:
              'Move these existing files to the shared Global KB (untick to keep in this repo)',
            options: globalPlacements.map((p) => ({ value: p.path, label: p.path })),
            defaults: globalPlacements.map((p) => p.path),
          }
        : null;
    const existingKbBits = [
      globalPlacements.length > 0
        ? `${globalPlacements.length} proposed to move to the Global KB`
        : '',
      localPlacementCount > 0 ? `${localPlacementCount} re-placed verbatim` : '',
      updates.length > 0 ? `${updates.length} improved with new findings` : '',
    ]
      .filter(Boolean)
      .join(', ');

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
          label: `${e.scope === 'global' ? '[global] ' : ''}${e.title} — ${detail}`,
          badge: confidenceLabel(e.confidence),
          badgeColor: confidenceColor(e.confidence),
        };
      });
      const defaults = entries.filter((e) => e.confidence !== 'low').map((e) => e.id);

      return {
        title: 'Knowledge base — AI discoveries',
        description: `AI discovered ${entries.length} new knowledge topic${entries.length === 1 ? '' : 's'}${totalSources > 0 ? ` (from ${totalSources} source file${totalSources === 1 ? '' : 's'})` : ''}.${existingKbBits ? ` Existing KB: ${existingKbBits}.` : ''} Review and select the ones to include in your knowledge base.`,
        fields: [
          {
            type: 'multi-select',
            id: 'selectedTopics',
            label: 'Topics to include',
            options,
            defaults: defaults.length > 0 ? defaults : options.map((o) => o.value),
          },
          ...(rerouteField ? [rerouteField] : []),
        ],
        submitLabel: 'Generate knowledge base',
      };
    }

    // The LLM mapped existing KB files to re-place and/or improve but emitted no
    // new topics — existing KB already covers the project. Confirm; allow extras.
    if (placements.length > 0 || updates.length > 0) {
      return {
        title: 'Knowledge base — existing files reused',
        description: `The AI found no new topics. Existing KB: ${existingKbBits}.${rerouteField ? ' Review the Global KB moves below.' : ''} Submit to apply, or list any extra topics to document (one per line).`,
        fields: [
          ...(rerouteField ? [rerouteField] : []),
          {
            type: 'textarea',
            id: 'manualTopics',
            label: 'Additional topics (optional, one per line)',
            rows: 6,
          },
        ],
        submitLabel: 'Apply knowledge base',
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
    // Repo-defined-symbol index for the promotion backstop — an article that calls a
    // repo-private function/class stays local. Scanned at most once, lazily.
    let repoSymbolsCache: Set<string> | null = null;
    const getRepoSymbols = async (): Promise<Set<string>> => {
      if (!repoSymbolsCache) repoSymbolsCache = await collectRepoSymbols(ctx.repoPath, detected);
      return repoSymbolsCache;
    };
    const values = args.formValues as {
      selectedTopics?: string[];
      rerouteGlobal?: string[];
      manualTopics?: string;
    };
    // Existing files the user kept ticked to move to the Global KB (empty when the
    // form offered no re-routes). A global placement is moved only when selected;
    // unticked ones fall through to a normal local re-place.
    const rerouteSet = new Set(values.rerouteGlobal ?? []);

    // Strip transient fields
    delete (detected as unknown as Record<string, unknown>).__fileTree;
    delete (detected as unknown as Record<string, unknown>).__readmeExcerpt;
    delete (detected as unknown as Record<string, unknown>).__existingKb;

    const kbDir = path.join(ctx.repoPath, '.claude', 'knowledge_base');
    await mkdir(kbDir, { recursive: true });

    const entries = extractEntries(args.llmOutput ?? null);
    const placements = parseKbPlacements(args.llmOutput ?? null);
    const updates = parseKbUpdates(args.llmOutput ?? null);
    const llmAvailable = entries.length > 0 || placements.length > 0 || updates.length > 0;
    const written: {
      id: string;
      filePath: string;
      source: 'llm' | 'stub' | 'existing' | 'updated' | 'global';
    }[] = [];
    let globalPromoted = 0;

    // Idempotent re-runs (Retry): drop this task's prior promoted drafts ONCE,
    // before any promotion below (placement re-routes AND entry promotes), so a
    // retry replaces rather than duplicates them. No-op when global KB is off.
    await clearTaskPromotedDrafts(ctx.db, ctx.taskId, ctx.logger);

    // 1. Re-place / improve existing KB files into the canonical layout. Updates
    //    win over placements for the same file; first writer wins per destination.
    const existing = await scanExistingKb(ctx.repoPath);
    const existingByPath = new Map(existing.map((f) => [f.relPath, f]));
    const takenDest = new Set<string>();
    const handledSrc = new Set<string>();

    // 1a. Updates (auto-applied): write the improved content to the canonical
    //     slot, replacing the stale file. Preserve-correct-content is enforced by
    //     the prompt; git tracks the rewrite as the review/rollback.
    for (const u of updates) {
      const src = existingByPath.get(u.path);
      if (!src) continue;
      const dest = routePlacement(u) ?? src.relPath;
      if (takenDest.has(dest)) continue;
      takenDest.add(dest);
      handledSrc.add(src.relPath);
      try {
        const destPath = path.join(kbDir, dest);
        await mkdir(path.dirname(destPath), { recursive: true });
        await writeFile(
          destPath,
          entryToMarkdown({
            id: u.path,
            title: u.title,
            sections: u.sections,
            sourceFiles: u.sourceFiles,
          }),
          'utf8',
        );
        if (dest !== src.relPath) await rm(path.join(kbDir, src.relPath), { force: true });
        written.push({ id: src.relPath, filePath: destPath, source: 'updated' });
      } catch (err) {
        ctx.logger.warn({ err, path: u.path, dest }, 'kb update write failed');
      }
    }

    // 1b. Placements: move the (accurate) existing file verbatim to its slot, OR
    //     re-route a now-global file to the cross-repo KB and delete it locally.
    for (const p of placements) {
      const src = existingByPath.get(p.path);
      if (!src || handledSrc.has(src.relPath)) continue;
      if (isGlobalRoutedPlacement(p) && rerouteSet.has(p.path)) {
        // Re-route candidate: a reusable house-standard file the user kept ticked.
        // Same deterministic backstop as the entry path — promote only when it is
        // NOT repo-own custom code AND can be anchored to an installed major version;
        // otherwise keep it local (fall through to the re-place branch below).
        let content: string;
        try {
          content = await readFile(path.join(kbDir, src.relPath), 'utf8');
        } catch (err) {
          ctx.logger.warn({ err, path: p.path }, 'kb global re-route failed');
          continue;
        }
        const category = p.category
          ? (p.category as GlobalKbCategory)
          : inferCategoryFromPath(src.relPath);
        const techBucket =
          category === 'anti_pattern' ||
          category === 'best_practice' ||
          category === 'quick_reference';
        const tech = p.tech ?? placementTech(src.relPath) ?? undefined;
        const facets = techBucket
          ? techAnchorFacets(tech, {}, detected)
          : detectedDefaultFacets(detected);
        const ownRef = await repoOwnRef(content, undefined, detected, ctx.repoPath);
        const symRef = ownRef ? null : bodyUsesRepoSymbol(content, await getRepoSymbols());
        if (!ownRef && !symRef && hasInstalledVersionAnchor(facets, detected)) {
          // MOVE it to the Global KB as a draft (deduped above) and delete the local
          // copy so it never feeds RAG.
          handledSrc.add(src.relPath);
          try {
            const promo = await promoteToGlobalKbDraft(
              ctx.db,
              {
                userId: ctx.userId,
                taskId: ctx.taskId,
                title: titleFromMarkdown(content, src.relPath),
                body: content,
                category,
                facets,
                topicKey: globalKbTopicKey(category, tech) ?? undefined,
                projectName: detected.projectName ?? undefined,
              },
              ctx.logger,
            );
            if (promo && !promo.deduped) {
              await rm(path.join(kbDir, src.relPath), { force: true });
              globalPromoted += 1;
              written.push({
                id: src.relPath,
                filePath: `global-kb:${promo.id}`,
                source: 'global',
              });
            } else if (promo?.deduped) {
              // Topic already covered by another project — keep this repo's local
              // copy (no data loss) rather than moving it.
              ctx.logger.info(
                { path: src.relPath, existingId: promo.id },
                'kb re-route deduped (topic already in global KB); kept local copy',
              );
            }
          } catch (err) {
            ctx.logger.warn({ err, path: p.path }, 'kb global re-route failed');
          }
          continue;
        }
        ctx.logger.info(
          {
            path: src.relPath,
            repoRef: ownRef ?? null,
            repoSymbol: symRef ?? null,
            tech: tech ?? null,
          },
          'kb re-route kept local (repo-specific code/symbol or no installed version anchor)',
        );
        // fall through to the local re-placement branch below
      }
      const dest = routePlacement(p) ?? src.relPath; // null → leave in place
      if (takenDest.has(dest)) continue;
      takenDest.add(dest);
      handledSrc.add(src.relPath);
      if (dest === src.relPath) continue; // already where it belongs
      try {
        const content = await readFile(path.join(kbDir, src.relPath), 'utf8');
        const destPath = path.join(kbDir, dest);
        await mkdir(path.dirname(destPath), { recursive: true });
        await writeFile(destPath, content, 'utf8');
        await rm(path.join(kbDir, src.relPath), { force: true });
        written.push({ id: src.relPath, filePath: destPath, source: 'existing' });
      } catch (err) {
        ctx.logger.warn({ err, path: p.path, dest }, 'kb placement move failed');
      }
    }

    // 2. Fill gaps: write the user-selected new entries, but never overwrite an
    //    existing/re-placed file (preserve wins). Falls back to manual stubs only
    //    when the LLM produced nothing at all (no entries AND no placements).
    if (entries.length > 0) {
      const selected = new Set(values.selectedTopics ?? []);
      const chosen = entries.filter((e) => selected.has(e.id));

      // Partition into global (promote) vs local (write to repo KB). Promotion
      // candidacy is DETERMINISTIC, not agent-driven: anti_pattern / best_practice /
      // quick_reference entries are house standards ABOUT a public tech, so they
      // default to global (the per-entry LLM scope tag proved unreliable — weak
      // agents mark everything "local"; this mirrors isGlobalRoutedPlacement for
      // existing-file re-routes). An explicit scope:'global' on any other category is
      // still honored. The backstop then keeps a candidate LOCAL when it depends on
      // THIS repo's own custom code, or cannot be anchored to an installed major
      // version (so jquery/fckeditor with no detectable version, and
      // tech_pattern/general entries, stay local).
      const globalChosen: { entry: KbEntry; facets: GlobalKbFacets }[] = [];
      const localChosen: KbEntry[] = [];
      for (const e of chosen) {
        const category = e.category ?? 'general';
        const techBucket =
          category === 'anti_pattern' ||
          category === 'best_practice' ||
          category === 'quick_reference';
        if (!techBucket && e.scope !== 'global') {
          localChosen.push(e);
          continue;
        }
        const facets = techBucket
          ? techAnchorFacets(e.tech, e.facets ?? {}, detected)
          : defaultGlobalFacets(e, detected);
        const sectionsText = e.sections.map((s) => s.body).join('\n');
        const ownRef = await repoOwnRef(sectionsText, e.sourceFiles, detected, ctx.repoPath);
        const symRef = ownRef ? null : bodyUsesRepoSymbol(sectionsText, await getRepoSymbols());
        if (ownRef || symRef) {
          ctx.logger.info(
            { entryId: e.id, repoRef: ownRef ?? null, repoSymbol: symRef ?? null },
            "kb: kept local (depends on this repo's custom code/symbol)",
          );
          localChosen.push(e);
          continue;
        }
        if (!hasInstalledVersionAnchor(facets, detected)) {
          ctx.logger.info(
            { entryId: e.id, tech: e.tech ?? null },
            'kb: kept local (no installed version to anchor a global entry)',
          );
          localChosen.push(e);
          continue;
        }
        globalChosen.push({ entry: e, facets });
      }

      // Global-routed entries become DRAFT rows in the cross-repo KB and are NEVER
      // written to .claude/knowledge_base/, so they never feed this repo's RAG. The
      // source-files footer is stripped — a portable article must not list repo files.
      for (const { entry: e, facets } of globalChosen) {
        const category = e.category ?? 'general';
        const promo = await promoteToGlobalKbDraft(
          ctx.db,
          {
            userId: ctx.userId,
            taskId: ctx.taskId,
            title: e.title,
            body: entryToMarkdown(e, { includeSourceFiles: false }),
            category,
            facets,
            topicKey: globalKbTopicKey(category, e.tech) ?? undefined,
            projectName: detected.projectName ?? undefined,
          },
          ctx.logger,
        );
        if (promo && !promo.deduped) {
          globalPromoted += 1;
          written.push({ id: e.id, filePath: `global-kb:${promo.id}`, source: 'global' });
        }
      }

      // Local entries (incl. demotions): written into the canonical repo KB layout,
      // never overwriting an existing/re-placed file.
      const routed = routeEntries(localChosen);
      for (const r of routed) {
        const filePath = path.join(kbDir, r.relPath);
        if (await pathExists(filePath)) {
          ctx.logger.info(
            { relPath: r.relPath },
            'kb gap entry skipped — preserving existing file',
          );
          continue;
        }
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, entryToMarkdown(r.entry), 'utf8');
        written.push({ id: r.entry.id, filePath, source: 'llm' });
      }
    } else {
      // No LLM gap entries: write stubs from any manual topics the user entered
      // (manual fallback, or the "additional topics" box on the reuse-confirm form).
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
        if (await pathExists(filePath)) continue;
        await writeFile(filePath, stubMarkdown(title), 'utf8');
        written.push({ id, filePath, source: 'stub' });
      }
    }

    // 3. Rebuild INDEX.md from the full on-disk KB (re-placed + preserved + new).
    const finalFiles = await scanExistingKb(ctx.repoPath);
    if (finalFiles.length > 0) {
      const routedForIndex: RoutedEntry[] = finalFiles.map((f) => ({
        entry: { id: f.relPath.replace(/\.md$/, ''), title: f.title, sections: [] },
        relPath: f.relPath,
        bucket: bucketFromRelPath(f.relPath),
        key: f.relPath,
      }));
      await writeFile(
        path.join(kbDir, 'INDEX.md'),
        kbIndexMarkdown(routedForIndex, detected.projectName),
        'utf8',
      );
    }

    ctx.logger.info(
      {
        written: written.length,
        placements: placements.length,
        llmAvailable,
        topicCount: entries.length,
      },
      'knowledge base written',
    );
    return { written, topicCount: entries.length, llmAvailable, globalPromoted };
  },
};

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { jsonrepair } from 'jsonrepair';
import type { DetectResult, FormSchema } from '@haive/shared';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import { LEGACY_IMPORT_SUBDIR, migrateLegacyKnowledge } from './_kb-legacy.js';
import { sanitizeKbRelPath } from './_kb-write.js';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { RetryableParseError } from '../../step-definition.js';
import {
  listFilesMatching,
  loadPreviousStepOutput,
  loadRunStartedAt,
  pathExists,
} from './_helpers.js';
import {
  isDeniedFile,
  loadMiningScopeExcludeGlobs,
  noSubagentInstructionLines,
  scopeInstructionLines,
} from './_scope.js';
import { techAnchorFacets } from '../_repo-stack.js';
import {
  KB_DRAFT_DIR,
  prepareAgentWritableDir,
  readKbBodyFile,
  discardKbDrafts,
  resolveBodies,
} from './_kb-body-file.js';
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
  /** Transient — per-repo scope deny list; drives the soft-scope prompt section.
   *  Stripped before persisting. */
  __scopeExclude?: string[];
  /** Transient — README excerpt for LLM prompt context. */
  __readmeExcerpt?: string;
  /** Transient — pre-existing KB files (from a prior orchestration) the LLM
   *  should reuse + re-place rather than regenerate. Stripped before persisting. */
  __existingKb?: ExistingKbFile[];
  /** Section count per entry id for bodies staged in files. Just the number: `detected`
   *  is persisted to `detect_output`, so the sections themselves must not live here. */
  __sectionCounts?: Record<string, number>;
}

interface ExistingKbFile {
  /** Path under the knowledge-base root (`KB_DIR`), e.g. `ARCHITECTURE.md` or
   *  `old/notes.md`. */
  relPath: string;
  title: string;
}

/** A `written` row promoted to the global KB carries no repo file, so its `filePath` is
 *  this sentinel rather than a path. */
const GLOBAL_KB_FILE_PATH_PREFIX = 'global-kb:';

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
  /** Existing-file paths the agent asked to re-place or improve that the KB scan does not
   *  know, so nothing was applied for them. Present only when non-empty: a step output is
   *  what a later reader has, and a silent skip is indistinguishable from nothing to do. */
  unknownPaths?: string[];
  /** `legacy/` imports deleted because an update folded their content into a newer page. */
  mergedRemoved?: string[];
  /** Markdown files under `KB_DIR` once this step finished. `07_5-verify-files` used to
   *  count them one step before they existed, so it failed on every run ever recorded. */
  kbFileCount: number;
}

type KbCategory = 'general' | 'tech_pattern' | 'anti_pattern' | 'best_practice' | 'quick_reference';

interface KbEntry {
  id: string;
  title: string;
  sections: { heading: string; body: string }[];
  /** Set instead of `sections` when the agent staged the body under `.haive/kb-draft/`.
   *  Resolved by `resolveBodies` at the top of apply, so nothing downstream sees it. */
  bodyPath?: string;
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
   *  the knowledge-base root. Defaults to `local`. */
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
  // Rust's build output, the same class as `dist`/`build` above. It matters now that `.rs` is
  // scanned: a built checkout carries generated sources there, and a generated helper is not
  // this project's vocabulary — the same reason the minified-bundle skip exists.
  'target',
  // Elixir's equivalents, for the same reasons the entries above exist: `_build` is build output
  // like `dist`/`target`, and `deps` is the dependency tree like `vendor`/`node_modules`. Both
  // matter only now that `.ex` is scanned, and a dependency's functions are not this project's
  // vocabulary — which is the whole reason `vendor` is on this list.
  '_build',
  'deps',
  // SwiftPM's output tree, which holds `.build/checkouts/<dep>/Sources/**/*.swift` — a
  // DEPENDENCY's source, not this project's. Left out, a library API the article legitimately
  // names reads as a repository-private symbol and the block is deleted, which is the
  // false-citation direction this list exists to prevent. `Pods` is CocoaPods' equivalent, and
  // `.gradle` is the Kotlin/Scala/Java cache. All three only matter now that those extensions
  // are read.
  //
  // `bin` and `obj` are deliberately NOT here: `bin` holds real scripts in plenty of projects,
  // and excluding either globally would take a directory out of the file tree and out of
  // `isLikelyRepoOwnPath` for every repository, which is too much for a .NET convention.
  '.build',
  'Pods',
  '.gradle',
  // Python virtualenvs, the same class as `node_modules` and `vendor` already here: a tree of
  // THIRD-PARTY source. `__pycache__` was excluded from the start but the environment holding
  // site-packages was not, so a distinctive library symbol or filename could be read as this
  // repository's own and delete the block that mentioned it — and 4,000 files of dependencies
  // can crowd the project's own out of the cap besides.
  //
  // `env` is deliberately absent: it is a real directory name in plenty of projects, and the
  // same reasoning that keeps `bin` off this list applies to it.
  '.venv',
  'venv',
  // tox and nox build their own virtualenvs per environment, each with its own site-packages —
  // the same third-party tree as `.venv`, reached by a different tool. Named explicitly rather
  // than matched by prefix, because this set is compared by exact path SEGMENT.
  '.tox',
  '.nox',
]);

async function collectShortFileTree(
  repoPath: string,
  exclude: readonly string[] = [],
): Promise<string> {
  const files = await listFilesMatching(
    repoPath,
    (rel, isDir) => {
      const parts = rel.split('/');
      if (parts.some((p) => IGNORE_DIRS.has(p))) return false;
      if (isDeniedFile(rel, isDir, exclude)) return false;
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
  const kbDir = path.join(repoPath, KB_DIR);
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

/** The `existingByPath` key for a path the model reported.
 *
 *  It names what it saw, and a repo whose knowledge predates `.haive-data/` still shows that
 *  tree, so the reported path may carry either root — or none, matching the prompt's own
 *  listing. `sanitizeKbRelPath` strips both, which is what makes the lookup agree with the
 *  scan instead of silently missing and dropping the item. */
function existingKbKey(reported: string): string {
  const safe = sanitizeKbRelPath(reported);
  return safe.ok ? safe.normalized : reported;
}

/* ------------------------------------------------------------------ */
/* LLM prompt                                                          */
/* ------------------------------------------------------------------ */

function buildKnowledgePrompt(args: LlmBuildArgs): string {
  const detected = args.detected as KnowledgeDetect;
  const fileTree =
    (detected as unknown as Record<string, string>).__fileTree ?? '(no file tree available)';
  const scopeExclude = (detected as unknown as Record<string, string[]>).__scopeExclude ?? [];
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
          "A file under `legacy/` is this project's OWN earlier knowledge on a topic that a",
          'newer page already covers — it was accumulated over many past tasks, so treat it as',
          'evidence, not as clutter. MERGE it: emit ONE `updates` entry for the NEWER page whose',
          '`sections` fold in everything the legacy file still gets right, and do NOT emit a',
          'placement that would publish the legacy copy as a page of its own. Say nothing about',
          'the merge in the body — the result should read as one page.',
          '',
          'List every legacy page you folded in as `mergedFrom` on that SAME update entry, so',
          'the merged copy is removed once the page is written. Omit it if you merged nothing:',
          'a legacy page you leave out simply stays, which is untidy but loses nothing, whereas',
          'naming one you did NOT actually fold in discards knowledge that is then in no page.',
          '',
          ...existingKb.map((f) => `- ${f.relPath} — ${f.title}`),
          '',
          // MEASURED: three of three claude-code runs asked to update `INDEX.md`, which the
          // scan omits BECAUSE it is generated. Each request was reported as an unknown path
          // and dropped — safe, but the agent spent an entry on it every run. Codex never did.
          'That list is COMPLETE. A `placements` or `updates` entry naming a path that is not',
          'on it applies nothing: the path is reported back as unknown and dropped. In',
          'particular `INDEX.md` is REGENERATED from whatever you emit, so it is never a file',
          'to keep or improve — it is missing from the list for that reason, not by oversight.',
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
    ...scopeInstructionLines(scopeExclude),
    ...noSubagentInstructionLines(),
    '## README excerpt',
    readme,
    '',
    ...existingKbLines,
    '## Instructions',
    '',
    scopeExclude.length > 0
      ? 'Use your file-reading tools to deeply explore THIS PROJECT\'S OWN code — the in-scope directories. Do NOT rely only on the partial file tree above, and do NOT crawl the out-of-scope third-party/built-in directories listed under "Mining scope".'
      : 'Use your file-reading tools to deeply explore this repository. Do NOT rely only on the partial file tree above.',
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
    `WRITE EACH BODY TO A FILE, then describe it in the JSON. For every entry and every`,
    `update, use your file-writing tool to create \`${KB_DRAFT_DIR}/<id>.md\` holding ONLY`,
    `the section content, as level-2 markdown headings:`,
    '',
    '    ## Section Name',
    '',
    '    Detailed markdown content...',
    '',
    '    ## Another Section',
    '',
    `Then set \`"bodyPath": "${KB_DRAFT_DIR}/<id>.md"\` on that entry and OMIT its`,
    '`sections` array. Do not write a `# Title` line and do not write a `## Source files`',
    'section — both are generated from the fields you supply.',
    '',
    'This is not a style preference. A whole knowledge base does not fit in one reply, and',
    'an answer shortened to fit is worse than the one you would have written. Writing each',
    'body as its own file removes that limit, so write them in full and keep the JSON',
    'small. Inline `sections` are still accepted for a short entry.',
    '',
    'Then emit exactly ONE JSON object inside a ```json fenced code block:',
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
    `      "bodyPath": "${KB_DRAFT_DIR}/<id>.md"`,
    '    }',
    '  ],',
    '  "placements": [',
    '    { "path": "<existing knowledge_base file path from the list above>", "canonical": "ARCHITECTURE | API_REFERENCE | CODING_STANDARDS | TESTING_STANDARDS | SECURITY_STANDARDS | DEPLOYMENT | BUSINESS_LOGIC | (omit)", "category": "general | tech_pattern | anti_pattern | best_practice | quick_reference", "tech": "<tech slug, required when category is a tech bucket>", "scope": "local | global (omit for local)" }',
    '  ],',
    '  "updates": [',
    `    { "path": "<existing knowledge_base file to IMPROVE>", "title": "...", "canonical": "ARCHITECTURE | API_REFERENCE | CODING_STANDARDS | TESTING_STANDARDS | SECURITY_STANDARDS | DEPLOYMENT | BUSINESS_LOGIC | (omit)", "category": "general | tech_pattern | anti_pattern | best_practice | quick_reference", "tech": "<tech slug when a tech bucket>", "bodyPath": "<draft file holding the improved markdown — preserve correct content, revise stale parts, add new findings>", "mergedFrom": ["legacy/<FILE>.md — omit unless you folded a legacy page into this one"] }`,
    '  ]',
    '}',
    '```',
    '',
    'CRITICAL — valid JSON only: every string value must parse as JSON. Escape every literal double-quote inside a value as \\" (and every backslash as \\\\). A single unescaped " ends the string early and the ENTIRE output is discarded and re-run. Code snippets are the usual offender: write `<img custom=\\"1\\">` and `implode(\\"a\\", \\"b\\")`, never with raw " characters.',
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
    '  - Write section bodies DENSELY to keep the KB token-light: lead with the fact, drop filler, and do not restate the heading. Preserve EXACTLY (never compress): code, file paths, commands, version numbers, and identifiers/API names — but escape any double-quote inside that code as \\" so the JSON string stays valid.',
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
  /** relPath under the knowledge-base root of an existing file to re-place. */
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
  /** relPath under the knowledge-base root of the existing file to improve. */
  path: string;
  title: string;
  canonical?: string;
  category?: KbCategory;
  tech?: string;
  confidence?: 'high' | 'medium' | 'low';
  sourceFiles?: string[];
  sections: { heading: string; body: string }[];
  /** As KbEntry.bodyPath. */
  bodyPath?: string;
  /** Legacy pages whose content this update folded in, so apply can delete them once the
   *  merged page is written. Honoured ONLY for paths under the `legacy/` import dir — see
   *  the removal site for why that restriction is load-bearing. */
  mergedFrom?: string[];
}

function isValidUpdate(val: unknown): val is KbUpdate {
  if (!val || typeof val !== 'object') return false;
  const v = val as Record<string, unknown>;
  if (typeof v.path !== 'string' || v.path.length === 0) return false;
  if (typeof v.title !== 'string') return false;
  // Optional, and a malformed one is DROPPED rather than failing the update: losing the
  // merged page would be a far worse outcome than leaving a legacy duplicate behind.
  if (v.mergedFrom !== undefined) {
    if (!Array.isArray(v.mergedFrom) || v.mergedFrom.some((x) => typeof x !== 'string')) {
      delete v.mergedFrom;
    }
  }
  if (typeof v.bodyPath === 'string' && v.bodyPath.length > 0 && v.sections === undefined) {
    return true;
  }
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
  // Bodies may be STAGED in a file instead of carried inline — `resolveBodies` fills
  // them in before anything downstream runs, so an entry that names one is complete.
  if (typeof v.bodyPath === 'string' && v.bodyPath.length > 0 && v.sections === undefined) {
    return true;
  }
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

// techAnchorFacets moved to ../_repo-stack.ts so the workflow learning step reuses
// the same deterministic version-anchoring. Imported above. KnowledgeDetect still
// satisfies its StackAnchors parameter structurally, so the callers below are
// unchanged.

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
/** How many segments of `prefix` matched, or 0 for no match. Specificity, so a rule about
 *  `sites/all/modules/activit/` can outrank one about `modules/`. */
function prefixMatchDepth(pathSegs: string[], prefix: string): number {
  return pathHasPrefix(pathSegs, prefix) ? pathSegments(prefix).length : 0;
}

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
  // The MORE SPECIFIC rule wins, with exclude keeping the tie. A prefix matches anywhere in
  // the path — deliberately, so `modules/custom/` covers a `web/` docroot without every
  // prefix being restated — and that is exactly what made a bare exclude swallow a nested
  // include: MEASURED on a live Drupal 7 site, `modules/` (core, at the repo root) matched
  // `sites/all/modules/activit/activit.module`, so the site's OWN module could never be
  // repo-own and the global-KB guard built on this was dead. Equal depth still lets exclude
  // win, which is what keeps `src/` from claiming `node_modules/pkg/src/index.js`.
  const inc = Math.max(0, ...include.map((p) => prefixMatchDepth(pathSegs, p)));
  const exc = Math.max(0, ...exclude.map((p) => prefixMatchDepth(pathSegs, p)));
  return inc > 0 && inc > exc;
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
export async function repoOwnRef(
  sectionsText: string,
  sourceFiles: string[] | undefined,
  detect: KnowledgeDetect,
  repoPath: string,
): Promise<string | null> {
  const { include, exclude } = detect.customCode;
  // A STORED include is a convention that may not describe this repo, and a payload
  // written before detection filtered them still carries one. An include prefix that
  // exists nowhere on disk is indistinguishable from no include at all — so treat it that
  // way rather than letting it veto every path and silently disable this guard.
  const usableInclude: string[] = [];
  for (const prefix of include) {
    if (await pathExists(path.join(repoPath, prefix))) usableInclude.push(prefix);
  }
  const candidates = [
    ...extractCitedPaths(sectionsText),
    ...(sourceFiles ?? []).map((s) => s.replace(/^\.\//, '').replace(/:\d+(?:-\d+)?$/, '')),
  ];
  for (const rel of candidates) {
    const repoOwn =
      usableInclude.length > 0
        ? isRepoOwnPath(rel, usableInclude, exclude)
        : isLikelyRepoOwnPath(rel, exclude);
    if (repoOwn && (await pathExists(path.join(repoPath, rel)))) return rel;
  }
  return null;
}

/* Repo-defined-symbol backstop: a "global" article must not lean on a function or
 * class DEFINED in this repo (e.g. a custom helper like GetPHPVariables). */
const REPO_SYMBOL_FILE_CAP = 4000;
const REPO_SYMBOL_CAP = 40000;
/** Longest line in a file, used to spot a minified bundle without trusting its name. */
function longestLine(text: string): number {
  let max = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === '\n') {
      if (i - start > max) max = i - start;
      start = i + 1;
    }
  }
  return max;
}

/** Names the LANGUAGE owns. A repository that declares one has written a shim or vendored a
 *  helper; it has not coined a word, so an article mentioning `in_array()` is not citing that
 *  repository.
 *
 *  MEASURED across four real checkouts with the corpus harness: `is_string` reached the symbol
 *  set from a minified jQuery plugin declaring `function is_string(arg)`, and `in_array` from a
 *  site's own `const in_array = ...` — both genuine declarations, both deleting a block from the
 *  "PHP 8 Mistakes" article for naming the built-in it is about.
 *
 *  Unlike a list of project filenames, these are specified by the language and do not churn.
 *  Grow it on evidence from `scripts/kb-scrub-eval.ts`; a name missing here costs a deleted
 *  block, a name wrongly here costs only a citation reaching a reviewed draft. */
const LANGUAGE_BUILTIN_NAMES = new Set([
  // PHP type and array checks, the ones an article about PHP pitfalls names by definition.
  'is_string',
  'is_numeric',
  'is_array',
  'is_callable',
  'is_object',
  'is_bool',
  'is_null',
  'in_array',
  'array_key_exists',
  'array_merge',
  'array_filter',
  'array_map',
  'array_keys',
  'array_values',
  'str_replace',
  'str_contains',
  'str_starts_with',
  'str_ends_with',
  'json_encode',
  'json_decode',
  'array_slice',
  'array_search',
  'call_user_func',
  // JS/TS globals that a bundled library commonly re-declares.
  'parseInt',
  'parseFloat',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'encodeURIComponent',
  'decodeURIComponent',
  'requestAnimationFrame',
]);

/** Whether a declared name IDENTIFIES this repository, rather than merely existing in it.
 *
 *  A single lowercase word does not. `bodyUsesRepoSymbol` matches any `name(` in an article, so
 *  collecting `render` means every invented example that calls `render(...)` is treated as a
 *  citation and its block is deleted — the silent over-removal this scrub must never commit.
 *
 *  MEASURED on a real 11,005-symbol repository: 16 of 17 commonplace method names tested
 *  (`render`, `handle`, `execute`, `process`, `update`, `create`, `delete`, `validate`, ...)
 *  were present, and a generic example calling `render(name)` was flagged as a citation. The
 *  same scan shows 10,157 of those 11,005 names carry a hump or an underscore, so requiring
 *  multi-word keeps 92% of the set and drops precisely the ambiguous tail.
 *
 *  Multi-word is the structural form of "specific to this codebase": a name built from two or
 *  more words was chosen for a domain, while a single verb is vocabulary every project shares.
 *  It mirrors what `identifiers.ts` already treats as an identifier worth indexing — including
 *  its SECOND hump, which is not optional here either: `[a-z][A-Z]` alone misses PascalCase with
 *  a single-letter prefix, so a repo declaring `CProduct` had that name dropped from the symbol
 *  set and a block copied out of that class could not be recognised. The second clause wants an
 *  uppercase-then-lowercase pair NOT at the start, which admits `CProduct` while still rejecting
 *  capitalised prose (`Postgres`, `Excel`) and all-caps words (`PDF`). Keep the two rules
 *  identical: this decides what a citation IS, and `identifiers.ts` decides what is searchable. */
function isDistinctiveSymbol(name: string | undefined): name is string {
  if (!name || LANGUAGE_BUILTIN_NAMES.has(name)) return false;
  return /[a-z][A-Z]|_/.test(name) || /.[A-Z][a-z]/.test(name);
}

/** Words that pass the method shape (`name(...) {`) but name no symbol. Length alone does not
 *  exclude them — `while`, `catch` and `switch` all clear the 5-character floor. */
const NON_SYMBOL_KEYWORDS = new Set([
  'while',
  'catch',
  'switch',
  'return',
  'function',
  'constructor',
  'elseif',
  'foreach',
]);

/** Exported so a test can hold it to `STACK_INDICATORS` and `SERVER_LANGUAGES`: a language the
 *  detector RANKS but this cannot read is a repository whose own identifiers are invisible to the
 *  citation scrub, which is how Rust, Java, Elixir and the C family each went missing.
 *
 *  It is NOT language-complete and cannot be. `pickPrimaryLanguage` falls back to any histogram
 *  key when no server language is present (`pool = servers.length > 0 ? servers : entries`), so
 *  Dart, Lua, Haskell and anything else an ingest histogram names are valid outputs. Two reasons
 *  the scan stops at the supported stacks rather than chasing that set:
 *
 *  - An unlisted language degrades in the ACCEPTED direction. With no extensions to read, the
 *    symbol backstop is simply absent — the same state a repo-less run is in — while the path,
 *    line-reference and bare-filename rules still apply. A miss lets a copied identifier reach a
 *    draft a human reviews; that is the cheap error this scan is calibrated around.
 *  - The obvious "fix" is the expensive one. Scanning every extension that is not a known binary
 *    would pull in dependency trees for ecosystems with no IGNORE_DIRS entry, and collecting a
 *    third-party symbol as repository-private DELETES somebody's article. Widening coverage that
 *    way trades the cheap error for the costly one.
 *
 *  So a new language belongs here when the product SUPPORTS it — when it appears in
 *  `STACK_INDICATORS` or `SERVER_LANGUAGES` — and the test enforces exactly that, no more. */
export const SYMBOL_SCAN_EXT: Record<string, string[]> = {
  php: ['.php', '.inc', '.module', '.install', '.theme', '.phtml', '.profile', '.engine'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  typescript: ['.ts', '.tsx'],
  python: ['.py'],
  ruby: ['.rb'],
  go: ['.go'],
  // `01-env-detect` recognises Cargo.toml -> rust and pom.xml/build.gradle -> java, so these are
  // SUPPORTED stacks whose files this map did not list. The miss was total rather than partial:
  // an unknown language falls back to the UNION of these values, so a Rust or Java anchor
  // contributed zero of its own symbols and the citation scrub had no backstop there at all.
  rust: ['.rs'],
  java: ['.java'],
  elixir: ['.ex', '.exs'],
  // `pickPrimaryLanguage` is a SECOND source of language names, independent of the manifest
  // markers above: it reads an ingest histogram and returns any `SERVER_LANGUAGES` member
  // lowercased. Those names never reached this map, so a C#/Kotlin/Scala/Swift/C/C++ anchor
  // collected nothing at all — the same total blindness Rust, Java and Elixir each had.
  kotlin: ['.kt', '.kts'],
  scala: ['.scala'],
  swift: ['.swift'],
  'c#': ['.cs'],
  c: ['.c', '.h'],
  'c++': ['.cpp', '.cc', '.cxx', '.hpp', '.hh'],
};

/** Basenames of this repo's own source files, lowercased.
 *
 *  The bare-filename rule used to resolve a candidate at the repo ROOT only — correct for the
 *  manifests a model reaches for, but blind to `InvoiceProcessor.ts` living under `src/`, which
 *  the authoring contract forbids just as firmly. The slashed-path rule does not cover it either:
 *  a bare name has no separator to match on.
 *
 *  Bounded exactly like `collectRepoSymbols` — same walk, same depth, same caps, same ignored
 *  directories — and empty on any failure, which simply restores the root-only behaviour. */
export async function collectRepoBasenames(repoPath: string): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const files = await listFilesMatching(
      repoPath,
      (rel, isDir) => {
        if (isDir) return false;
        return !rel.split('/').some((p) => IGNORE_DIRS.has(p));
      },
      10,
      (name) => IGNORE_DIRS.has(name),
    );
    for (const rel of files.slice(0, REPO_SYMBOL_FILE_CAP)) {
      const base = rel.split('/').pop();
      if (base) names.add(base.toLowerCase());
      if (names.size > REPO_SYMBOL_CAP) break;
    }
  } catch {
    // best effort — the bare-filename rule then checks the repo root only, as it always did
  }
  return names;
}

/** Names of functions / classes / traits / interfaces DEFINED in this repo's own
 *  source (dependency/ignored dirs excluded). Best-effort and bounded; returns an
 *  empty set on any failure (the symbol backstop then simply never fires). */
export async function collectRepoSymbols(
  repoPath: string,
  language: string | null | undefined,
): Promise<Set<string>> {
  const symbols = new Set<string>();
  const lang = (language ?? '').toLowerCase();
  // An UNKNOWN language scans every extension this map knows, not a four-entry guess. The old
  // default was `['.php','.js','.ts','.py']`, which silently under-covers exactly the repos the
  // citation scrub exists for: it misses Drupal's own `.module`/`.inc`/`.theme` — the entry that
  // motivated the scrub cited `activit.module:534` — as well as `.tsx`, `.rb` and `.go`, so a
  // copied identifier from any of them was invisible to the symbol check. A named language is
  // unchanged and still scans only its own extensions.
  const exts = SYMBOL_SCAN_EXT[lang] ?? [...new Set(Object.values(SYMBOL_SCAN_EXT).flat())];
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
      // Prune as well as filter: without this the walk descends into every `.venv`, `target` and
      // `Pods` in the tree and then discards what it found. Anchored enrichment runs this walk
      // and the basename walk back to back, so the cost was paid twice.
      (name) => IGNORE_DIRS.has(name),
    );
    for (const rel of files.slice(0, REPO_SYMBOL_FILE_CAP)) {
      let text: string;
      try {
        text = await readFile(path.join(repoPath, rel), 'utf8');
      } catch {
        continue;
      }
      // A MINIFIED or generated bundle is not this project's vocabulary — it is a vendored
      // library flattened onto one line, and parsing it yields hundreds of generic helpers.
      // Detected by line LENGTH rather than by a `.min.js` name, which is a convention a build
      // tool can drop. MEASURED: a minified jQuery plugin declaring `function is_string(arg)`
      // put that name into the symbol set of a real repo.
      if (text.length > 2000 && longestLine(text) > 1000) continue;
      const body = text.length > 200_000 ? text.slice(0, 200_000) : text;
      // Every keyword the SCANNED extensions can declare with. Adding `.go`/`.py`/`.rb` to the
      // file filter collected nothing from them while this still knew only the PHP/JS set —
      // Python declares with `def`, Go with `func` (optionally behind a receiver) and `type`.
      // `function` precedes `func` so the longer keyword wins the alternation.
      // The `use` lookbehind is load-bearing: PHP's `use function array_key_exists;` is an
      // IMPORT, not a declaration, and matching it collected the language's own built-ins as
      // repository symbols. MEASURED across the real KB corpus — 7 of 167 blocks were deleted
      // from PHP articles for mentioning `is_numeric`, `is_string`, `in_array` and
      // `array_key_exists`, every one of them a false citation. A denylist of built-ins would
      // have treated the symptom; the parse was simply wrong.
      // `fn` (Rust) and `record` (Java) are the two additions those stacks need; `class`,
      // `interface`, `enum`, `struct`, `trait` and `type` already covered the rest of both. Order
      // matters only in that `function` precedes `func` precedes `fn`, so the longest keyword wins
      // the alternation. A method carrying a RETURN TYPE between the modifiers and the name
      // (`public void processInvoice()`) is not a keyword declaration and is read by `cFuncRe`
      // below — in Java as in C#, since it is the same shape and there is no principled reason to
      // admit one and refuse the other. That shape was excluded for a while on the argument that
      // types carry Java anyway; C has no types to carry it, which is what forced the question.
      const defRe =
        /(?<!\buse\s)\b(?:function|func|fun|fn|defmodule|defmacrop|defmacro|defp|def|class|trait|interface|struct|type|enum|module|record|object|protocol)\s+(?:\([^)]*\)\s*)?(?:self\.)?([A-Za-z_]\w{4,})/g;
      // `enum` covers PHP 8.1 and TypeScript, `module` covers Ruby — both are unambiguous
      // declaration keywords, so they cost nothing.
      // `self.` is skipped because Ruby declares a class method as `def self.process_invoice`, and
      // the name capture otherwise stops at `self` — MEASURED, every such method was missing. It is
      // honoured only right after a keyword, so a `self.` CALL is never read as a declaration.
      //
      // This scan is an APPROXIMATION and is meant to stay one. The two errors are not equal:
      // missing a symbol lets a copied identifier reach a draft a human then reviews, while
      // inventing one deletes a block of somebody's article. So it under-collects on purpose —
      // extend it with keywords that are unambiguous, and resist widening the SHAPES it accepts.
      //
      // JS/TS declare most of their helpers with no keyword at all — `const parseInvoice = () =>`
      // and class methods `serializeInvoice() {` — so a keyword-anchored scan misses exactly the
      // forms those repos use most, while `bodyUsesRepoSymbol` happily recognises their call
      // syntax in an article. Two narrow patterns rather than one loose one: over-collecting here
      // costs a FALSE citation, which deletes a block of somebody's article.
      const assignedFnRe =
        /\b(?:const|let|var)\s+([A-Za-z_]\w{4,})\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_]\w*\s*=>)/g;
      // A method must sit on its OWN indented line and open a block, which a call statement
      // (`  doThing();`) never does. Control-flow keywords reach the length floor, so they are
      // excluded by name rather than by shape.
      // The `(?::...)` arm is TypeScript's return annotation, which sits between `)` and `{` —
      // `serializeInvoice(): string {`, `async load(): Promise<T> {`. Requiring the brace
      // immediately after the parens silently skipped every typed method in a TS repo, which is
      // most of them. Stops at `{` so an inline object return type is missed rather than
      // over-matched: a miss costs a symbol, over-matching costs somebody's article.
      const methodRe =
        /^[ \t]+(?:(?:public|private|protected|static|readonly|async|get|set|\*)\s+)*([A-Za-z_]\w{4,})\s*(?:<[^<>()]*>)?\s*\([^)]*\)\s*(?::\s*[^;{]+)?\s*\{/gm;
      // A class PROPERTY holding an arrow function — the common React/TS idiom. Anchored on the
      // `=>`, so it declares a callable and cannot match `timeoutValue = 30` or an object
      // literal. Deliberately NOT covered, with reasons: `#private` methods cannot be called
      // from outside the class, so an article cannot meaningfully cite one, and an `abstract
      // name(): T;` signature is re-declared with a body by whichever class implements it.
      const classPropFnRe =
        /^[ \t]+(?:(?:public|private|protected|static|readonly)\s+)*([A-Za-z_]\w{4,})\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>/gm;
      // C, C++ and C# declare a callable with a RETURN TYPE and no keyword at all, so neither
      // `defRe` (wants a keyword) nor `methodRe` (wants the name straight after the modifiers)
      // can see `int process_invoice_batch(...)` or `public void ProcessInvoice(...)`. Those
      // three contributed TYPES only — and C has no classes, so a C repository contributed
      // almost nothing at all, which is not the "under-collect on purpose" this scan intends.
      //
      // This IS the shape the scan otherwise refuses to widen, so it is anchored hard, and every
      // clause below is load-bearing rather than defensive:
      //   - a type token AND a name before the parens, so `if (x) {`, `while (x) {`,
      //     `foreach (…) {`, `using (…) {`, `lock (…) {`, `catch (…) {` and `switch (…) {` all
      //     have only ONE and cannot match;
      //   - no `;` inside the parens, which is what excludes `for (a; b; c) {`;
      //   - a `{` OR an `=>` after them, so a prototype (`int foo(void);`) and a bare call are
      //     both out while C#'s expression-bodied member (`string Fmt(int id) => …;`) is in. The
      //     `=>` arm cannot reach a lambda: `const f = (a) => …` carries a `=`, which the prefix
      //     class excludes, and `items.Where(x => …)` has no WHITESPACE before its name, which
      //     the name requires;
      //   - `?`, `[`, `]` and `.` ARE in the prefix, because a return type is not one bare word:
      //     `InvoiceDto?`, `InvoiceDto[]`, `System.String`, `Task<InvoiceDto?>`. MEASURED, five of
      //     six C# declarations of those shapes were invisible without them. None of the four lets
      //     a call through, for the whitespace reason above: `handler?.Invoke(x)` and
      //     `list.Where(…)` both put the name flush against the `.`.
      //   - a `Name::` chain may sit directly before the name, because C++ defines a member outside
      //     its class as `void InvoiceProcessor::processInvoice(…) {` — MEASURED, every such
      //     definition was missing. The chain does not reopen calls: a qualified call still has no
      //     type token and whitespace in front of it, and ends in `;` rather than `{`.
      // `isDistinctiveSymbol` still applies, so a single generic word never lands.
      //
      // Indentation is ALLOWED. Anchoring at column 0 looked like the safe choice and was simply
      // wrong: a C# member sits inside a class, so the pattern could not see the language's
      // normal formatting at all. The brace requirement is what excludes an indented CALL —
      // `indented_call(arg);` ends in a semicolon — so the anchor was never what made this safe.
      const cFuncRe =
        /^[ \t]*[A-Za-z_][\w:<>,*&?.[\]\s]*?\s+\*?(?:[A-Za-z_]\w*::)*([A-Za-z_]\w{4,})\s*\([^;{)]*\)\s*(?:const\s*)?(?:\{|=>)/gm;
      for (let m = cFuncRe.exec(body); m; m = cFuncRe.exec(body)) {
        if (m[1] && !NON_SYMBOL_KEYWORDS.has(m[1]) && isDistinctiveSymbol(m[1])) {
          symbols.add(m[1]);
        }
      }
      for (let m = defRe.exec(body); m; m = defRe.exec(body)) {
        if (isDistinctiveSymbol(m[1])) symbols.add(m[1]!);
      }
      for (let m = assignedFnRe.exec(body); m; m = assignedFnRe.exec(body)) {
        if (isDistinctiveSymbol(m[1])) symbols.add(m[1]!);
      }
      for (let m = methodRe.exec(body); m; m = methodRe.exec(body)) {
        if (m[1] && !NON_SYMBOL_KEYWORDS.has(m[1]) && isDistinctiveSymbol(m[1])) {
          symbols.add(m[1]);
        }
      }
      for (let m = classPropFnRe.exec(body); m; m = classPropFnRe.exec(body)) {
        if (isDistinctiveSymbol(m[1])) symbols.add(m[1]!);
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
  // Calls, `new`, `::`, and a TYPE LITERAL. The fourth arm exists because the collector records
  // custom types — `struct`/`trait`/`defmodule` and friends — and the languages that declare them
  // do not CALL them: Go and Rust write `InvoiceRow{...}`, Elixir writes `%InvoiceRow{...}`, so a
  // block copied straight out of a repo-defined type matched nothing and survived while its exact
  // name sat in the symbol set.
  //
  // `[ \t]*` rather than `\s*` on that arm, deliberately: a newline between a name and a brace is
  // a markdown heading followed by an unrelated block far more often than it is a literal, and
  // over-matching here deletes somebody's article.
  // The call arm allows a trailing `!` or `?`. Ruby and Elixir spell a mutating or predicate
  // method that way (`process_invoice!`, `valid_invoice?`), and the DECLARATION scanner captures
  // only the base word — `[A-Za-z_]\w{4,}` stops at the punctuation — so the symbol set holds
  // `process_invoice` while an article copies `process_invoice!(invoice)`. Requiring `(`
  // immediately after the base word missed every one of them, in the two languages where the
  // form is idiomatic rather than rare.
  const re =
    /\b([A-Za-z_]\w{4,})[!?]?\s*\(|\bnew\s+([A-Za-z_]\w{4,})|\b([A-Za-z_]\w{4,})::|\b([A-Za-z_]\w{4,})[ \t]*\{/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = m[1] ?? m[2] ?? m[3] ?? m[4];
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
  /** Path relative to the knowledge-base root — includes subdirs. */
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

/** Destination relPath (under the knowledge-base root) for re-placing an existing
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

    const scopeExclude = await loadMiningScopeExcludeGlobs(ctx.db, ctx.taskId);
    await ctx.emitProgress('Collecting file tree for LLM orientation...');
    const fileTree = await collectShortFileTree(ctx.repoPath, scopeExclude);

    await ctx.emitProgress('Reading README...');
    const readmeExcerpt = await readReadmeExcerpt(ctx.repoPath);

    // BEFORE the scan, so a knowledge base that predates `.haive-data/` is visible to the
    // reuse prompt below exactly as it was when `KB_DIR` was `.claude/knowledge_base`.
    // Without this the scan returns nothing, the prompt offers no existing files, and a real
    // project's accumulated knowledge is silently regenerated from scratch.
    const migrated = await migrateLegacyKnowledge(ctx.repoPath, ctx.logger);
    if (migrated.moved.length + migrated.pendingMerge.length > 0) {
      await ctx.emitProgress(
        `Migrated ${migrated.moved.length + migrated.pendingMerge.length} knowledge file(s) from .claude/ into ${KB_DIR}` +
          (migrated.pendingMerge.length > 0
            ? ` (${migrated.pendingMerge.length} under legacy/ to merge into the page that displaced it)`
            : '') +
          '.',
      );
    }
    if (migrated.skipped.length > 0) {
      ctx.logger.warn(
        { skipped: migrated.skipped.slice(0, 10), count: migrated.skipped.length },
        'kb: left some legacy knowledge files in place',
      );
    }

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
      __scopeExclude: scopeExclude,
      __readmeExcerpt: readmeExcerpt ?? undefined,
      __existingKb: existingKb.length > 0 ? existingKb : undefined,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    preForm: true,
    buildPrompt: buildKnowledgePrompt,
    // Emptied and handed to the sandbox user before EVERY dispatch, not once per detect.
    // Body paths are deterministic (`<id>.md`), so an attempt that declares a path and then
    // fails to write it would read whatever an earlier attempt left at that name. Clearing
    // in detect() closed that for a human RETRY (detect re-runs) but not for a re-dispatch:
    // an invocation orphaned by a worker restart is superseded and re-dispatched through
    // `resolveLlmPhase`'s "no invocation exists yet" branch, which never re-runs detect.
    // MEASURED on task cbf0be06: 14 bodies written by the killed attempt were still on disk
    // when its replacement started one second later.
    //
    // The chown matters as much as the rm: the worker runs as ROOT while the sandboxed CLI
    // runs as uid 1000 — MEASURED, a plain mkdir left `.haive/kb-draft` root:root 0755 and
    // the agent could not write a single body into it.
    //
    // `prepareWorkspace` and not `prepare`, because the rm is DESTRUCTIVE and the directory
    // is shared: `prepare` runs before the prompt is built and therefore before any
    // reservation exists, so two concurrent advances can both reach it and the loser would
    // clear the winner's bodies. This hook runs only once the invocation insert has won.
    prepareWorkspace: async ({ ctx }) => {
      await prepareAgentWritableDir(ctx.repoPath, KB_DRAFT_DIR, ctx.logger);
    },
    timeoutMs: 90 * 60 * 1000, // 90 minutes — large repos need extensive tool_use scanning
    retry: { maxAttempts: 3, retryOn: (e) => e instanceof RetryableParseError },
    // Form-aware: re-roll before the manual-topics form when the LLM produced output
    // but nothing parsed (no entries / placements / updates) — so the user isn't
    // asked to hand-author topics on a transient bad turn.
    shouldRetryPreForm: (raw) => {
      const nonEmpty = typeof raw === 'string' ? raw.trim() !== '' : raw != null;
      if (!nonEmpty) return false;
      return (
        extractEntries(raw).length === 0 &&
        parseKbPlacements(raw).length === 0 &&
        parseKbUpdates(raw).length === 0
      );
    },
  },

  /** Read the staged bodies once, before the sync `form()` needs their size. The runner
   *  awaits this exactly where a step may produce an artifact the form refers to, which
   *  is precisely this case. Only counts are kept — see `__sectionCounts`. */
  async prepareForm(ctx, detected, llmOutput): Promise<void> {
    const staged = [
      ...extractEntries(llmOutput ?? null).map((e) => ({ id: e.id, bodyPath: e.bodyPath })),
      ...parseKbUpdates(llmOutput ?? null).map((u) => ({ id: u.path, bodyPath: u.bodyPath })),
    ].filter((x): x is { id: string; bodyPath: string } => typeof x.bodyPath === 'string');
    if (staged.length === 0) return;
    const notBefore = await loadRunStartedAt(ctx.db, ctx.taskStepId);
    const counts: Record<string, number> = {};
    for (const x of staged) {
      try {
        counts[x.id] = (await readKbBodyFile(ctx.repoPath, x.bodyPath, notBefore)).length;
      } catch {
        counts[x.id] = 0; // apply reports the real failure; the form just shows a number
      }
    }
    detected.__sectionCounts = counts;
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
        // A staged body has no inline sections here — `form()` is SYNC and the file is
        // read in prepareForm, which leaves only its COUNT behind. Falling back to 0
        // rather than throwing: this expression failing is what took the whole step down
        // once already, and a label is not worth a failed run.
        const sectionCount = e.sections?.length ?? detected.__sectionCounts?.[e.id] ?? 0;
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
      if (!repoSymbolsCache)
        repoSymbolsCache = await collectRepoSymbols(ctx.repoPath, detected.language);
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
    delete (detected as unknown as Record<string, unknown>).__scopeExclude;
    delete (detected as unknown as Record<string, unknown>).__readmeExcerpt;
    delete (detected as unknown as Record<string, unknown>).__existingKb;

    const kbDir = path.join(ctx.repoPath, KB_DIR);
    await mkdir(kbDir, { recursive: true });

    const rawEntries = extractEntries(args.llmOutput ?? null);
    const placements = parseKbPlacements(args.llmOutput ?? null);
    const rawUpdates = parseKbUpdates(args.llmOutput ?? null);

    // Bodies staged under `.haive/kb-draft/` are read back here, BEFORE routing,
    // promotion or rendering — so every path below sees an ordinary entry and none of
    // them learned a new shape. A failure drops that entry and is reported: one
    // unreadable body must not discard the fifteen beside it that are fine, and an entry
    // published with no sections would put a blank page under a canonical KB name.
    // A body older than the run that declared it belongs to an attempt that no longer
    // exists — see resolveStagedFile. Keyed on the invocation, because the step row outlives
    // both a retry and an orphan re-dispatch.
    const runStartedAt = await loadRunStartedAt(ctx.db, ctx.taskStepId, args.llmInvocationId);
    const entryBodies = await resolveBodies(ctx.repoPath, rawEntries, runStartedAt);
    const updateBodies = await resolveBodies(ctx.repoPath, rawUpdates, runStartedAt);
    const entries = entryBodies.resolved;
    const updates = updateBodies.resolved;
    const bodyFailures = [...entryBodies.failures, ...updateBodies.failures];
    if (bodyFailures.length > 0) {
      ctx.logger.warn(
        { count: bodyFailures.length, reasons: bodyFailures.slice(0, 5).map((f) => f.reason) },
        'kb: staged body files could not be read; those entries were dropped',
      );
    }
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
    // Paths the agent named that the KB scan does not know. Collected rather than merely
    // skipped: MEASURED on a real run, 40 placements and 1 update — every item it reported —
    // named files under a legacy `.claude/knowledge_base/` tree that `scanExistingKb` does not
    // read, so all 41 were dropped by these two `continue`s while the step reported success and
    // wrote its 28 new entries. One of them carried an 8,750-byte ARCHITECTURE body. Absence of
    // a write is indistinguishable from "nothing to do" unless it is stated.
    const unknownPaths: string[] = [];
    /** Legacy pages deleted because an update folded their content into a newer page. */
    const mergedRemoved: string[] = [];
    for (const u of updates) {
      const src = existingByPath.get(existingKbKey(u.path));
      if (!src) {
        unknownPaths.push(u.path);
        continue;
      }
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
        // The legacy copies this page absorbed. Removed only AFTER the merged page is on
        // disk, so a failed write leaves the original where it is rather than deleting the
        // one surviving copy of that knowledge.
        //
        // Restricted to the `legacy/` import dir, and that is the whole safety of this
        // feature rather than a tidiness rule: `mergedFrom` is agent-supplied, so without it
        // a model naming any KB page there — or the very page it just wrote — would have it
        // deleted. Files under `legacy/` are ones THIS step imported and whose content is by
        // construction duplicated in the page that displaced them.
        for (const merged of u.mergedFrom ?? []) {
          const rel = existingKbKey(merged);
          const safe = sanitizeKbRelPath(rel);
          if (!safe.ok || !safe.normalized.startsWith(`${LEGACY_IMPORT_SUBDIR}/`)) {
            ctx.logger.warn(
              { path: merged, dest },
              'kb: refusing to delete a merged source outside the legacy import dir',
            );
            continue;
          }
          await rm(path.join(kbDir, safe.normalized), { force: true });
          mergedRemoved.push(safe.normalized);
        }
        written.push({ id: src.relPath, filePath: destPath, source: 'updated' });
      } catch (err) {
        ctx.logger.warn({ err, path: u.path, dest }, 'kb update write failed');
      }
    }

    // 1b. Placements: move the (accurate) existing file verbatim to its slot, OR
    //     re-route a now-global file to the cross-repo KB and delete it locally.
    for (const p of placements) {
      const src = existingByPath.get(existingKbKey(p.path));
      if (!src) {
        unknownPaths.push(p.path);
        continue;
      }
      if (handledSrc.has(src.relPath)) continue;
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
                topicKey: globalKbTopicKey(category, facets, tech) ?? undefined,
                projectName: detected.projectName ?? undefined,
              },
              ctx.logger,
            );
            if (promo && !promo.deduped) {
              await rm(path.join(kbDir, src.relPath), { force: true });
              globalPromoted += 1;
              written.push({
                id: src.relPath,
                filePath: `${GLOBAL_KB_FILE_PATH_PREFIX}${promo.id}`,
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
      // written to the repo knowledge base, so they never feed this repo's RAG. The
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
            topicKey: globalKbTopicKey(category, facets, e.tech) ?? undefined,
            projectName: detected.projectName ?? undefined,
          },
          ctx.logger,
        );
        if (promo && !promo.deduped) {
          globalPromoted += 1;
          written.push({
            id: e.id,
            filePath: `${GLOBAL_KB_FILE_PATH_PREFIX}${promo.id}`,
            source: 'global',
          });
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

    // Every page this step believes it wrote has to be on disk. Asserted against the step's
    // OWN intent rather than a constant: a run where the user selected two topics is a
    // two-page knowledge base and not a defect, which is why the fixed ">= 3" this replaces
    // could not live at `07_5-verify-files` and cannot live here either. Thrown BEFORE the
    // discard below, so a run that lost a page keeps its drafts as the evidence.
    const expectedOnDisk = written
      .map((w) => w.filePath)
      .filter((fp) => !fp.startsWith(GLOBAL_KB_FILE_PATH_PREFIX));
    const missingPages: string[] = [];
    for (const fp of expectedOnDisk) {
      if (!(await pathExists(fp))) missingPages.push(path.relative(ctx.repoPath, fp));
    }
    if (missingPages.length > 0) {
      throw new Error(
        `knowledge base incomplete: ${missingPages.length} of ${expectedOnDisk.length} pages ` +
          `this step wrote are not on disk under ${KB_DIR} ` +
          `(${missingPages.slice(0, 5).join(', ')})`,
      );
    }

    // The drafts have been filed; keep them only when something could not be read, since
    // that is the one case where the files on disk are the evidence a human needs and a
    // retry re-runs the whole mining pass anyway.
    if (bodyFailures.length === 0) await discardKbDrafts(ctx.repoPath, ctx.logger);

    if (unknownPaths.length > 0) {
      ctx.logger.warn(
        { count: unknownPaths.length, sample: unknownPaths.slice(0, 5), kbDir: KB_DIR },
        'kb: reported existing-file paths are not in the knowledge base; those were not applied',
      );
    }

    ctx.logger.info(
      {
        written: written.length,
        placements: placements.length,
        llmAvailable,
        topicCount: entries.length,
        draftsKept: bodyFailures.length > 0,
        unknownPaths: unknownPaths.length,
        mergedRemoved: mergedRemoved.length,
        kbFileCount: finalFiles.length,
      },
      'knowledge base written',
    );
    return {
      written,
      topicCount: entries.length,
      llmAvailable,
      globalPromoted,
      kbFileCount: finalFiles.length,
      ...(unknownPaths.length > 0 ? { unknownPaths } : {}),
      ...(mergedRemoved.length > 0 ? { mergedRemoved } : {}),
    };
  },
};

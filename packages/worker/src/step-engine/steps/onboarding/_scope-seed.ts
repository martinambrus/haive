import { FRAMEWORK_PATTERNS } from '@haive/shared';
import { NO_RECURSE_DIRS } from '@haive/shared/scope-tree';

/** Directory prefixes Composer manages as third-party installs (Drupal core,
 *  contrib modules/themes, libraries, drush contrib). Derived from
 *  `extra.installer-paths` keys by stripping the `{$name}`/`{$vendor}` placeholder
 *  segment — e.g. `"web/modules/contrib/{$name}"` -> `"web/modules/contrib"`,
 *  `"web/core"` -> `"web/core"`. Authoritative for Drupal/Composer layout
 *  regardless of docroot (web/, root, or a custom web-root), which is why
 *  deterministic FRAMEWORK_PATTERNS alone fail on non-standard installs.
 *
 *  Composer is the one common ecosystem that intermixes vendored (contrib) and
 *  hand-authored (custom) code as SIBLINGS, so its manifest is the only one that
 *  needs parsing to tell them apart — Node/Python/Go/etc. keep all deps in
 *  node_modules/venv/vendor (already NO_RECURSE), so their custom code needs no
 *  manifest lookup to locate. Paths containing a `custom` segment are KEPT in
 *  scope even when Composer installs into them. */
export function composerExcludeDirs(composer: unknown): string[] {
  const extra = (composer as { extra?: { 'installer-paths'?: unknown } } | null)?.extra;
  const ip = extra?.['installer-paths'];
  if (!ip || typeof ip !== 'object') return [];
  const dirs = new Set<string>();
  for (const key of Object.keys(ip as Record<string, unknown>)) {
    const brace = key.indexOf('{$');
    const raw = brace >= 0 ? key.slice(0, brace) : key;
    const dir = raw.replace(/^\/+|\/+$/g, '');
    if (!dir) continue;
    if (/(^|\/)custom(\/|$)/i.test(dir)) continue;
    dirs.add(dir);
  }
  return [...dirs];
}

/** Directory paths a repo excludes via its own `.gitignore`. Ecosystem-agnostic
 *  and authoritative — the project itself declares which dirs are generated /
 *  vendored / build output (node_modules, dist, public/build, web sites files,
 *  target, __pycache__, ...), whatever the language.
 *
 *  Conservative parse: skip blanks, comments, negations (`!`), and any pattern
 *  with glob metachars (we can't map `*`/`?`/`[]` to a concrete tree dir safely);
 *  strip leading/trailing slashes. The final seed intersects these with the real
 *  directory tree, so a normalized path only survives if it names an actual dir —
 *  no over-exclusion from a `.gitignore` file rule. */
export function gitignoreExcludeDirs(gitignore: string | null | undefined): string[] {
  if (!gitignore) return [];
  const out = new Set<string>();
  for (const raw of gitignore.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    if (/[*?\[\]]/.test(line)) continue;
    const norm = line.replace(/^\/+|\/+$/g, '');
    if (norm) out.add(norm);
  }
  return [...out];
}

export interface SeedSources {
  /** Parsed composer.json (or null). */
  composer?: unknown;
  /** Raw .gitignore text (or null). */
  gitignore?: string | null;
  /** Detected framework key (drives FRAMEWORK_PATTERNS lookup). */
  framework: string | null;
  /** Every directory path present in the scope tree (used to filter the seed to
   *  real dirs). */
  treePaths: readonly string[];
}

/** Seed the onboarding scope deny list: the built-in / vendored / generated
 *  directories to pre-exclude (pre-untick) in the scope picker. Ecosystem-general
 *  union of, in order of specificity:
 *   - the always-collapsed NO_RECURSE dirs (universal: node_modules, vendor, .git,
 *     build, dist, venv, target, ...),
 *   - the detected framework pattern's excludePaths (multi-framework: wordpress,
 *     drupal, rails, laravel, nodejs, nextjs, python, ...),
 *   - the repo's own `.gitignore` directory rules (authoritative for ANY language),
 *   - Composer `installer-paths` (the one ecosystem whose vendored code lives
 *     beside custom code and needs the manifest to disambiguate).
 *
 *  Filtered to entries that correspond to a real directory node in `treePaths`, so
 *  a pattern that doesn't match this repo's actual layout (e.g. top-level
 *  `modules/contrib` on a web-docroot install) is dropped rather than seeding a
 *  phantom exclusion. Unknown / non-standard frameworks are the domain of the
 *  (deferred) LLM structure-detect; this deterministic seed is the fast path for
 *  the common cases. Returned sorted for a stable picker default + persisted value. */
export function computeSeedExcludeGlobs(sources: SeedSources): string[] {
  const { composer, gitignore, framework, treePaths } = sources;
  const treeSet = new Set(treePaths);
  const candidates = new Set<string>();

  for (const name of NO_RECURSE_DIRS) candidates.add(name);

  const pattern = framework
    ? FRAMEWORK_PATTERNS[framework as keyof typeof FRAMEWORK_PATTERNS]
    : undefined;
  for (const p of pattern?.excludePaths ?? []) {
    const norm = p.replace(/^\/+|\/+$/g, '');
    if (norm) candidates.add(norm);
  }

  for (const d of gitignoreExcludeDirs(gitignore)) candidates.add(d);
  for (const d of composerExcludeDirs(composer)) candidates.add(d);

  const out: string[] = [];
  for (const c of candidates) {
    if (treeSet.has(c)) out.push(c);
  }
  return out.sort();
}

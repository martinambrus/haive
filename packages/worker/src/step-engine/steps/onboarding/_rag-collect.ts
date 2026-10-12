import path from 'node:path';
import { HAIVE_DATA_DIR } from '@haive/shared';
import { listFilesMatching } from './_helpers.js';
import { isDeniedFile, isDeniedPath } from './_scope.js';
import { CODE_EXTENSIONS, isMinifiedPath, isOwnPath } from './_rag-chunkers.js';

/* ------------------------------------------------------------------ */
/* Shared RAG code-file collection                                     */
/*                                                                     */
/* ONE collector for every step that writes the vector store:          */
/* 10-rag-populate (onboarding), 02-pre-rag-sync (run start) and       */
/* 11c-rag-reindex (post-commit). It lives here, beside the chunkers   */
/* and the embed/connection helpers the workflow steps already import, */
/* so the dependency direction stays workflow -> onboarding.           */
/*                                                                     */
/* They used to be two copies, and the copies drifted: the workflow    */
/* one never gained the isMinifiedPath filter and never saw 09_7's     */
/* extension/folder selection, so a workflow run both ADDED minified    */
/* bundles onboarding had skipped and, through the orphan sweep,       */
/* DELETED onboarded files whose extension it did not collect. Keeping  */
/* one predicate is the fix; do not reintroduce a local copy.          */
/* ------------------------------------------------------------------ */

export const CODE_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  // Haive's own per-task git worktrees live under <repo>/.haive/worktrees/.
  // They are full copies of the repo, so indexing them would re-ingest every
  // file a second time under a `.haive/worktrees/<branch>/` prefix — doubling
  // the index and never matching onboarding's clean paths.
  '.haive',
  // The committed onboarding mirror. Holds the knowledge base + learnings,
  // which the KB collectors pick up through their source prefixes — as
  // knowledge, never as code.
  HAIVE_DATA_DIR,
  'vendor',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.ddev',
  '.cache',
  'coverage',
  '.tox',
  '.venv',
  'venv',
]);

export interface CodeCollectOptions {
  /** Anchored directory deny list: the per-repo onboarding scope globs (06_7 /
   *  09_7). Authoritative: an own path never overrides it. Also carries the
   *  ROOT_FILES_SCOPE token, which `isDeniedFile` resolves. */
  exclude?: readonly string[];
  /** 01-env-detect's custom-code exclude heuristic, applied only while no scope is
   *  saved. An entry of `ownPaths` overrides it. */
  heuristicExclude?: readonly string[];
  /** 01-env-detect's `customCodePaths.include`: the repository's own directories or
   *  files, which are collected even under a `heuristicExclude` entry. */
  ownPaths?: readonly string[];
  /** Folders picked in 09_7. Empty or absent means the whole repo is in scope. */
  selectedDirs?: readonly string[];
  /** Extensions picked in 09_7. Absent falls back to every known code
   *  extension — which is what a repo onboarded before 09_7 existed gets.
   *
   *  A plain array, not a Set: this whole object rides through a step's
   *  `detect` output, which is persisted as JSONB, and a Set serialises to
   *  `{}` — silently collecting nothing on a resumed step. */
  extensionSet?: readonly string[];
}

const stripTrailingSlash = (p: string): string => p.replace(/\/$/, '');

/** `customCodePaths.include` as read from a step output or an imported mirror: string entries only. */
export function ownPathList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];
}

/** The one "is this path left out of the index" decision, for the collector and the sync's
 *  orphan sweep. The scope deny list always wins; a heuristic entry is overridden by an own
 *  path, by anything under one, and (for a directory) by an ancestor of one so the walk
 *  can reach it. */
export function isCollectExcluded(
  rel: string,
  isDir: boolean,
  opts: Pick<CodeCollectOptions, 'exclude' | 'heuristicExclude' | 'ownPaths'>,
): boolean {
  // FRAMEWORK_PATTERNS.excludePaths — the 01-env-detect half of this list — are
  // written WITH a trailing slash ('core/', 'vendor/', 'wp-admin/'), while
  // isDeniedPath anchors on `rel === g || rel.startsWith(g + '/')`. Left as-is,
  // 'core/' matches nothing and a Drupal repo indexes all of core.
  if (isDeniedFile(rel, isDir, (opts.exclude ?? []).map(stripTrailingSlash))) return true;
  if (!isDeniedPath(rel, (opts.heuristicExclude ?? []).map(stripTrailingSlash))) return false;
  return !(opts.ownPaths ?? []).some(
    (entry) => isOwnPath(rel, entry) || (isDir && isOwnPath(entry, rel)),
  );
}

/** Repo-relative code files to index, sorted. Every caller must pass the SAME
 *  options it used at detect time, or the form's file count and the reconcile's
 *  `processedPaths` disagree and the orphan sweep deletes the difference. */
export async function collectCodeFiles(
  repo: string,
  opts: CodeCollectOptions = {},
): Promise<string[]> {
  const codeExts = new Set(opts.extensionSet ?? Object.keys(CODE_EXTENSIONS));
  const dirFilter =
    opts.selectedDirs && opts.selectedDirs.length > 0 ? new Set(opts.selectedDirs) : null;

  const files = await listFilesMatching(
    repo,
    (rel, isDir) => {
      const parts = rel.split('/');
      if (parts.some((p) => CODE_IGNORE_DIRS.has(p))) return false;
      if (isCollectExcluded(rel, isDir, opts)) return false;
      if (isDir) return false;
      if (dirFilter) {
        const topDir = parts.length === 1 ? '.' : parts[0]!;
        // Check both top-level and one nested level (e.g. 'modules/custom').
        let inSelected = dirFilter.has(topDir);
        if (!inSelected && parts.length > 2) {
          inSelected = dirFilter.has(parts.slice(0, 2).join('/'));
        }
        if (!inSelected) return false;
      }
      // Minified / generated bundles are machine-written and single-line: they
      // pollute the index with false hits and waste embedding budget.
      if (isMinifiedPath(rel)) return false;
      return codeExts.has(path.extname(rel).toLowerCase());
    },
    8,
  );

  return files.sort();
}

import path from 'node:path';
import { HAIVE_DATA_DIR } from '@haive/shared';
import { listFilesMatching } from './_helpers.js';
import { isDeniedFile } from './_scope.js';
import { CODE_EXTENSIONS, isMinifiedPath } from './_rag-chunkers.js';

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
   *  09_7), unioned with 01-env-detect's custom-code exclude heuristic. Also
   *  carries the ROOT_FILES_SCOPE token, which `isDeniedFile` resolves. */
  exclude?: readonly string[];
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

/** Repo-relative code files to index, sorted. Every caller must pass the SAME
 *  options it used at detect time, or the form's file count and the reconcile's
 *  `processedPaths` disagree and the orphan sweep deletes the difference. */
export async function collectCodeFiles(
  repo: string,
  opts: CodeCollectOptions = {},
): Promise<string[]> {
  const codeExts = new Set(opts.extensionSet ?? Object.keys(CODE_EXTENSIONS));
  const exclude = opts.exclude ?? [];
  const dirFilter =
    opts.selectedDirs && opts.selectedDirs.length > 0 ? new Set(opts.selectedDirs) : null;

  const files = await listFilesMatching(
    repo,
    (rel, isDir) => {
      const parts = rel.split('/');
      if (parts.some((p) => CODE_IGNORE_DIRS.has(p))) return false;
      if (isDeniedFile(rel, isDir, exclude)) return false;
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

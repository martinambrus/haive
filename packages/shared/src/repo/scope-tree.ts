import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import type { TreeNode } from '../schemas/form.js';

/** Directories shown in the scope tree as collapsed, toggleable leaves but NOT
 *  recursed into — huge / generated / vendored trees where descending would
 *  explode both the tree UI and the walk time. The previous per-step walkers
 *  (framework-detect `buildFileTree`, 09_7 `buildTree`, skill-gen
 *  `collectShortFileTree`, rag-populate) OMITTED these entirely, which is exactly
 *  what hid them from the user. Here they stay visible (so they can be excluded
 *  on purpose) but are never descended. Merges the four prior ad-hoc ignore
 *  lists into one baseline.
 *
 *  Note: `.git` is intentionally included — it must never be indexed, but the
 *  user should still SEE it in the tree; the seeded deny list pre-excludes it. */
export const NO_RECURSE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'vendor',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.turbo',
  'target',
  '.gradle',
  '.cache',
  'coverage',
  '.tox',
  '.venv',
  'venv',
]);

const DEFAULT_MAX_DEPTH = 10;

/** Deny token for the repository's own root-level files (files directly in the
 *  repo root, e.g. `index.php`). Chosen as `.` because `readdir` never yields it
 *  (collision-free with real paths), it is inert in the directory-prefix
 *  `isDeniedPath` match, and it survives the api exclusions sanitizer unchanged.
 *  Honoured by the file walkers via `isDeniedFile` and by `scopeInstructionLines`
 *  in the worker's `_scope.ts`. */
export const ROOT_FILES_SCOPE = '.';

/** Path of the synthetic transparent "Repository root" container node that the
 *  sub-directory nodes hang under. Never reaches the stored deny list — the
 *  frontier builders descend through it (see `collectDenyFrontier`). */
export const REPO_ROOT_NODE_PATH = '__repo_root__';

export interface ScopeTreeOptions {
  /** Lowercase extensions WITH the leading dot (e.g. ".php"). When set, a node's
   *  `fileCount` only counts files whose extension is in the set; omit to count
   *  every file. */
  extensions?: ReadonlySet<string>;
  /** Max directory recursion depth (default 10). NO_RECURSE_DIRS collapse
   *  regardless of depth. Root's direct children are depth 1. */
  maxDepth?: number;
}

/** Build the unified onboarding/RAG scope tree for `root`: a nested `TreeNode[]`
 *  of every directory INCLUDING hidden (dot) folders, each with a per-directory
 *  code-file count. Structure + counts ONLY — badge colours and default
 *  selections are applied by the caller (the scope-picker step, the repos-page
 *  editor) from the seeded deny list, so this stays a pure structural walk shared
 *  by the picker, the repos-page editor, and RAG. */
export async function buildScopeTree(
  root: string,
  opts: ScopeTreeOptions = {},
): Promise<TreeNode[]> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const extensions = opts.extensions ?? null;

  const subdirs = await childDirNodes(root, '', 0, maxDepth, extensions);
  const rootFileCount = await countDirectFiles(root, extensions);

  // Root's own direct files get their OWN leaf (deny token ROOT_FILES_SCOPE) so
  // they can be unticked — the previous tree had no node for them, so they were
  // always mined/indexed. Listed first, above the sub-dirs. Omitted when the
  // root has no code files (nothing to exclude).
  const children: TreeNode[] = [];
  if (rootFileCount > 0) {
    children.push({
      path: ROOT_FILES_SCOPE,
      label: 'root-level files',
      fileCount: rootFileCount,
      kind: 'root-files',
    });
  }
  children.push(...subdirs);

  // Truly empty repo (no sub-dirs, no root code files): preserve the callers'
  // `tree.length === 0` empty-guard.
  if (children.length === 0) return [];

  // Wrap everything under one transparent "Repository root" container so the
  // whole scope can be toggled at once. It carries no fileCount of its own (its
  // files live in the root-files leaf) and never enters the deny list.
  return [{ path: REPO_ROOT_NODE_PATH, label: 'Repository root', kind: 'repo-root', children }];
}

/** Count the direct (non-recursive) code files of `absDir`, honouring the same
 *  extension filter as the tree nodes. Used for the root-files leaf count. */
async function countDirectFiles(
  absDir: string,
  extensions: ReadonlySet<string> | null,
): Promise<number> {
  let entries: Dirent[];
  try {
    entries = (await readdir(absDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!extensions || extensions.has(path.extname(entry.name).toLowerCase())) count += 1;
  }
  return count;
}

/** TreeNodes for the sub-directories of `relDir` (relative to `absRoot`). Each
 *  directory is read exactly once: the same entry listing yields both the node's
 *  own `fileCount` and its child directories. */
async function childDirNodes(
  absRoot: string,
  relDir: string,
  depth: number,
  maxDepth: number,
  extensions: ReadonlySet<string> | null,
): Promise<TreeNode[]> {
  const absDir = relDir ? path.join(absRoot, relDir) : absRoot;
  let entries: Dirent[];
  try {
    entries = (await readdir(absDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return [];
  }

  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const rel = relDir ? `${relDir}/${name}` : name;
    // depth is the depth of relDir's children; `rel` sits at depth+1.
    const node = await buildDirNode(absRoot, rel, name, depth + 1, maxDepth, extensions);
    nodes.push(node);
  }
  nodes.sort((a, b) => a.label.localeCompare(b.label));
  return nodes;
}

/** Build the node for a single directory `rel`, reading it once for both its file
 *  count and its children (recursed unless the dir is in NO_RECURSE_DIRS or at the
 *  depth cap). */
async function buildDirNode(
  absRoot: string,
  rel: string,
  name: string,
  depth: number,
  maxDepth: number,
  extensions: ReadonlySet<string> | null,
): Promise<TreeNode> {
  const absDir = path.join(absRoot, rel);
  let entries: Dirent[];
  try {
    entries = (await readdir(absDir, { withFileTypes: true })) as Dirent[];
  } catch {
    entries = [];
  }

  let fileCount = 0;
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      if (!extensions || extensions.has(path.extname(entry.name).toLowerCase())) fileCount += 1;
    } else if (entry.isDirectory()) {
      subdirs.push(entry.name);
    }
  }

  const node: TreeNode = { path: rel, label: name, fileCount };

  const descend = !NO_RECURSE_DIRS.has(name) && depth < maxDepth;
  if (descend && subdirs.length > 0) {
    const children: TreeNode[] = [];
    for (const child of subdirs) {
      children.push(
        await buildDirNode(absRoot, `${rel}/${child}`, child, depth + 1, maxDepth, extensions),
      );
    }
    children.sort((a, b) => a.label.localeCompare(b.label));
    node.children = children;
  }

  return node;
}

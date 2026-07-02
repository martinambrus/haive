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
  return childDirNodes(root, '', 0, maxDepth, extensions);
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

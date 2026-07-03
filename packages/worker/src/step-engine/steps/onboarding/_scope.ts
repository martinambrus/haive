import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { Database } from '@haive/database';
import type { TreeNode } from '@haive/shared';
import { loadPreviousStepOutput } from './_helpers.js';

/** Load the per-repo onboarding scope deny list (`repositories.scope_exclude_globs`)
 *  for the repository behind `taskId`.
 *
 *  Returns `[]` when the repo has no list — a repo onboarded before this feature,
 *  one whose scope-selection step (06_7) was skipped, or one where the user kept
 *  every directory in scope. Callers then behave exactly as before: mining sees the
 *  whole repo minus the step's own hardcoded IGNORE_DIRS.
 *
 *  Defensive by design: the query is wrapped so a step-runner test with a mock db
 *  (no tasks/repositories tables) degrades to `[]` instead of throwing. */
export async function loadScopeExcludeGlobs(db: Database, taskId: string): Promise<string[]> {
  try {
    const rows = await db
      .select({ globs: schema.repositories.scopeExcludeGlobs })
      .from(schema.tasks)
      .innerJoin(schema.repositories, eq(schema.tasks.repositoryId, schema.repositories.id))
      .where(eq(schema.tasks.id, taskId))
      .limit(1);
    return rows[0]?.globs ?? [];
  } catch {
    return [];
  }
}

/** True when a repo-relative path IS an excluded directory or lives under one.
 *  Deny globs are anchored directory prefixes (e.g. `web/modules/contrib`), so an
 *  anchored prefix test — not a loose path-segment test — is the correct match. */
export function isDeniedPath(rel: string, exclude: readonly string[]): boolean {
  for (const g of exclude) {
    if (rel === g || rel.startsWith(`${g}/`)) return true;
  }
  return false;
}

/** Soft-scope instruction lines for a mining prompt. Tells the agent to mine only
 *  this project's own code and treat the excluded directories as third-party /
 *  built-in — reachable with read tools for context, but never mined or indexed.
 *  Returns `[]` when there is no deny list (nothing to say), so callers can spread
 *  it unconditionally. */
export function scopeInstructionLines(exclude: readonly string[]): string[] {
  if (exclude.length === 0) return [];
  return [
    '## Mining scope (IMPORTANT)',
    "Mine, analyse and index ONLY this project's own code. The partial file tree above is already",
    'filtered to the in-scope directories. The directories listed below are third-party or',
    'framework built-ins and are OUT OF SCOPE — do NOT mine, summarise or index them (you MAY',
    "still open an individual file there for context when this project's own code references it):",
    ...exclude.map((g) => `- ${g}`),
    'Any directory not listed above is in scope by default, including new folders added later.',
    '',
  ];
}

/** Raw repo-level RAG scope deny list, preserving NULL (never set) vs `[]` (set to
 *  empty = index everything). 09_7 uses this to distinguish "remember the stored
 *  RAG scope" from "no stored scope yet → default from the mining pick / seed".
 *  RAG consumers that just want a usable list use loadScopeExcludeGlobs (→ []). */
export async function loadRepoScopeExcludeGlobs(
  db: Database,
  taskId: string,
): Promise<string[] | null> {
  try {
    const rows = await db
      .select({ globs: schema.repositories.scopeExcludeGlobs })
      .from(schema.tasks)
      .innerJoin(schema.repositories, eq(schema.tasks.repositoryId, schema.repositories.id))
      .where(eq(schema.tasks.id, taskId))
      .limit(1);
    return rows[0]?.globs ?? null;
  } catch {
    return null;
  }
}

/** Load the TASK-scoped mining deny list produced by 06_7-scope-selection (its
 *  step output `excludeGlobs`). This is the scope for the KB + skill mining steps
 *  (08, 09-qa, 09_5, 09_5b) and is intentionally NOT persisted to the repo — it is
 *  onboarding-task-local. Falls back to the repo-level list (loadScopeExcludeGlobs)
 *  when 06_7 did not run for this task (e.g. an onboarding-upgrade that re-runs a
 *  mining step) so mining stays scoped rather than crawling the whole repo. */
export async function loadMiningScopeExcludeGlobs(db: Database, taskId: string): Promise<string[]> {
  const prev = await loadPreviousStepOutput(db, taskId, '06_7-scope-selection');
  const globs = (prev?.output as { excludeGlobs?: string[] } | null)?.excludeGlobs;
  if (Array.isArray(globs)) return globs;
  return loadScopeExcludeGlobs(db, taskId);
}

/** Resolve the repository id behind a task (null when the task has none, or on a
 *  mock db in step-runner tests). */
export async function resolveRepositoryId(db: Database, taskId: string): Promise<string | null> {
  try {
    const rows = await db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1);
    return rows[0]?.repositoryId ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* directory-tree scope-picker helpers (shared: 06_7 mining, 09_7 RAG) */
/* ------------------------------------------------------------------ */

/** Every dir path in the scope tree, depth-first. */
export function collectAllPaths(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    out.push(node.path);
    if (node.children) out.push(...collectAllPaths(node.children));
  }
  return out;
}

/** Total code-file count across the whole tree. */
export function sumFileCount(nodes: TreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += node.fileCount ?? 0;
    if (node.children) total += sumFileCount(node.children);
  }
  return total;
}

/** Default picker selection = every tree dir NOT covered by the deny list. The
 *  directory-tree checkbox treats a parent as fully-checked only when all its
 *  descendants are in the value set, so defaults must list every included node. */
export function collectDefaults(tree: TreeNode[], deny: readonly string[]): string[] {
  return collectAllPaths(tree).filter((p) => !isDeniedPath(p, deny));
}

/** The exclusion frontier: the minimal deny list equivalent to "keep exactly the
 *  selected paths in scope". A subtree collapses to ONE deny entry when nothing in
 *  it is selected; otherwise we descend so only its unselected branches are denied.
 *
 *  This makes bottom-up selection work: ticking a single subfolder (e.g.
 *  `themes/custom`) keeps it in scope and denies its siblings, instead of the parent
 *  `themes` swallowing the whole subtree. A parent need NOT itself be in the selected
 *  set for one of its descendants to survive — which is exactly how the web tree
 *  reports a partially-ticked parent (child paths present, parent path absent). */
export function collectDenyFrontier(tree: TreeNode[], selected: Set<string>, out: string[]): void {
  for (const node of tree) denyFrontierNode(node, selected, out);
}

/** Records `node`'s minimal deny frontier into `out`; returns true when the node or
 *  any descendant is selected (kept in scope). Bottom-up (children first) so a
 *  fully-unselected subtree collapses to a single entry for `node`. */
function denyFrontierNode(node: TreeNode, selected: Set<string>, out: string[]): boolean {
  const children = node.children ?? [];
  if (children.length === 0) {
    if (selected.has(node.path)) return true; // selected leaf -> kept in scope
    out.push(node.path); // unselected leaf -> its own deny entry
    return false;
  }
  const childOut: string[] = [];
  let anyKept = selected.has(node.path);
  for (const child of children) {
    if (denyFrontierNode(child, selected, childOut)) anyKept = true;
  }
  if (!anyKept) {
    out.push(node.path); // nothing under here is wanted -> collapse to one entry
    return false;
  }
  out.push(...childOut); // partially wanted -> keep the finer child frontier
  return true;
}

/** Parsed composer.json (or null) — a seed input for computeSeedExcludeGlobs. */
export async function readComposerJson(repoPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(repoPath, 'composer.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Raw .gitignore text (or null) — a seed input for computeSeedExcludeGlobs. */
export async function readGitignore(repoPath: string): Promise<string | null> {
  try {
    return await readFile(path.join(repoPath, '.gitignore'), 'utf8');
  } catch {
    return null;
  }
}

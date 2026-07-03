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

/** Hard-scope instruction lines for a mining prompt. Confines the agent to the
 *  project's own in-scope directories: it may read/grep/glob only inside them, and
 *  may step out ONLY to follow a single named reference from an in-scope file — never
 *  to browse. Framed as an allow-first sandbox (not a soft "please avoid") to stop
 *  the agent crawling huge framework/vendor/contrib trees and burning tokens — the
 *  dominant token cost of onboarding. Returns `[]` when there is no deny list
 *  (nothing to constrain), so callers can spread it unconditionally. */
export function scopeInstructionLines(exclude: readonly string[]): string[] {
  if (exclude.length === 0) return [];
  return [
    '## Mining scope — HARD CONSTRAINT',
    "Read, grep, glob, mine and index files ONLY inside this project's own in-scope",
    'directories (those shown in the file tree above). Treat the in-scope set as a sandbox:',
    'your exploration MUST stay inside it. Being thorough means being thorough WITHIN scope —',
    'never widening the search to the rest of the repository.',
    '',
    'The directories below are third-party / framework / generated code and are OUT OF SCOPE.',
    'Do NOT open, read, grep, list, sample or crawl them to discover or document anything, and',
    'never treat their code as a subject to mine in its own right:',
    ...exclude.map((g) => `- ${g}`),
    '',
    'The ONE permitted exception is a targeted reference lookup: when a specific in-scope file',
    'references a symbol defined out of scope (a parent class it extends, a service it injects,',
    'a function it imports), you MAY open THAT ONE referenced file to understand the in-scope',
    'code, then return to the in-scope set. That is following a single reference — never a',
    'browse. Do NOT enumerate, survey or "look around" an out-of-scope directory to see what',
    'is there.',
    '',
    'Why this matters: out-of-scope trees (framework core, vendored/contrib packages) are',
    'enormous; crawling them burns large amounts of tokens and documents code this project did',
    'not write. Stay in scope; step out only to the single file a specific in-scope line names.',
    '',
  ];
}

/** Unconditional "work as a single agent" block for a mining prompt. Tells the
 *  CLI agent not to spawn its OWN sub-agents during mining. Haive already fans
 *  mining out across agents at the orchestration layer (one cli-exec per
 *  capability), so a sub-agent the model spawns here only duplicates work and
 *  multiplies token cost. This is the uniform baseline across every CLI: the hard
 *  levers (claude-family `--disallowedTools Agent`, amp `amp.tools.disable`,
 *  gemini/codex settings) enforce it where a lever exists; for antigravity, which
 *  has NO such lever, this prompt is the only control. Names the per-CLI spawn
 *  tools explicitly so one wording covers claude-family/amp/gemini/codex/agy.
 *  Unconditional (unlike scopeInstructionLines) — always returned. */
export function noSubagentInstructionLines(): string[] {
  return [
    '## Single-agent execution — HARD CONSTRAINT',
    'Do ALL of this work yourself, in this one agent. Do NOT spawn, delegate to, or fan out',
    'into sub-agents, parallel agents, background agents or workers. If a tool for launching',
    'agents or parallel tasks exists (for example a Task, Agent, spawn_agent, invoke_agent or',
    'background-task tool), do NOT call it — call your file-reading and search tools (Read,',
    'Grep, Glob) directly instead. Mining is already parallelised across agents at the',
    'orchestration layer; a sub-agent you spawn here only duplicates work and multiplies token',
    'cost.',
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

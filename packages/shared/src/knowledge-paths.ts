import type { TreeNode } from './schemas/form.js';
import { HAIVE_DATA_DIR } from './types/index.js';

/* ------------------------------------------------------------------ */
/* Canonical on-disk locations for project knowledge                   */
/*                                                                     */
/* Knowledge rides the committed, clone-restored `.haive-data/` mirror */
/* dir rather than a vendor dir. Haive is model-agnostic — a Codex      */
/* user's agents live in `.codex/`, a Gemini user's in `.gemini/` — so  */
/* filing their project knowledge under `.claude/` was a wart. Note     */
/* `.haive-data/` is the COMMITTED dir; `.haive/` is the git-excluded   */
/* one (per-task worktrees) and never holds knowledge.                  */
/*                                                                     */
/* Dependency-free leaf: imported by the web bundle via the            */
/* `@haive/shared/knowledge-paths` subpath, never through the barrel   */
/* (which drags ioredis -> dns into the browser build).                */
/* ------------------------------------------------------------------ */

/** Where a knowledge gate stages a draft that is not a file yet, so the web UI
 *  can edit it before it is written (11-phase-8-learning stages its learnings and
 *  its investigation here; the api's file-edit route accepts writes into it).
 *
 *  Under the git-excluded `.haive/` rather than `.haive-data/` precisely because a
 *  draft is not knowledge until the gate writes it — an abandoned review must
 *  leave nothing behind, and nothing staged may ever reach a commit. */
export const LEARNING_DRAFTS_DIR = '.haive/learning-drafts';

export const KB_DIR = `${HAIVE_DATA_DIR}/knowledge_base`;
export const LEARNINGS_DIR = `${HAIVE_DATA_DIR}/learnings`;
export const INVESTIGATIONS_DIR = `${KB_DIR}/investigations`;

/** Path prefixes the RAG collectors walk to pick knowledge markdown out of a
 *  repo. Trailing slash so the test is an anchored directory-prefix match. */
export const KNOWLEDGE_SOURCE_PREFIXES = [`${KB_DIR}/`, `${LEARNINGS_DIR}/`] as const;

/** Dirs that must never be scope-excluded, regardless of picker state.
 *
 *  The scope pickers (06_7 mining, 09_7 RAG) and the repos-page scope editor
 *  build their tree over the whole repo INCLUDING dotfolders, so a user can
 *  untick `.haive-data` and cascade a deny glob over the knowledge tree. The KB
 *  survives today only because both RAG collectors read it through a hardcoded
 *  prefix that ignores the deny list — accidental safety that a later refactor
 *  would silently remove. These dirs are immune by construction instead. */
export const MANAGED_KNOWLEDGE_DIRS = [KB_DIR, LEARNINGS_DIR] as const;

/** Strip surrounding slashes so a hand-edited or legacy glob (`/.haive-data/`)
 *  compares the same as a picker-produced one.
 *
 *  Deliberately NOT `replace(/^\/+|\/+$/g, '')`, which is what this was and what
 *  every other trim site in the codebase copied. That pattern is polynomial: once a
 *  non-slash tail defeats the `$` anchor, the `\/+$` alternative is retried at every
 *  start position and each attempt backtracks through the whole slash run. MEASURED
 *  on `'x' + '/'.repeat(n) + 'x'` — 0.7ms at n=1000, 2.8 at 2000, 11 at 4000, 40 at
 *  8000, 167 at 16000, 650 at 32000: a clean 4x per doubling, so a ~320 KB string
 *  stalls the event loop for about a minute. (The obvious probe `'/'.repeat(n) + 'x'`
 *  shows NOTHING, because `^\/+` swallows the run in one match and leaves nothing to
 *  rescan — the slash run has to start past index 0.)
 *
 *  That input is reachable from outside: the api takes these globs verbatim from a
 *  request body (`routes/repos.ts`), and the onboarding scope seed parses them out of
 *  a CLONED USER REPO's `composer.json` installer-path keys and `.gitignore` lines
 *  (`_scope-seed.ts`), which is attacker-supplied by construction. This loop is O(n)
 *  and byte-identical in output — verified over the empty string, bare and repeated
 *  slashes, and every leading/trailing/interior combination. */
export function trimGlobSlashes(glob: string): string {
  let start = 0;
  while (start < glob.length && glob[start] === '/') start += 1;
  let end = glob.length;
  while (end > start && glob[end - 1] === '/') end -= 1;
  return glob.slice(start, end);
}

/** True when the `glob` subtree and the `dir` subtree overlap in either
 *  direction — the glob IS the dir, covers it (an ancestor), or lives inside it
 *  (a descendant). All three stop some part of the knowledge tree being read. */
function overlaps(glob: string, dir: string): boolean {
  return glob === dir || glob.startsWith(`${dir}/`) || dir.startsWith(`${glob}/`);
}

/** Drop every deny glob that would exclude any part of a managed knowledge dir.
 *
 *  Applied at each point a deny frontier is persisted AND inside the loaders, so
 *  the guarantee holds against hand-edited and pre-existing lists too. Purely
 *  subtractive: globs that touch nothing managed are returned unchanged, in
 *  order, so this is a no-op for the overwhelmingly common case. */
export function stripManagedKnowledgeGlobs(globs: readonly string[]): string[] {
  return globs.filter((glob) => {
    const normalized = trimGlobSlashes(glob);
    if (normalized.length === 0) return true;
    return !MANAGED_KNOWLEDGE_DIRS.some((dir) => overlaps(normalized, dir));
  });
}

/** Badge copy for a managed knowledge dir in the scope pickers. */
export const MANAGED_KNOWLEDGE_BADGE = 'always indexed';

/** Tag the managed knowledge dirs in a scope tree so the picker shows WHY
 *  unticking them has no effect. Purely cosmetic — the functional immunity is
 *  `stripManagedKnowledgeGlobs`; this only stops the tick-box looking broken.
 *
 *  Kept out of `buildScopeTree`, which is documented as a pure structural walk
 *  with badges applied by the caller. Pure: nodes with nothing to change are
 *  returned by reference. */
export function tagManagedKnowledgeNodes(nodes: readonly TreeNode[]): TreeNode[] {
  const managedDirs: readonly string[] = MANAGED_KNOWLEDGE_DIRS;
  return nodes.map((node) => {
    const children = node.children ? tagManagedKnowledgeNodes(node.children) : undefined;
    const isManaged = managedDirs.includes(node.path);
    if (!isManaged && !children) return node;
    return {
      ...node,
      ...(children ? { children } : {}),
      ...(isManaged ? { badge: MANAGED_KNOWLEDGE_BADGE, badgeColor: 'green' as const } : {}),
    };
  });
}

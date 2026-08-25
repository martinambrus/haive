/**
 * `plan_nodes.path` arithmetic.
 *
 * The path is a materialised ancestry — '/<rootId>/<childId>/…/<selfId>/' —
 * self-inclusive and slash-terminated. Both properties are load-bearing:
 * self-inclusive so ONE predicate (`path LIKE node.path || '%'`) selects a node
 * with its whole subtree, which is what every card's `(direct / total)` count is
 * computed from; slash-terminated so the prefix match is structural rather than
 * accidentally correct — without it '/a/b' would prefix-match '/a/bc'.
 *
 * Isolated here because a subtree move performs the same substitution twice, in
 * two languages: once in JS for the moved node's own row, and once as a SQL
 * `substring(...)` for its descendants. If those two ever disagree the tree
 * silently splits, so they are derived from one definition and tested together.
 */

/** The path of a node with `id` under a parent whose path is `parentPath`.
 *  A root has no parent, so its ancestry starts at the tree's own separator. */
export function planNodePath(parentPath: string | null, id: string): string {
  return `${parentPath ?? '/'}${id}/`;
}

/** Re-root one descendant path from `oldPrefix` onto `newPrefix`.
 *
 *  The SQL counterpart is
 *    `newPrefix || substring(path from <descendantPathSqlOffset(oldPrefix)>)`,
 *  and `descendantPathSqlOffset` exists so the two cannot drift: SQL's
 *  `substring(from n)` is 1-indexed where JS `slice(n)` is 0-indexed, which is
 *  exactly the kind of off-by-one that would corrupt every descendant of every
 *  moved node while leaving the moved node itself correct.
 *
 *  The SQL side MUST cast the offset (`from ${n}::int`). Untyped, Postgres
 *  resolves `substring(text, unknown)` to the POSIX-regex overload rather than
 *  the positional one, matches the number as a pattern, and returns NULL. */
export function rewriteDescendantPath(oldPrefix: string, newPrefix: string, path: string): string {
  if (!path.startsWith(oldPrefix)) return path;
  return newPrefix + path.slice(oldPrefix.length);
}

/** The 1-indexed offset SQL's `substring(path from N)` needs to strip
 *  `oldPrefix`. */
export function descendantPathSqlOffset(oldPrefix: string): number {
  return oldPrefix.length + 1;
}

/** The LIKE pattern selecting a node's DESCENDANTS but not the node itself.
 *  The trailing `_` requires at least one further character, which the node's own
 *  path (exactly `nodePath`) does not have. Paths contain only hex, hyphens and
 *  slashes, so no LIKE metacharacter can appear in the prefix and no escaping is
 *  needed. */
export function descendantsLikePattern(nodePath: string): string {
  return `${nodePath}_%`;
}

/** The LIKE pattern selecting a node AND its descendants. */
export function subtreeLikePattern(nodePath: string): string {
  return `${nodePath}%`;
}

/** Whether re-parenting the node at `nodePath` under `newParentPath` would
 *  detach the subtree from the tree.
 *
 *  A node moved under its own descendant still satisfies every foreign key while
 *  being unreachable from the root, so nothing downstream could report it
 *  missing — the tree would simply appear to have lost a branch. Self-inclusive
 *  paths make the test one comparison: the new parent is inside the subtree iff
 *  its path starts with the node's. */
export function wouldDetachSubtree(nodePath: string, newParentPath: string): boolean {
  return newParentPath.startsWith(nodePath);
}

/** Depth of a node from the root (the root is depth 0). Used to nest markdown
 *  headings in the rendered plan, and to enforce the build step's depth budget. */
export function planNodeDepth(path: string): number {
  // '/a/' -> 1 separator pair around one id -> depth 0.
  const segments = path.split('/').filter(Boolean).length;
  return Math.max(0, segments - 1);
}

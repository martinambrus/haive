import type { TreeNode } from '@haive/shared';

/** A tree can omit dependencies not yet installed in the main checkout. Editing
 *  another checkbox must not forget exclusions saved from the task worktree. */
export function preserveUnseenScopeExclusions(
  tree: readonly TreeNode[],
  nextExclusions: readonly string[],
  savedExclusions: readonly string[],
): string[] {
  const visible = new Set<string>();
  const visit = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      visible.add(node.path);
      visit(node.children ?? []);
    }
  };
  visit(tree);
  return [...new Set([...nextExclusions, ...savedExclusions.filter((p) => !visible.has(p))])];
}

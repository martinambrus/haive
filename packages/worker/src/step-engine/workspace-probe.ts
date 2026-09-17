import { lstatNoFollow } from '@haive/shared/fs-safe';
import { workspaceAnchor } from '../repo/worktree-paths.js';

/**
 * Whether `rel` names an entry inside a workspace, without following a link to decide.
 *
 * The workspace is a WORKTREE for most callers — under `.haive/`, which the sandbox mounts
 * read-write — so it is SPLIT rather than used as the anchor. `workspaceAnchor` falls back to the
 * path itself in root mode, so a repository root works here too.
 *
 * `kind !== 'symlink'` rather than a file-or-directory test, and the choice is constrained from
 * both sides. The `pathExists` calls this replaces were `stat`-based and so accepted EITHER kind —
 * `08b-test-management`'s own test fixtures a marker `cypress` as a FILE and asserts detection
 * still fires — so narrowing to a kind would change DETECTION rather than containment. But a LEAF
 * link is reported by lstat rather than refused, so it has to be excluded explicitly, which is the
 * verdict the readers of `.ddev/config.yaml` already reached: reached through a link, it is not
 * this project's file. A dangling link answers false either way, exactly as `stat` did.
 */
export async function hasWorkspaceEntry(workspace: string, rel: string): Promise<boolean> {
  const { anchor, prefix } = workspaceAnchor(workspace);
  const kind = (await lstatNoFollow(anchor, `${prefix}${rel}`))?.kind;
  return kind !== undefined && kind !== 'symlink';
}

import { KB_DIR, LEARNINGS_DIR } from '@haive/shared/knowledge-paths';
import type { Database } from '@haive/database';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import { resolveGitEnv } from '../../../secrets/user-git-identity.js';
import { gitGaveNoAnswer, gitRun } from '../../../repo/git-exec.js';
import { gitCommitStaged, gitStageScopedPaths } from '../../../repo/git-commit.js';

export const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};

// Knowledge-base + learnings trees. Both carry durable knowledge that must travel ON the
// feature branch: committed here → pushed (11a) → merged (12) → and so reaching a fresh
// clone (the file fallback when another instance has no shared RAG/DB). Repo-relative.
export const KB_PATHSPECS = [KB_DIR, LEARNINGS_DIR] as const;

export interface KbCommitResult {
  committed: boolean;
  commitSha: string | null;
  message: string;
}

export { gitRun } from '../../../repo/git-exec.js';
/**
 * Stage and commit the knowledge trees in `workspace`.
 *
 * Extracted from 11b-kb-commit so the external catch-up (01e) can land its edits the same
 * way, and it has to: `11-phase-8-learning`'s `revertKbSync` runs `git checkout HEAD --
 * KB_DIR` plus `git clean -fdq` when a user declines ITS knowledge sync. An earlier step's
 * uncommitted KB edits sit in that blast radius from index 1.8 all the way to 11b at 11.5,
 * so one decline at index 11 would silently destroy work the user had already approved.
 * Committing at 1.8 makes `checkout HEAD` restore TO the catch-up rather than past it.
 *
 * Narrowing `revertKbSync` to the learning agent's self-reported file list was the other
 * option and was rejected: that list is the agent's claim, so a revert scoped by it fails
 * open on exactly the file the agent forgot to mention.
 *
 * `git add` fatals on a pathspec that matches nothing (unlike `git status`), so only the
 * trees on disk or still in the index are staged. Already-staged whole-tree deletions
 * stay in the commit scope without being added again; never-tracked missing roots are omitted.
 * An already-clean tree is reported, never thrown: a retry that re-commits nothing is a
 * no-op, not a failure.
 */
export async function commitKnowledgeTrees(opts: {
  workspace: string;
  message: string;
  db: Database;
  userId: string;
  taskId: string;
}): Promise<KbCommitResult> {
  const { workspace, message } = opts;
  const present: string[] = [];
  const absent: string[] = [];
  const wa = workspaceAnchor(workspace);
  for (const spec of KB_PATHSPECS) {
    const entry = await lstatNoFollow(wa.anchor, `${wa.prefix}${spec}`);
    if (!entry) absent.push(spec);
    else if (entry.kind !== 'symlink') present.push(spec);
  }
  const scope = await gitStageScopedPaths(workspace, present, absent);
  if (scope.length === 0) {
    return { committed: false, commitSha: null, message: 'nothing to commit' };
  }
  const userEnv = await resolveGitEnv(opts.db, { userId: opts.userId, taskId: opts.taskId });
  const commitEnv = Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY;
  if (!(await gitCommitStaged(workspace, message, commitEnv, scope))) {
    return { committed: false, commitSha: null, message: 'nothing to commit' };
  }
  const sha = await gitRun(workspace, ['rev-parse', 'HEAD']);
  return { committed: true, commitSha: sha.code === 0 ? sha.stdout.trim() : null, message };
}

/**
 * Discard uncommitted knowledge-base edits in `worktree`.
 *
 * `checkout` restores tracked modifications and deletions, `clean` removes new files.
 * Scoped to the knowledge-base root: investigations are written after the learning gate
 * runs this, and learnings live elsewhere, so neither is affected.
 *
 * Best-effort on purpose — a brand-new repository with no tracked KB makes `checkout` a
 * no-op, and a decline must not fail the step it is declining. A no-answer from git throws; an
 * exit status is still ignored.
 *
 * Shared by the learning gate (11) and the external catch-up (01e) so there is one
 * destructive git path rather than two copies that can drift apart.
 */
export async function revertKnowledgeBase(worktree: string): Promise<void> {
  const noAnswer = 'the declined knowledge-base edits could not be reverted: git gave no answer';
  const checkout = await gitRun(worktree, ['checkout', 'HEAD', '--', KB_DIR]);
  if (gitGaveNoAnswer(checkout)) throw new Error(noAnswer);
  const clean = await gitRun(worktree, ['clean', '-fdq', '--', KB_DIR]);
  if (gitGaveNoAnswer(clean)) throw new Error(noAnswer);
}

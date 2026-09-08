import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { KB_DIR, LEARNINGS_DIR } from '@haive/shared/knowledge-paths';
import type { Database } from '@haive/database';
import { pathExists } from '../onboarding/_helpers.js';
import { resolveGitEnv } from '../../../secrets/user-git-identity.js';

const exec = promisify(execFile);

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

export async function gitRun(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const opts = env ? { cwd, env: { ...process.env, ...env } } : { cwd };
    const { stdout, stderr } = await exec('git', args, opts);
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

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
 * trees that exist are staged — a run may write knowledge_base without learnings, or the
 * reverse. An already-clean tree is reported, never thrown: a retry that re-commits
 * nothing is a no-op, not a failure.
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
  for (const spec of KB_PATHSPECS) {
    if (await pathExists(path.join(workspace, spec))) present.push(spec);
  }
  if (present.length === 0) {
    return { committed: false, commitSha: null, message: 'nothing to commit' };
  }
  const add = await gitRun(workspace, ['add', '--', ...present]);
  if (add.code !== 0) {
    throw new Error(`git add failed: ${add.stderr || add.stdout}`);
  }
  const userEnv = await resolveGitEnv(opts.db, { userId: opts.userId, taskId: opts.taskId });
  const commitEnv = Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY;
  const commit = await gitRun(workspace, ['commit', '-m', message], commitEnv);
  if (commit.code !== 0) {
    const stderr = commit.stderr || commit.stdout;
    if (/nothing to commit/i.test(stderr)) {
      return { committed: false, commitSha: null, message: 'nothing to commit' };
    }
    throw new Error(`git commit failed: ${stderr}`);
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
 * no-op, and a decline must not fail the step it is declining.
 *
 * Shared by the learning gate (11) and the external catch-up (01e) so there is one
 * destructive git path rather than two copies that can drift apart.
 */
export async function revertKnowledgeBase(worktree: string): Promise<void> {
  await gitRun(worktree, ['checkout', 'HEAD', '--', KB_DIR]);
  await gitRun(worktree, ['clean', '-fdq', '--', KB_DIR]);
}

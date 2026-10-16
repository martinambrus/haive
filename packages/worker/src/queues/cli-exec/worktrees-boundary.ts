import { posix } from 'node:path';
import { WORKTREE_SUBDIR } from '@haive/shared';
import { ensureDirNoFollow } from '@haive/shared/fs-safe';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { lookupInRepoMount } from './gitfile-mask.js';

const HAIVE_DIR = posix.dirname(WORKTREE_SUBDIR);

/** `.haive/worktrees` read-only for an agent sandbox mounted at the repository root, where it holds every other task's writable worktree. */
export async function worktreesBoundary(
  repoMount: DockerVolumeMount | null,
  opts: { hasWorktree: boolean; hasRepo: boolean },
): Promise<DockerVolumeMount[]> {
  if (opts.hasWorktree || !opts.hasRepo || !repoMount?.subpath) return [];
  const { source, target, subpath } = repoMount;
  const root = await lookupInRepoMount(subpath, '');
  if (root.entry?.kind !== 'directory') {
    throw new Error(
      `${subpath} is not a directory, so ${WORKTREE_SUBDIR} cannot be kept read-only in it`,
    );
  }
  const refusal = (rel: string) =>
    new Error(
      `${rel} in ${subpath} is a file or a link, so an agent could swap the worktrees for a directory of its own; move it aside, then retry`,
    );

  const haive = await lookupInRepoMount(subpath, HAIVE_DIR);
  if (haive.entry !== null && haive.entry.kind !== 'directory') throw refusal(HAIVE_DIR);
  const worktrees = await lookupInRepoMount(subpath, WORKTREE_SUBDIR);
  if (worktrees.entry === null) {
    const owner = { uid: root.entry.stats.uid, gid: root.entry.stats.gid };
    await ensureDirNoFollow(worktrees.anchor, worktrees.rel, { owner });
  } else if (worktrees.entry.kind !== 'directory') {
    throw refusal(WORKTREE_SUBDIR);
  }
  return [
    // `.haive` mounted onto itself, read-write: a mount point cannot be renamed, so the worktrees
    // cannot be swapped out by moving their parent away.
    { source, target: posix.join(target, HAIVE_DIR), subpath: `${subpath}/${HAIVE_DIR}` },
    {
      source,
      target: posix.join(target, WORKTREE_SUBDIR),
      subpath: `${subpath}/${WORKTREE_SUBDIR}`,
      readOnly: true,
    },
  ];
}

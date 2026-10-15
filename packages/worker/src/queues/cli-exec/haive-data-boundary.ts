import { posix } from 'node:path';
import { ensureDirNoFollow } from '@haive/shared/fs-safe';
import { HAIVE_DATA_DIR } from '@haive/shared';
import { KB_DIR, LEARNINGS_DIR } from '@haive/shared/knowledge-paths';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { lookupInRepoMount } from './gitfile-mask.js';

/** `.haive-data/` read-only for an agent sandbox; `knowledge_base/` and `learnings/` read-write. */
export async function haiveDataBoundary(
  repoMount: DockerVolumeMount | null,
  opts: { hasRepo: boolean },
): Promise<DockerVolumeMount[]> {
  if (!opts.hasRepo || !repoMount?.subpath) return [];
  const { source, target, subpath } = repoMount;
  const root = await lookupInRepoMount(subpath, '');
  if (root.entry?.kind !== 'directory') return [];
  const owner = { uid: root.entry.stats.uid, gid: root.entry.stats.gid };

  const isDirectory = async (rel: string, create: boolean): Promise<boolean> => {
    const found = await lookupInRepoMount(subpath, rel);
    if (found.entry === null && create) {
      await ensureDirNoFollow(found.anchor, found.rel, { owner });
      return true;
    }
    return found.entry?.kind === 'directory';
  };
  const mountOf = (rel: string, readOnly: boolean): DockerVolumeMount => ({
    source,
    target: posix.join(target, rel),
    subpath: `${subpath}/${rel}`,
    ...(readOnly ? { readOnly } : {}),
  });

  if (!(await isDirectory(HAIVE_DATA_DIR, true))) return [];
  const mounts = [mountOf(HAIVE_DATA_DIR, true)];
  if (await isDirectory(KB_DIR, false)) mounts.push(mountOf(KB_DIR, false));
  if (await isDirectory(LEARNINGS_DIR, true)) mounts.push(mountOf(LEARNINGS_DIR, false));
  return mounts;
}

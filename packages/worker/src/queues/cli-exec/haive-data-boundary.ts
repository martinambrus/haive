import { posix } from 'node:path';
import { ensureDirNoFollow, lstatNoFollow, readdirNoFollow } from '@haive/shared/fs-safe';
import { HAIVE_DATA_DIR } from '@haive/shared';
import { KB_DIR, LEARNINGS_DIR } from '@haive/shared/knowledge-paths';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { lookupInRepoMount } from './gitfile-mask.js';

/** The first protected file with more hard links than names in the read-only part of `.haive-data`. */
async function aliasedFile(anchor: string, prefix: string): Promise<string | null> {
  const relOf = (name: string) => [prefix, name].filter((part) => part !== '').join('/');
  const writable = new Set([relOf(KB_DIR), relOf(LEARNINGS_DIR)]);
  const inodes = new Map<string, { rel: string; nlink: number; names: number }>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdirNoFollow(anchor, dir, { strict: true })) ?? []) {
      const rel = `${dir}/${entry.name}`;
      if (writable.has(rel)) continue;
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.isFile()) {
        const info = await lstatNoFollow(anchor, rel, { strict: true });
        if (info?.kind !== 'file') continue;
        const key = `${info.stats.dev}:${info.stats.ino}`;
        const seen = inodes.get(key) ?? { rel, nlink: info.stats.nlink, names: 0 };
        seen.names += 1;
        inodes.set(key, seen);
      }
    }
  };
  await walk(relOf(HAIVE_DATA_DIR));
  const found = [...inodes.values()].find((file) => file.nlink > file.names);
  return found ? found.rel.slice(prefix === '' ? 0 : prefix.length + 1) : null;
}

/** `.haive-data/` read-only for an agent sandbox; `knowledge_base/` and `learnings/` read-write. */
export async function haiveDataBoundary(
  repoMount: DockerVolumeMount | null,
  opts: { hasRepo: boolean },
): Promise<DockerVolumeMount[]> {
  if (!opts.hasRepo || !repoMount?.subpath) return [];
  const { source, target, subpath } = repoMount;
  const root = await lookupInRepoMount(subpath, '');
  if (root.entry?.kind !== 'directory') {
    throw new Error(
      `${subpath} is not a directory, so ${HAIVE_DATA_DIR} cannot be kept read-only in it`,
    );
  }
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

  if (!(await isDirectory(HAIVE_DATA_DIR, true))) {
    throw new Error(
      `${HAIVE_DATA_DIR} in ${subpath} is a file or a link, so an agent could replace it with a directory of its own; move it aside, then retry`,
    );
  }
  // Checked twice: a file fs-safe is parking can show two links between a listing and its lstat.
  const aliased =
    (await aliasedFile(root.anchor, root.rel)) === null
      ? null
      : await aliasedFile(root.anchor, root.rel);
  if (aliased !== null) {
    throw new Error(
      `${aliased} in ${subpath} has another hard link outside the read-only part of ${HAIVE_DATA_DIR}, so an agent could rewrite it through that name; remove the other link, then retry`,
    );
  }
  const mounts = [mountOf(HAIVE_DATA_DIR, true)];
  if (await isDirectory(KB_DIR, false)) mounts.push(mountOf(KB_DIR, false));
  if (await isDirectory(LEARNINGS_DIR, true)) mounts.push(mountOf(LEARNINGS_DIR, false));
  return mounts;
}

import type { Database, MergeResolveState } from '@haive/database';
import {
  restoreKeptMetadata,
  resyncHaiveProjections,
  type KeptFile,
  type KeptFiles,
} from '../project-state/set-aside.js';

export type KeptMetadata = NonNullable<MergeResolveState['keptMetadata']>;

export function keptMetadataOf(kept: KeptFiles): KeptMetadata {
  const metadata: KeptMetadata = {};
  for (const [path, { bytes, owner, mode, untracked, parents }] of kept) {
    const entry: KeptMetadata[string] = {};
    if (untracked && Buffer.isBuffer(bytes) && owner && mode !== undefined) {
      entry.owner = owner;
      entry.mode = mode;
    }
    if (parents && parents.length > 0) entry.parents = parents;
    if (Object.keys(entry).length > 0) metadata[path] = entry;
  }
  return metadata;
}

function keptFilesOf(metadata: KeptMetadata): KeptFiles {
  return new Map(
    Object.entries(metadata).map(([path, { owner, mode, parents }]): [string, KeptFile] => [
      path,
      { index: null, bytes: Buffer.alloc(0), untracked: owner !== undefined, owner, mode, parents },
    ]),
  );
}

export async function restoreKeptMetadataOf(state: MergeResolveState): Promise<MergeResolveState> {
  if (!state.keptMetadata) return state;
  await restoreKeptMetadata(state.mergeDir, keptFilesOf(state.keptMetadata));
  return { ...state, keptMetadata: undefined };
}

/** `from` with what another task's set-aside kept: captured before this one's, so it wins. */
export function adoptKept(from: MergeResolveState, adopted: KeptMetadata): MergeResolveState {
  return Object.keys(adopted).length > 0
    ? { ...from, keptMetadata: { ...from.keptMetadata, ...adopted } }
    : from;
}

/** Once a same-branch merge is over: re-syncs, restores `keptMetadata`, saves the state cleared. A re-sync
 *  that did not complete returns false and saves nothing, so a later settle still has the metadata. */
export async function settleProjections(
  db: Database,
  repositoryId: string,
  given: MergeResolveState,
  save: (cleared: MergeResolveState) => Promise<unknown>,
): Promise<boolean> {
  if (!(await resyncHaiveProjections(db, repositoryId, given.mergeDir))) return false;
  if (given.keptMetadata) await save(await restoreKeptMetadataOf(given));
  return true;
}

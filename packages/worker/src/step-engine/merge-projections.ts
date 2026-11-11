import type { Database, MergeResolveState } from '@haive/database';
import { restoreKeptMetadata, resyncWithKeptMetadata } from '../project-state/set-aside.js';

import { keptFilesOf, type KeptMetadata } from '../project-state/kept-metadata.js';
export { keptMetadataOf, type KeptMetadata } from '../project-state/kept-metadata.js';

export async function restoreKeptMetadataOf(state: MergeResolveState): Promise<MergeResolveState> {
  if (!state.keptMetadata) return state;
  if ((await restoreKeptMetadata(state.mergeDir, keptFilesOf(state.keptMetadata))) === false)
    return state;
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
  if (
    !(await resyncWithKeptMetadata(
      db,
      repositoryId,
      given.mergeDir,
      keptFilesOf(given.keptMetadata ?? {}),
    ))
  )
    return false;
  if (given.keptMetadata) {
    const cleared = await restoreKeptMetadataOf(given);
    if (cleared.keptMetadata) return false;
    await save(cleared);
  }
  return true;
}

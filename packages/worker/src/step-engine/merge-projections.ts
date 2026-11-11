import type { Database, MergeResolveState } from '@haive/database';
import { resyncHaiveProjections } from '../project-state/set-aside.js';

import { rememberKeptMetadata, type KeptMetadata } from '../project-state/kept-metadata.js';
type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0];
class HandoffSuperseded extends Error {}

export { keptMetadataOf, type KeptMetadata } from '../project-state/kept-metadata.js';

/** `from` with what another task's set-aside kept: captured before this one's, so it wins. */
export function adoptKept(from: MergeResolveState, adopted: KeptMetadata): MergeResolveState {
  return Object.keys(adopted).length > 0
    ? { ...from, keptMetadataStored: false, keptMetadata: { ...from.keptMetadata, ...adopted } }
    : from;
}

/** The outbox owns restoration. A legacy map is handed off once; successful sync
 *  clears the redundant state copy without ever applying it a second time. */
export async function settleProjections(
  db: Database,
  repositoryId: string,
  given: MergeResolveState,
  save: (cleared: MergeResolveState, db: DbOrTx) => Promise<unknown>,
): Promise<boolean> {
  let state = given;
  if (state.keptMetadata && !state.keptMetadataStored) {
    const handedOff = { ...state, keptMetadataStored: true };
    try {
      await db.transaction(async (tx) => {
        // Save the marker and map together, before any filesystem recovery.
        // A stale guarded state write must roll back the whole handoff.
        if ((await save(handedOff, tx)) === false) throw new HandoffSuperseded();
        await rememberKeptMetadata(tx, repositoryId, state.mergeDir, state.keptMetadata!);
      });
    } catch (err) {
      if (err instanceof HandoffSuperseded) return false;
      throw err;
    }
    state = handedOff;
  }
  if (!(await resyncHaiveProjections(db, repositoryId, state.mergeDir))) return false;
  if (state.keptMetadata && (await save({ ...state, keptMetadata: undefined }, db)) === false)
    return false;
  return true;
}

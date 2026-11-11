import { type DbTx } from '@haive/database';
import {
  ROOT_MERGE_BUSY_MESSAGE,
  rootMergeBusy,
  taskRootMergeBusy,
} from '@haive/shared/root-merge-busy';
import { HttpError } from '../context.js';
import { boundedLockWait } from './repository-busy.js';

/** START already holds lockRepositoryTasksKey in its transaction. */
export async function assertRootMergeIdle(
  tx: DbTx,
  taskId: string,
  task: { repositoryId: string; worktreePath?: string | null; worktreeBranch?: string | null },
): Promise<void> {
  if (await rootMergeBusy(tx, taskId, task)) throw new HttpError(409, ROOT_MERGE_BUSY_MESSAGE);
}

/** Recovery actions take the same lock before checking and keep it through their writes. */
export async function assertTaskRootMergeIdle(tx: DbTx, taskId: string): Promise<void> {
  if (await boundedLockWait(tx, () => taskRootMergeBusy(tx, taskId)))
    throw new HttpError(409, ROOT_MERGE_BUSY_MESSAGE);
}

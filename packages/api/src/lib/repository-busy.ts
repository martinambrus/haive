import {
  boundedLockWait as boundedDatabaseLockWait,
  REPOSITORY_TASKS_LOCK_TIMEOUT_MS,
  isLockNotAvailable,
  type DbTx,
} from '@haive/database';
import { logger } from '@haive/shared';
import { HttpError } from '../context.js';

export const REPOSITORY_BUSY = 'The repository is busy, try again';

export async function boundedLockWait<T>(
  tx: DbTx,
  take: () => Promise<T>,
  timeoutMs = REPOSITORY_TASKS_LOCK_TIMEOUT_MS,
): Promise<T> {
  try {
    return await boundedDatabaseLockWait(tx, take, timeoutMs);
  } catch (err) {
    if (!isLockNotAvailable(err)) throw err;
    logger.warn({ err }, 'a request gave up waiting for a repository lock');
    throw new HttpError(409, REPOSITORY_BUSY);
  }
}

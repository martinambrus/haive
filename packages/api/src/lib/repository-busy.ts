import { sql } from 'drizzle-orm';
import { REPOSITORY_TASKS_LOCK_TIMEOUT_MS, isLockNotAvailable, type DbTx } from '@haive/database';
import { logger } from '@haive/shared';
import { HttpError } from '../context.js';

export const REPOSITORY_BUSY = 'The repository is busy, try again';

export async function boundedLockWait<T>(tx: DbTx, take: () => Promise<T>): Promise<T> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${REPOSITORY_TASKS_LOCK_TIMEOUT_MS}ms'`));
  let result: T;
  try {
    result = await take();
  } catch (err) {
    if (!isLockNotAvailable(err)) throw err;
    logger.warn({ err }, 'a task start gave up waiting for the repository lock');
    throw new HttpError(409, REPOSITORY_BUSY);
  }
  // Later writes in this transaction wait on other rows by design; the bound covers the lock only.
  await tx.execute(sql.raw('SET LOCAL lock_timeout = DEFAULT'));
  return result;
}

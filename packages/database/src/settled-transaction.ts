import type { Database } from './index.js';
import type { DbTx } from './task-attachments-lock.js';

/** postgres.js can reject a transaction while its callback still awaits filesystem/subprocess IO.
 * Drain that callback before an outer root lease or dedicated client is released. This preserves
 * the driver's original outcome; it does not keep a lost SQL lock or transaction alive. */
export async function withSettledTransaction<T>(
  handle: Database | DbTx,
  work: (tx: DbTx) => Promise<T>,
  config?: Parameters<Database['transaction']>[1],
): Promise<T> {
  let section: Promise<T> | undefined;
  try {
    return await (handle as Database).transaction((tx) => {
      section = work(tx);
      return section;
    }, config);
  } finally {
    await section?.catch(() => undefined);
  }
}

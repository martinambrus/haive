/** Direct handler fixtures model the API's admission before invoking worker code.
 * Queue race controls use the production handlers and tokens directly instead. */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import * as clone from '../../src/repo/clone.js';
import { withRepoJobOwner } from '../../src/repo/job-owner.js';

export * from '../../src/repo/clone.js';

async function admitted<T>(db: Database, id: string, run: () => Promise<T>) {
  const jobId = randomUUID();
  await db
    .update(schema.repositories)
    .set({ refreshPending: true, refreshJobId: jobId })
    .where(eq(schema.repositories.id, id));
  try {
    return await withRepoJobOwner(id, jobId, run);
  } finally {
    await db
      .update(schema.repositories)
      .set({ refreshPending: false, refreshJobId: null })
      .where(and(eq(schema.repositories.id, id), eq(schema.repositories.refreshJobId, jobId)));
  }
}
function handler<A extends unknown[]>(
  fn: (payload: Parameters<typeof clone.handleClone>[0], db: Database, ...args: A) => Promise<void>,
) {
  return (payload: Parameters<typeof clone.handleClone>[0], db: Database, ...args: A) =>
    admitted(db, payload.repositoryId, () => fn(payload, db, ...args));
}
export const handleClone = handler(clone.handleClone);
export const handleCopyLocal = handler(clone.handleCopyLocal);
export const handleExtract = handler(clone.handleExtract);
export const handleInit = handler(clone.handleInit);
export const handleScan = handler(clone.handleScan);
export const handleRefresh: typeof import('../../src/repo/refresh.js').handleRefresh = (...args) =>
  admitted(args[1], args[0].repositoryId, async () =>
    (await import('../../src/repo/refresh.js')).handleRefresh(...args),
  );
export const persistDetection: typeof clone.persistDetection = (...args) =>
  admitted(args[0], args[1], () => clone.persistDetection(...args));

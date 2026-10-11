import { HttpError } from '../context.js';
import type { Database } from '../db.js';

export type UploadKind = 'repo' | 'db-dump' | 'bundle';

const writing = new Set<string>();

/** Runs `fn` while it holds the upload's chunk lock, and refuses at once with 409 when another chunk
 *  PUT of the same upload holds it. In the process, not in Postgres: a lock held in a transaction
 *  would hold a pooled connection for as long as the body streams in. */
export async function withUploadChunkLock<T>(
  db: Database,
  kind: UploadKind,
  uploadId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const key = `${kind}:${uploadId}`;
  if (writing.has(key)) throw new HttpError(409, 'chunk races another writer');
  writing.add(key);
  try {
    return await fn(db);
  } finally {
    writing.delete(key);
  }
}

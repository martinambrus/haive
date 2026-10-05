import type { schema } from '@haive/database';
import { openFileNoFollow } from '@haive/shared/fs-safe';
import { databaseSnapshotRel } from '@haive/shared/database-snapshot-files';
import { databaseSnapshotStorageRoot } from '../repo/database-snapshots.js';
import { ddevImportDb, type DdevRunnerHandle } from './ddev-runner.js';

/** Restore after startup without recreating the runner or making another dump
 * copy. Only the chosen held file is streamed into DDEV through stdin. */
export async function importDdevDatabaseSnapshot(
  handle: DdevRunnerHandle,
  snapshot: typeof schema.databaseSnapshots.$inferSelect,
  signal: AbortSignal,
  onLine?: (line: string) => void,
): Promise<{ exitCode: number; output: string }> {
  signal.throwIfAborted();
  const file = await openFileNoFollow(
    databaseSnapshotStorageRoot(),
    databaseSnapshotRel(snapshot),
    'read',
    { strict: true },
  );
  if (!file) throw new Error('The saved database file is missing');
  try {
    const result = await ddevImportDb(handle, '', {
      stdin: file,
      signal,
      format: { pgRestore: false, gzipped: true },
      timeoutMs: 1_800_000,
      onLine,
    });
    signal.throwIfAborted();
    return result;
  } finally {
    await file.close();
  }
}

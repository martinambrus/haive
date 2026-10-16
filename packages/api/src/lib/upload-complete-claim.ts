import { and, eq, lt, or } from 'drizzle-orm';
import { schema, type DbTx } from '@haive/database';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { HttpError } from '../context.js';
import type { Database } from '../db.js';

/** A claim older than this belongs to a complete whose request died. */
export const COMPLETE_CLAIM_STALE_MS = 10 * 60 * 1000;

type UploadTable =
  typeof schema.repoUploads | typeof schema.dbUploads | typeof schema.customBundleUploads;

interface SessionWrite {
  status?: 'complete';
  updatedAt?: Date;
  archivePath?: string;
  dumpPath?: string;
  bundleId?: string;
}

interface UploadClaim {
  /** Lands only while this complete still holds its claim; a lost claim is a 409. */
  write(handle: Database | DbTx, values: SessionWrite): Promise<void>;
}

async function takeClaim(db: Database, table: UploadTable, id: string): Promise<Date> {
  const stamp = new Date();
  const [taken] = await db
    .update(table)
    .set({ status: 'completing', updatedAt: stamp })
    .where(
      and(
        eq(table.id, id),
        or(
          eq(table.status, 'uploading'),
          and(
            eq(table.status, 'completing'),
            lt(table.updatedAt, new Date(stamp.getTime() - COMPLETE_CLAIM_STALE_MS)),
          ),
        ),
      ),
    )
    .returning({ id: table.id });
  if (taken) return stamp;
  const [row] = await db.select({ status: table.status }).from(table).where(eq(table.id, id));
  if (row?.status === 'complete') throw new HttpError(409, 'session already completed');
  if (row?.status === 'completing') {
    throw new HttpError(409, 'a complete of this session is already running');
  }
  throw new HttpError(409, 'session cancelled');
}

/** Holds the session in `completing` while `run` works; a failure gives it back unless taken over. */
export async function withCompleteClaim<T>(
  db: Database,
  table: UploadTable,
  id: string,
  run: (claim: UploadClaim) => Promise<T>,
): Promise<T> {
  const stamp = await takeClaim(db, table, id);
  const held = and(eq(table.id, id), eq(table.status, 'completing'), eq(table.updatedAt, stamp));
  try {
    return await run({
      write: async (handle, values) => {
        const [done] = await handle
          .update(table)
          .set(values)
          .where(held)
          .returning({ id: table.id });
        if (!done) throw new HttpError(409, 'session is no longer held by this complete');
      },
    });
  } catch (err) {
    await db
      .update(table)
      .set({ status: 'uploading', updatedAt: new Date() })
      .where(held)
      .catch(() => undefined);
    throw err;
  }
}

/** A regular file of exactly `size` bytes; a link there fails rather than report its target. */
export async function isWholeFile(anchor: string, rel: string, size: number): Promise<boolean> {
  const info = await lstatNoFollow(anchor, rel);
  return info?.kind === 'file' && info.stats.size === size;
}

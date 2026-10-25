import { and, eq, lt, or } from 'drizzle-orm';
import { schema, type DbTx } from '@haive/database';
import { logger } from '@haive/shared';
import { lstatNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { HttpError } from '../context.js';
import type { Database } from '../db.js';

/** A claim older than this belongs to a complete whose request died. */
export const COMPLETE_CLAIM_STALE_MS = 10 * 60 * 1000;

/** A complete that is still working renews its claim this often, so only a dead one goes stale. */
export const COMPLETE_CLAIM_RENEW_MS = 60 * 1000;

type UploadTable =
  typeof schema.repoUploads | typeof schema.dbUploads | typeof schema.customBundleUploads;

interface SessionWrite {
  status?: 'complete';
  updatedAt?: Date;
  archivePath?: string;
  dumpPath?: string;
  bundleId?: string;
}

type HeldWrite = SessionWrite | { status: 'uploading'; updatedAt: Date };

interface UploadClaim {
  /** Lands only while this complete still holds its claim; a lost claim is a 409. */
  write(handle: Database | DbTx, values: SessionWrite): Promise<void>;
}

/** A session no complete can take: cancelled, being removed, or parked after a removal that failed. */
export const isSessionOver = (status: string): boolean =>
  status === 'cancelled' || status === 'reaping' || status === 'reap_failed';

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
  if (row?.status === 'complete' || row?.status === 'consumed') {
    throw new HttpError(409, 'session already completed');
  }
  if (row?.status === 'completing') {
    throw new HttpError(409, 'a complete of this session is already running');
  }
  if (row?.status === 'uploading') {
    throw new HttpError(409, 'a complete of this session ended without finishing it; try again');
  }
  throw new HttpError(409, 'session cancelled');
}

/** Holds and renews the claim while `run` works; a failure gives the session back if still held. */
export async function withCompleteClaim<T>(
  db: Database,
  table: UploadTable,
  id: string,
  run: (claim: UploadClaim) => Promise<T>,
): Promise<T> {
  let stamp = await takeClaim(db, table, id);
  const heldAt = (at: Date) =>
    and(eq(table.id, id), eq(table.status, 'completing'), eq(table.updatedAt, at));
  let renewing: Promise<void> | undefined;
  const renew = async (): Promise<void> => {
    const next = new Date();
    const [renewed] = await db
      .update(table)
      .set({ updatedAt: next })
      .where(heldAt(stamp))
      .returning({ id: table.id });
    if (renewed) stamp = next;
    else clearInterval(timer);
  };
  const timer = setInterval(() => {
    renewing ??= renew()
      .catch((err: unknown) => {
        logger.warn({ err, id }, 'upload claim renewal failed; the next tick retries');
      })
      .finally(() => {
        renewing = undefined;
      });
  }, COMPLETE_CLAIM_RENEW_MS);
  timer.unref();
  // A miss may be a renewal that moved the stamp meanwhile: go again on it, else the claim is lost.
  const writeHeld = async (handle: Database | DbTx, values: HeldWrite): Promise<boolean> => {
    for (;;) {
      const at = stamp;
      const [done] = await handle
        .update(table)
        .set(values)
        .where(heldAt(at))
        .returning({ id: table.id });
      if (done) return true;
      await renewing;
      if (stamp === at) return false;
    }
  };
  try {
    return await run({
      write: async (handle, values) => {
        if (!(await writeHeld(handle, values))) {
          throw new HttpError(409, 'session is no longer held by this complete');
        }
      },
    });
  } catch (err) {
    clearInterval(timer);
    await writeHeld(db, { status: 'uploading', updatedAt: new Date() }).catch(() => undefined);
    throw err;
  } finally {
    clearInterval(timer);
  }
}

/** Cancels an `uploading` session; one whose file stays is left `reaping` for the upload reaper. */
export async function cancelUploadSession(
  db: Database,
  table: UploadTable,
  id: string,
  anchor: string,
  rels: (string | null)[],
  finish?: () => Promise<void>,
): Promise<void> {
  const [taken] = await db
    .update(table)
    .set({ status: 'reaping', updatedAt: new Date() })
    .where(and(eq(table.id, id), eq(table.status, 'uploading')))
    .returning({ id: table.id });
  if (!taken) throw new HttpError(409, 'session is not uploading');
  let gone = true;
  for (const rel of rels) {
    if (rel === null) continue;
    try {
      await removeNoFollow(anchor, rel);
    } catch (err) {
      gone = false;
      logger.warn({ err, rel }, 'upload cancel left a file for the upload reaper');
    }
  }
  if (finish) {
    try {
      await finish();
    } catch (err) {
      gone = false;
      logger.warn({ err, id }, 'upload cancel left cleanup for the upload reaper');
    }
  }
  if (!gone) return;
  await db
    .update(table)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(table.id, id), eq(table.status, 'reaping')))
    .catch((err: unknown) => {
      logger.warn({ err, id }, 'upload cancel left the session reaping for the upload reaper');
    });
}

/** A regular file of exactly `size` bytes; a link there fails rather than report its target. */
export async function isWholeFile(anchor: string, rel: string, size: number): Promise<boolean> {
  const info = await lstatNoFollow(anchor, rel);
  return info?.kind === 'file' && info.stats.size === size;
}

import path from 'node:path';
import { logger } from '@haive/shared';
import { and, eq, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { bundleReplacementSchema, type BundleReplacement } from '@haive/shared/schemas';
import {
  fileIdentity,
  lstatNoFollow,
  isPathContainmentError,
  openDirNoFollow,
  readFileNoFollow,
  removeNoFollow,
  renameNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';

/** A malformed record or refused record path cannot supply the saved choice, so the bundle
 *  is failed rather than left for a retry. An I/O error stays a plain error, left to retry. */
export class ReplacementRecordUnreadable extends Error {
  constructor(cause: unknown) {
    super('the bundle replacement record could not be parsed', { cause });
    this.name = 'ReplacementRecordUnreadable';
  }
}

export const UNREADABLE_REPLACEMENT_ERROR =
  'The saved replacement choice for this bundle could not be read, so the import stopped. Use Replace ZIP to try again, or remove the bundle.';

export async function readReplacement(
  root: string,
  archiveRel: string,
): Promise<BundleReplacement | null> {
  const recordRel = `${archiveRel}.replacement.json`;
  const saved = await readFileNoFollow(root, recordRel, {
    maxBytes: 8192,
    strict: true,
  }).catch((err: unknown) => {
    // A refused path cannot become a valid record on a later tick. Leave real I/O faults
    // retryable, and never follow or remove a refused path to recover its contents.
    if (
      isPathContainmentError(err) &&
      (err.reason === 'link' || err.reason === 'not-directory' || err.reason === 'not-regular-file')
    )
      throw new ReplacementRecordUnreadable(err);
    throw err;
  });
  if (!saved) return null;
  try {
    return bundleReplacementSchema.parse(JSON.parse(saved.data.toString('utf8')));
  } catch (err) {
    throw new ReplacementRecordUnreadable(err);
  }
}

export async function recordReplacementSwap(
  root: string,
  archiveRel: string,
  destRel: string,
  stageRel: string,
  replacement: BundleReplacement,
): Promise<void> {
  const tree = await lstatNoFollow(root, destRel, { strict: true });
  if (tree?.kind !== 'directory')
    throw new Error(
      'The previous extracted tree is unavailable; automatic rollback cannot restore it.',
    );
  const held = await openDirNoFollow(root, destRel);
  try {
    const id = await fileIdentity(held);
    replacement.recovery = {
      stageName: path.posix.basename(stageRel),
      dev: String(id.dev),
      ino: String(id.ino),
    };
    await writeFileNoFollow(root, `${archiveRel}.replacement.json`, JSON.stringify(replacement), {
      durable: true,
    });
  } finally {
    await held.close();
  }
}

/** The saved directory inode proves which tree belongs to the old catalog. A directory at
 * extracted alone proves nothing after a crash. Recovery itself is safe to repeat after death. */
export async function restoreReplacementTree(
  root: string,
  destRel: string,
  replacement: BundleReplacement,
): Promise<boolean> {
  const recovery = replacement.recovery;
  if (!recovery)
    return (await lstatNoFollow(root, destRel, { strict: true }))?.kind === 'directory';
  const matches = async (rel: string) => {
    if ((await lstatNoFollow(root, rel, { strict: true }))?.kind !== 'directory') return false;
    const held = await openDirNoFollow(root, rel);
    try {
      const id = await fileIdentity(held);
      return String(id.dev) === recovery.dev && String(id.ino) === recovery.ino;
    } finally {
      await held.close();
    }
  };
  if (await matches(destRel)) return true;
  const oldRel = `${path.posix.dirname(destRel)}/${recovery.stageName}/old`;
  if (!(await matches(oldRel))) return false;
  await removeNoFollow(root, destRel, { recursive: true, repairPermissions: true });
  await renameNoFollow(root, oldRel, destRel);
  return await matches(destRel);
}

type Bundle = typeof schema.customBundles.$inferSelect;
type RecoveryPatch = Partial<typeof schema.customBundles.$inferInsert>;

// One live worker per install. Keep a slow pass owned even after its durable retry clock ages.
const recoveringBundles = new Set<string>();

/** Claim with a fresh retry clock, release the connection for disk work, then fence settlement.
 * A process death leaves syncing + the clock; after the stranded cutoff the next pass repeats
 * the inode-checked restoration. Neither a concurrent sweep nor a new source may settle it. */
export async function recoverBundle(
  db: Database,
  id: string,
  eligible: SQL | undefined,
  prepare: (bundle: Bundle) => Promise<RecoveryPatch | null>,
): Promise<boolean> {
  if (recoveringBundles.has(id)) return false;
  recoveringBundles.add(id);
  try {
    const claimed = await db.transaction(async (tx) => {
      const [bundle] = await tx
        .select()
        .from(schema.customBundles)
        .where(
          and(
            eq(schema.customBundles.id, id),
            eq(schema.customBundles.status, 'syncing'),
            eligible,
          ),
        )
        .for('update');
      if (!bundle) return null;
      const updatedAt = new Date();
      await tx
        .update(schema.customBundles)
        .set({ updatedAt })
        .where(eq(schema.customBundles.id, id));
      return { ...bundle, updatedAt };
    });
    if (!claimed) return false;
    const patch = await prepare(claimed);
    if (!patch) return false;
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.customBundles)
        .where(eq(schema.customBundles.id, id))
        .for('update');
      if (
        !current ||
        current.status !== 'syncing' ||
        current.updatedAt.getTime() !== claimed.updatedAt.getTime() ||
        current.archivePath !== claimed.archivePath
      )
        return false;
      await tx
        .update(schema.customBundles)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.customBundles.id, id));
      return true;
    });
  } finally {
    recoveringBundles.delete(id);
  }
}

/** Prepare only: callers settle this patch under their recovery claim, after disk work ends. */
export async function replacementRecoveryPatch(
  root: string,
  bundle: Bundle,
  replacement: BundleReplacement,
  reason: string,
): Promise<RecoveryPatch | null> {
  if (replacement.mode !== 'keep_until_success' || !replacement.previousArchive) return null;
  const restored = await restoreReplacementTree(
    root,
    `${bundle.userId}/${bundle.id}/extracted`,
    replacement,
  );
  return restored
    ? {
        ...replacement.previousArchive,
        status: 'active',
        lastSyncError: null,
        lastReplacementNote: `Replacement failed; the previous bundle remains in use. ${reason}`,
      }
    : {
        status: 'failed',
        lastReplacementNote: null,
        lastSyncError: `Replacement failed and the previous extracted tree is unavailable; automatic rollback cannot restore it. ${reason}`,
      };
}

export async function restoreReplacementBundle(
  db: Database,
  root: string,
  bundle: Bundle,
  replacement: BundleReplacement,
  reason: string,
): Promise<boolean> {
  let handled = true;
  await recoverBundle(
    db,
    bundle.id,
    eq(schema.customBundles.archivePath, bundle.archivePath!),
    async (current) => {
      const patch = await replacementRecoveryPatch(root, current, replacement, reason);
      if (!patch) handled = false;
      return patch;
    },
  );
  // A newer admission or completed catalog owns a row that no longer matches.
  return handled;
}

/** Cleanup follows the catalog commit. Failure must not roll a committed tree back. */
export async function clearReplacementRecord(root: string, archiveRel: string): Promise<void> {
  await removeNoFollow(root, `${archiveRel}.replacement.json`).catch((err: unknown) => {
    logger.warn({ err, archiveRel }, 'completed bundle replacement record was not removed');
  });
}

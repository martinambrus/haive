import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { bundleReplacementSchema, type BundleReplacement } from '@haive/shared/schemas';
import {
  fileIdentity,
  lstatNoFollow,
  openDirNoFollow,
  readFileNoFollow,
  removeNoFollow,
  renameNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';

export async function readReplacement(
  root: string,
  archiveRel: string,
): Promise<BundleReplacement | null> {
  const saved = await readFileNoFollow(root, `${archiveRel}.replacement.json`, {
    maxBytes: 8192,
    strict: true,
  });
  return saved ? bundleReplacementSchema.parse(JSON.parse(saved.data.toString('utf8'))) : null;
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

export async function restoreReplacementBundle(
  db: Database,
  root: string,
  bundle: typeof schema.customBundles.$inferSelect,
  replacement: BundleReplacement,
  reason: string,
): Promise<boolean> {
  if (replacement.mode !== 'keep_until_success' || !replacement.previousArchive) return false;
  const restored = await restoreReplacementTree(
    root,
    `${bundle.userId}/${bundle.id}/extracted`,
    replacement,
  );
  await db
    .update(schema.customBundles)
    .set(
      restored
        ? {
            ...replacement.previousArchive,
            status: 'active',
            lastSyncError: null,
            lastSyncNote: `Replacement failed; the previous bundle remains in use. ${reason}`,
            updatedAt: new Date(),
          }
        : {
            status: 'failed',
            lastSyncError: `Replacement failed and the previous extracted tree is unavailable; automatic rollback cannot restore it. ${reason}`,
            updatedAt: new Date(),
          },
    )
    .where(
      and(
        eq(schema.customBundles.id, bundle.id),
        eq(schema.customBundles.archivePath, bundle.archivePath!),
      ),
    );
  return true;
}

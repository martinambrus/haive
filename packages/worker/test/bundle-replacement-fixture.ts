import { mkdir, rename, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { schema } from '@haive/database';
import type { createFakeDb } from '@haive/database/testing';

/** Materialize exactly the disk/row state left by SIGKILL at each swap boundary. */
export async function seedCrashedReplacement(
  root: string,
  fake: ReturnType<typeof createFakeDb>,
  point: string,
) {
  const userId = '00000000-0000-4000-8000-0000000000a1';
  const bundleId = '00000000-0000-4000-8000-0000000000b1';
  const dir = path.join(root, userId, bundleId);
  const dest = path.join(dir, 'extracted');
  const stageName = '.haive-extract-123-11111111-1111-4111-8111-111111111111';
  const stage = path.join(dir, stageName);
  const archivePath = path.join(dir, 'source.new.zip');
  const previousArchive = {
    archivePath: path.join(dir, 'source.zip'),
    archiveFilename: 'old.zip',
    archiveFormat: 'zip',
  };
  await mkdir(dest, { recursive: true });
  await writeFile(path.join(dest, 'old.md'), 'old tree');
  const identity = await stat(dest, { bigint: true });
  await writeFile(archivePath, 'corrupt zip forces redelivery to fail');
  const recovery = { stageName, dev: String(identity.dev), ino: String(identity.ino) };
  if (point !== 'before extract') {
    await mkdir(path.join(stage, 'x'), { recursive: true });
    await writeFile(path.join(stage, 'x', 'new.md'), 'new tree');
  }
  if (['between renames', 'after swap', 'previous lost'].includes(point)) {
    await rename(dest, path.join(stage, 'old'));
    if (point !== 'between renames') await rename(path.join(stage, 'x'), dest);
    if (point === 'previous lost') await rm(path.join(stage, 'old'), { recursive: true });
  }
  const replacement = {
    mode: 'keep_until_success',
    previousArchive,
    ...(['between renames', 'after swap', 'previous lost'].includes(point) ? { recovery } : {}),
  };
  await writeFile(`${archivePath}.replacement.json`, JSON.stringify(replacement));
  fake.insert(schema.customBundles, {
    id: bundleId,
    userId,
    repositoryId: '00000000-0000-4000-8000-0000000000f1',
    name: 'kit',
    sourceType: 'zip',
    archivePath,
    archiveFilename: 'new.zip',
    archiveFormat: 'zip',
    storageRoot: dest,
    status: 'syncing',
    updatedAt: new Date(Date.now() - 20 * 60_000),
  });
  fake.insert(schema.customBundleItems, {
    id: '00000000-0000-4000-8000-0000000000e1',
    bundleId,
    sourcePath: 'old.md',
    contentHash: 'old',
  });
  return {
    dest,
    previousArchive,
    archivePath,
    payload: {
      bundleId,
      userId,
      archivePath,
      replacement: { mode: 'keep_until_success' as const, previousArchive },
    },
  };
}

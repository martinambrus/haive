import {
  fileIdentity,
  removeFileIfIdentityNoFollow,
  removeNoFollow,
  openFileNoFollow,
  readFileNoFollow,
  renameNoFollow,
  writeFileNoFollow,
} from './fs-safe.js';
export class BundleReplacementError extends Error {}

/** A replacement has its own final name. The intent proves which inode was moved there;
 * absence of the partial, or another upload's equally sized archive, proves nothing. */
export async function placeReplacementArchive(
  anchor: string,
  partial: string,
  final: string,
  size: number,
): Promise<void> {
  const intentRel = `${final}.move.json`;
  const identityAt = async (rel: string) => {
    const file = await openFileNoFollow(anchor, rel, 'read', { strict: true });
    if (!file) return null;
    try {
      const identity = await fileIdentity(file);
      return {
        dev: String(identity.dev),
        ino: String(identity.ino),
        size: (await file.stat()).size,
      };
    } finally {
      await file.close();
    }
  };
  const staged = await identityAt(partial);
  const saved = await readFileNoFollow(anchor, intentRel, { maxBytes: 4096, strict: true });
  let intent: { partial: string; final: string; dev: string; ino: string; size: number };
  if (saved === null) {
    if (!staged || staged.size !== size)
      throw new BundleReplacementError('archive size mismatch on disk');
    // Written atomically ahead of the move, so a dead process leaves either no intent or all of it.
    intent = { partial, final, ...staged };
    await writeFileNoFollow(anchor, intentRel, JSON.stringify(intent), {
      createParents: true,
      durable: true,
    });
  } else {
    try {
      intent = JSON.parse(saved.data.toString('utf8')) as typeof intent;
    } catch {
      throw new BundleReplacementError('replacement archive move record is unreadable');
    }
    if (
      intent.partial !== partial ||
      intent.final !== final ||
      intent.size !== size ||
      typeof intent.dev !== 'string' ||
      typeof intent.ino !== 'string'
    )
      throw new BundleReplacementError(
        'replacement archive move record does not match this upload',
      );
  }
  const matches = (found: Awaited<ReturnType<typeof identityAt>>) =>
    found?.dev === intent.dev && found.ino === intent.ino && found.size === size;
  if (staged) {
    if (!matches(staged))
      throw new BundleReplacementError('replacement upload changed after its move was recorded');
    try {
      await renameNoFollow(anchor, partial, final, { createParents: true, noReplace: true });
    } catch (err) {
      if (!matches(await identityAt(final))) throw err;
    }
  }
  if (!matches(await identityAt(final))) {
    throw new BundleReplacementError(
      'replacement archive is missing or does not belong to this upload',
    );
  }
}

/** Called only after the upload was cancelled/reaped, and only when no bundle uses this source.
 * A different inode at the final name is never ours to clean up. */
export async function discardReplacementArchive(
  anchor: string,
  partial: string,
  final: string,
  size: number,
): Promise<void> {
  const saved = await readFileNoFollow(anchor, `${final}.move.json`, {
    maxBytes: 4096,
    strict: true,
  });
  if (!saved) return;
  const intent: unknown = JSON.parse(saved.data.toString('utf8'));
  if (!intent || typeof intent !== 'object') return;
  const record = intent as Record<string, unknown>;
  if (
    record.partial !== partial ||
    record.final !== final ||
    record.size !== size ||
    typeof record.dev !== 'string' ||
    typeof record.ino !== 'string' ||
    !/^\d+$/.test(record.dev) ||
    !/^\d+$/.test(record.ino)
  )
    return;
  const removed = await removeFileIfIdentityNoFollow(anchor, final, {
    dev: BigInt(record.dev),
    ino: BigInt(record.ino),
  });
  if (removed !== 'kept') await removeNoFollow(anchor, `${final}.move.json`);
}

export function replacementArchiveRel(
  userId: string,
  bundleId: string,
  uploadId: string,
  format: string,
): string {
  return `${userId}/${bundleId}/source.${uploadId}.${format}`;
}

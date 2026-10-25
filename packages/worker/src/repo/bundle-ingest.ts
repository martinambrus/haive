import { buildCredentialHelper, originGitRun, scrubSecret } from './git-push.js';
import { bundleGitAuth } from './bundle-git.js';
import { redactGitUrl } from '@haive/shared/schemas';
import path from 'node:path';
import { ensureDirNoFollow, lstatNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { logger, type ArchiveFormat, type BundleJobPayload } from '@haive/shared';
import { isBundleRootDir } from '../bundle-parser/classifier.js';
import { parseBundle, persistBundleItems } from '../bundle-parser/index.js';
import { assertCloneUrl, extractArchive, gitClone } from './clone.js';
import { gitRun } from './git-exec.js';

/** Resolves the per-bundle storage root inside the haive_bundles volume. The
 *  layout is `<root>/<userId>/<bundleId>/extracted/`. The archive (if any)
 *  sits next to it as `<root>/<userId>/<bundleId>/source.<ext>`. */
function bundleExtractedDir(bundleStorageRoot: string, userId: string, bundleId: string): string {
  return path.join(bundleStorageRoot, userId, bundleId, 'extracted');
}

/** The same layout as a rel under the bundle volume, for the anchored primitives. The volume root is
 *  the trusted end; `<userId>/<bundleId>/extracted` is walked one component at a time, because that
 *  leaf holds whatever the author's archive or clone put there. */
function bundleDirRel(userId: string, bundleId: string): string {
  return `${userId}/${bundleId}`;
}

/** The bundle archive's rel under the bundle volume, or null for anything but the one file the api
 *  moves there, `<userId>/<bundleId>/source.<ext>`: a row naming another path is refused rather
 *  than read. */
export function bundleArchiveRel(
  bundleStorageRoot: string,
  stored: string,
  userId: string,
  bundleId: string,
): string | null {
  const dir = bundleDirRel(userId, bundleId);
  const prefix = `${path.join(bundleStorageRoot, dir)}/`;
  if (!stored.startsWith(prefix)) return null;
  const name = stored.slice(prefix.length);
  if (!name.startsWith('source.') || name.includes('/')) return null;
  return `${dir}/${name}`;
}

export async function gitRevParseHead(cwd: string): Promise<string> {
  const res = await gitRun(cwd, ['rev-parse', 'HEAD']);
  if (res.code !== 0) {
    throw new Error(`git rev-parse failed (exit ${res.noExit ?? res.code}): ${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}

async function gitFetchAndCheckout(
  db: Database,
  bundle: typeof schema.customBundles.$inferSelect,
): Promise<void> {
  const args = ['pull', '--ff-only', 'origin'];
  if (bundle.gitBranch) args.push(bundle.gitBranch);
  const auth = await bundleGitAuth(db, bundle);
  const res = await originGitRun(bundle.storageRoot, [...auth.argv, ...args], auth.env);
  if (res.code !== 0) {
    const msg = scrubSecret(res.stderr, auth.secret).trim();
    throw new Error(`git pull failed (exit ${res.noExit ?? res.code}): ${msg}`);
  }
}

async function loadBundle(
  db: Database,
  bundleId: string,
): Promise<typeof schema.customBundles.$inferSelect> {
  const row = await db.query.customBundles.findFirst({
    where: eq(schema.customBundles.id, bundleId),
  });
  if (!row) throw new Error(`bundle not found: ${bundleId}`);
  return row;
}

/** A claim naming a removed item no longer reaches the record, so the record is stale. */
async function markIfItemsRemoved(
  db: Database,
  repositoryId: string,
  removed: number,
): Promise<void> {
  if (removed > 0) await markProjectStateDirty(db, repositoryId);
}

async function setBundleActive(
  db: Database,
  bundleId: string,
  patch: Partial<typeof schema.customBundles.$inferInsert>,
): Promise<void> {
  await db
    .update(schema.customBundles)
    .set({ status: 'active', updatedAt: new Date(), ...patch })
    .where(eq(schema.customBundles.id, bundleId));
}

async function setBundleFailed(db: Database, bundleId: string, error: string): Promise<void> {
  await db
    .update(schema.customBundles)
    .set({
      status: 'failed',
      lastSyncError: error,
      updatedAt: new Date(),
    })
    .where(eq(schema.customBundles.id, bundleId));
}

/** Extract a ZIP/TAR archive into the bundle's extracted/ dir. The archive
 *  itself was moved into place by the API's POST /uploads/:id/complete; this
 *  handler just unpacks it. Phase 2 will additionally invoke the bundle
 *  parser at the end of this function. */
export async function handleIngestZip(
  payload: BundleJobPayload,
  db: Database,
  bundleStorageRoot: string,
): Promise<void> {
  const bundle = await loadBundle(db, payload.bundleId);
  const dest = bundleExtractedDir(bundleStorageRoot, payload.userId, bundle.id);
  try {
    if (!bundle.archivePath || !bundle.archiveFormat) {
      throw new Error('zip-source bundle missing archivePath / archiveFormat');
    }
    const archiveRel = bundleArchiveRel(
      bundleStorageRoot,
      bundle.archivePath,
      payload.userId,
      bundle.id,
    );
    if (!archiveRel) throw new Error('bundle archive is not the file this bundle uploaded');
    const report = await extractArchive(
      { anchor: bundleStorageRoot, rel: archiveRel },
      bundle.archiveFormat as ArchiveFormat,
      { anchor: bundleStorageRoot, rel: `${bundleDirRel(payload.userId, bundle.id)}/extracted` },
      { keepLoneDir: isBundleRootDir },
    );
    if (report.note) {
      logger.warn({ bundleId: bundle.id, dropped: report.dropped }, report.note);
    }
    // Update storageRoot before parsing so the parser reads from the freshly
    // extracted tree.
    await db
      .update(schema.customBundles)
      .set({ storageRoot: dest, updatedAt: new Date() })
      .where(eq(schema.customBundles.id, bundle.id));
    const parsed = await parseBundle(bundle.id, db, logger, bundleStorageRoot);
    const counts = await persistBundleItems(db, bundle.id, parsed);
    await markIfItemsRemoved(db, bundle.repositoryId, counts.removed);
    await setBundleActive(db, bundle.id, {
      storageRoot: dest,
      lastSyncAt: new Date(),
      lastSyncError: null,
      // Written UNCONDITIONALLY — null when nothing was dropped — because the note describes the
      // tree THIS extraction produced. A re-upload that drops nothing would otherwise inherit the
      // previous run's report, and this write is what owns the column's whole lifecycle, so the
      // api's sync-start clears need no counterpart. `06_3-custom-bundles` surfaces it.
      lastSyncNote: report.note,
    });
    logger.info(
      {
        bundleId: bundle.id,
        dest,
        archivePath: bundle.archivePath,
        items: parsed.items.length,
        ambiguous: parsed.ambiguous.length,
        dropped: parsed.dropped.length,
        ...counts,
      },
      'Bundle zip ingest complete',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setBundleFailed(db, bundle.id, msg);
    throw err;
  }
}

/** Shallow-clone a git repo into the bundle's extracted/ dir, then capture
 *  the resolved HEAD as `last_sync_commit`. */
export async function handleIngestGit(
  payload: BundleJobPayload,
  db: Database,
  bundleStorageRoot: string,
): Promise<void> {
  const bundle = await loadBundle(db, payload.bundleId);
  const dest = bundleExtractedDir(bundleStorageRoot, payload.userId, bundle.id);
  const dirRel = bundleDirRel(payload.userId, bundle.id);
  let secret: string | null = null;

  try {
    if (!bundle.gitUrl) throw new Error('git-source bundle missing gitUrl');
    assertCloneUrl(bundle.gitUrl, 'bundle');
    const cloneUrl = redactGitUrl(bundle.gitUrl, true);
    const auth = bundle.gitCredentialsId
      ? await buildCredentialHelper(db, bundle.gitCredentialsId, payload.userId, cloneUrl)
      : undefined;
    secret = auth?.secret ?? null;
    await ensureDirNoFollow(bundleStorageRoot, dirRel, { mode: 0o755 });
    await removeNoFollow(bundleStorageRoot, `${dirRel}/extracted`, { recursive: true });

    await gitClone(cloneUrl, dest, bundle.gitBranch ?? undefined, auth);
    const head = await gitRevParseHead(dest);
    await db
      .update(schema.customBundles)
      .set({ storageRoot: dest, gitUrl: cloneUrl, updatedAt: new Date() })
      .where(eq(schema.customBundles.id, bundle.id));
    const parsed = await parseBundle(bundle.id, db, logger, bundleStorageRoot);
    const counts = await persistBundleItems(db, bundle.id, parsed);
    await markIfItemsRemoved(db, bundle.repositoryId, counts.removed);
    await setBundleActive(db, bundle.id, {
      storageRoot: dest,
      lastSyncAt: new Date(),
      lastSyncCommit: head,
      lastSyncError: null,
    });
    logger.info(
      {
        bundleId: bundle.id,
        dest,
        head,
        items: parsed.items.length,
        ambiguous: parsed.ambiguous.length,
        dropped: parsed.dropped.length,
        ...counts,
      },
      'Bundle git ingest complete',
    );
  } catch (err) {
    const msg = scrubSecret(err instanceof Error ? err.message : String(err), secret);
    await setBundleFailed(db, bundle.id, msg);
    if (msg !== (err instanceof Error ? err.message : String(err))) throw new Error(msg);
    throw err;
  }
}

/** Pull the latest from a previously-cloned git bundle. If the working tree
 *  is missing (e.g. volume wiped), falls back to a fresh clone. */
export async function handleResyncGit(
  payload: BundleJobPayload,
  db: Database,
  bundleStorageRoot: string,
): Promise<void> {
  const bundle = await loadBundle(db, payload.bundleId);
  const dest = bundleExtractedDir(bundleStorageRoot, payload.userId, bundle.id);

  try {
    if (!bundle.gitUrl) throw new Error('git-source bundle missing gitUrl');

    // Whether the working tree is really there — which is what this check has always MEANT, and
    // never did. It was `rm(<dest>/.git, { recursive: false })` read as a probe, and that cannot
    // answer correctly in either direction: for a real `.git` DIRECTORY `rm` rejects with EISDIR, so
    // `exists` was false and EVERY resync fell through to a full re-clone; for a `.git` GITFILE it
    // SUCCEEDED and deleted it, then fetched against the checkout it had just broken. The comment it
    // replaces ("rm above silently failed") recorded the symptom without naming the cause.
    //
    // An `lstat` answers the question the name asks, so a healthy clone now takes the FETCH path —
    // which is what this function's own contract says it does.
    const dirRel = bundleDirRel(payload.userId, bundle.id);
    const exists = (await lstatNoFollow(bundleStorageRoot, `${dirRel}/extracted/.git`)) !== null;
    if (!exists) {
      // Working tree missing — re-clone instead of pull; handleIngestGit owns the dir wipe.
      await handleIngestGit(payload, db, bundleStorageRoot);
      return;
    }

    await gitFetchAndCheckout(db, { ...bundle, storageRoot: dest });
    const head = await gitRevParseHead(dest);
    const parsed = await parseBundle(bundle.id, db, logger, bundleStorageRoot);
    const counts = await persistBundleItems(db, bundle.id, parsed);
    await markIfItemsRemoved(db, bundle.repositoryId, counts.removed);
    await setBundleActive(db, bundle.id, {
      lastSyncAt: new Date(),
      lastSyncCommit: head,
      lastSyncError: null,
    });
    logger.info(
      {
        bundleId: bundle.id,
        head,
        items: parsed.items.length,
        ambiguous: parsed.ambiguous.length,
        dropped: parsed.dropped.length,
        ...counts,
      },
      'Bundle git resync complete',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setBundleFailed(db, bundle.id, msg);
    throw err;
  }
}

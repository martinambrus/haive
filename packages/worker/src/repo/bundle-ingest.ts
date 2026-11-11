import { buildCredentialHelper, originGitRun, scrubSecret } from './git-push.js';
import { bundleGitAuth } from './bundle-git.js';
import { redactGitUrl } from '@haive/shared/schemas';
import path from 'node:path';
import { ensureDirNoFollow, lstatNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import {
  clearReplacementRecord,
  readReplacement,
  recordReplacementSwap,
  restoreReplacementBundle,
  restoreReplacementTree,
} from './bundle-recovery.js';
import { writeFileNoFollow } from '@haive/shared/fs-safe';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { logger, type ArchiveFormat, type BundleJobPayload } from '@haive/shared';
import { boundQueryError, safeErrorMessage, scrubErrorPaths } from '@haive/shared/logger';
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
  const res = await originGitRun(
    bundle.storageRoot,
    [...auth.argv, ...args],
    { db, userId: bundle.userId },
    auth.env,
  );
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
  // A redelivered job for a superseded upload must not touch the current source or catalog.
  if (payload.archivePath && payload.archivePath !== bundle.archivePath) return;
  const dest = bundleExtractedDir(bundleStorageRoot, payload.userId, bundle.id);
  const archiveRel = bundle.archivePath
    ? bundleArchiveRel(bundleStorageRoot, bundle.archivePath, payload.userId, bundle.id)
    : null;
  if (payload.archivePath && bundle.status === 'active') {
    if (archiveRel) await clearReplacementRecord(bundleStorageRoot, archiveRel);
    return;
  }
  const destRel = `${bundleDirRel(payload.userId, bundle.id)}/extracted`;
  let replacement = payload.replacement;
  let replacementRead = false;
  let published = false;
  try {
    if (!bundle.archivePath || !bundle.archiveFormat) {
      throw new Error('zip-source bundle missing archivePath or archiveFormat');
    }
    if (!archiveRel) throw new Error('bundle archive is not the file this bundle uploaded');
    replacement = (await readReplacement(bundleStorageRoot, archiveRel)) ?? replacement;
    replacementRead = true;
    if (
      replacement?.mode === 'keep_until_success' &&
      replacement.previousArchive &&
      replacement.recovery
    ) {
      if (!(await restoreReplacementTree(bundleStorageRoot, destRel, replacement))) {
        throw new Error(
          'The previous extracted tree is unavailable; automatic rollback cannot restore it.',
        );
      }
      // Retire the old attempt before starting another stage; a failed re-extract still has the
      // original tree, never the uncommitted tree left by the crashed pass.
      delete replacement.recovery;
      await writeFileNoFollow(
        bundleStorageRoot,
        `${archiveRel}.replacement.json`,
        JSON.stringify(replacement),
        { durable: true },
      );
    }
    let parsed!: Awaited<ReturnType<typeof parseBundle>>;
    let counts!: Awaited<ReturnType<typeof persistBundleItems>>;
    const report = await extractArchive(
      { anchor: bundleStorageRoot, rel: archiveRel },
      bundle.archiveFormat as ArchiveFormat,
      { anchor: bundleStorageRoot, rel: `${bundleDirRel(payload.userId, bundle.id)}/extracted` },
      {
        keepLoneDir: isBundleRootDir,
        beforeSwap:
          replacement?.mode === 'keep_until_success' && replacement.previousArchive
            ? (stageRel) =>
                recordReplacementSwap(
                  bundleStorageRoot,
                  archiveRel,
                  destRel,
                  stageRel,
                  replacement!,
                )
            : undefined,
        afterSwap: async (extraction) => {
          // All catalog writes roll back together, and extractArchive restores the tree if this
          // transaction fails. No pooled connection is held during archive extraction.
          await db.transaction(async (tx) => {
            const [owned] = await tx
              .update(schema.customBundles)
              .set({ storageRoot: dest, updatedAt: new Date() })
              .where(
                and(
                  eq(schema.customBundles.id, bundle.id),
                  bundle.archivePath
                    ? eq(schema.customBundles.archivePath, bundle.archivePath)
                    : undefined,
                ),
              )
              .returning({ id: schema.customBundles.id });
            if (!owned)
              throw new Error('The bundle source changed before its catalog could be saved.');
            const catalogDb = tx as unknown as Database;
            parsed = await parseBundle(bundle.id, catalogDb, logger, bundleStorageRoot);
            counts = await persistBundleItems(catalogDb, bundle.id, parsed);
            await markIfItemsRemoved(catalogDb, bundle.repositoryId, counts.removed);
            await setBundleActive(catalogDb, bundle.id, {
              storageRoot: dest,
              lastSyncAt: new Date(),
              lastSyncError: null,
              lastSyncNote: extraction.note,
              lastReplacementNote: null,
            });
          });
          published = true;
        },
      },
    );
    if (replacement) await clearReplacementRecord(bundleStorageRoot, archiveRel);
    if (report.note) {
      logger.warn({ bundleId: bundle.id, dropped: report.dropped }, report.note);
    }
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
    const msg = safeErrorMessage(err);
    const restored =
      !published && replacementRead && archiveRel && replacement
        ? await db.transaction(async (tx) => {
            const [current] = await tx
              .select()
              .from(schema.customBundles)
              .where(
                and(
                  eq(schema.customBundles.id, bundle.id),
                  eq(schema.customBundles.archivePath, bundle.archivePath!),
                  eq(schema.customBundles.status, 'syncing'),
                ),
              )
              .for('update');
            if (!current) return true; // A newer admission or completed catalog owns the tree.
            return restoreReplacementBundle(
              tx as unknown as Database,
              bundleStorageRoot,
              current,
              replacement!,
              scrubErrorPaths(msg),
            );
          })
        : false;
    if (restored && archiveRel && replacement) {
      const current = await loadBundle(db, bundle.id);
      if (
        current.status === 'active' &&
        current.archivePath === replacement.previousArchive?.archivePath
      )
        await clearReplacementRecord(bundleStorageRoot, archiveRel);
    }
    if (!restored) {
      await db
        .update(schema.customBundles)
        .set({
          status: 'failed',
          lastSyncError: scrubErrorPaths(msg),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.customBundles.id, bundle.id),
            bundle.archivePath
              ? eq(schema.customBundles.archivePath, bundle.archivePath)
              : undefined,
          ),
        );
    }
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

    await gitClone(cloneUrl, dest, bundle.gitBranch ?? undefined, auth, {
      db,
      userId: bundle.userId,
    });
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
    // Inspect the original error before textual redaction loses bound-query structure.
    const safeMessage = safeErrorMessage(err);
    const msg = boundQueryError(err) ? safeMessage : scrubSecret(safeMessage, secret);
    await setBundleFailed(db, bundle.id, msg);
    // Bound errors keep their structure for the queue's safe SQLSTATE/class logging.
    if (msg !== safeMessage) throw new Error(msg);
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
    const msg = safeErrorMessage(err);
    await setBundleFailed(db, bundle.id, msg);
    throw err;
  }
}

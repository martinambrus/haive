import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, type ArchiveFormat, type BundleJobPayload } from '@haive/shared';
import { parseBundle, persistBundleItems } from '../bundle-parser/index.js';
import { buildAuthenticatedUrl, extractArchive, gitClone } from './clone.js';
import { getDecryptedCredentials } from './credentials.js';

/** Resolves the per-bundle storage root inside the haive_bundles volume. The
 *  layout is `<root>/<userId>/<bundleId>/extracted/`. The archive (if any)
 *  sits next to it as `<root>/<userId>/<bundleId>/source.<ext>`. */
function bundleExtractedDir(bundleStorageRoot: string, userId: string, bundleId: string): string {
  return path.join(bundleStorageRoot, userId, bundleId, 'extracted');
}

export function gitRevParseHead(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['rev-parse', 'HEAD'], { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`git rev-parse failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

function gitFetchAndCheckout(cwd: string, branch?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['pull', '--ff-only'];
    if (branch) args.push('origin', branch);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
    };
    const proc = spawn('git', args, { cwd, env });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const msg = stderr.replace(/https?:\/\/[^@]+@/g, 'https://***@').trim();
      reject(new Error(`git pull failed (exit ${code}): ${msg}`));
    });
  });
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
  if (!bundle.archivePath || !bundle.archiveFormat) {
    throw new Error('zip-source bundle missing archivePath / archiveFormat');
  }
  const dest = bundleExtractedDir(bundleStorageRoot, payload.userId, bundle.id);
  try {
    await extractArchive(bundle.archivePath, bundle.archiveFormat as ArchiveFormat, dest);
    // Update storageRoot before parsing so the parser reads from the freshly
    // extracted tree.
    await db
      .update(schema.customBundles)
      .set({ storageRoot: dest, updatedAt: new Date() })
      .where(eq(schema.customBundles.id, bundle.id));
    const parsed = await parseBundle(bundle.id, db, logger);
    const counts = await persistBundleItems(db, bundle.id, parsed);
    await setBundleActive(db, bundle.id, {
      storageRoot: dest,
      lastSyncAt: new Date(),
      lastSyncError: null,
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
  if (!bundle.gitUrl) throw new Error('git-source bundle missing gitUrl');

  const dest = bundleExtractedDir(bundleStorageRoot, payload.userId, bundle.id);
  await mkdir(path.dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true });

  let cloneUrl = bundle.gitUrl;
  if (bundle.gitCredentialsId) {
    const creds = await getDecryptedCredentials(db, bundle.gitCredentialsId, payload.userId);
    cloneUrl = buildAuthenticatedUrl(bundle.gitUrl, creds.username, creds.secret);
  }

  try {
    await gitClone(cloneUrl, dest, bundle.gitBranch ?? undefined);
    const head = await gitRevParseHead(dest);
    await db
      .update(schema.customBundles)
      .set({ storageRoot: dest, updatedAt: new Date() })
      .where(eq(schema.customBundles.id, bundle.id));
    const parsed = await parseBundle(bundle.id, db, logger);
    const counts = await persistBundleItems(db, bundle.id, parsed);
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
    const msg = err instanceof Error ? err.message : String(err);
    await setBundleFailed(db, bundle.id, msg);
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
  if (!bundle.gitUrl) throw new Error('git-source bundle missing gitUrl');
  const dest = bundleExtractedDir(bundleStorageRoot, payload.userId, bundle.id);

  const exists = await rm(path.join(dest, '.git'), { recursive: false }).then(
    () => true,
    () => false,
  );
  if (!exists) {
    // Working tree missing — re-clone instead of pull. rm above silently failed
    // so dest may or may not exist; let handleIngestGit own the dir wipe.
    await handleIngestGit(payload, db, bundleStorageRoot);
    return;
  }

  try {
    await gitFetchAndCheckout(dest, bundle.gitBranch ?? undefined);
    const head = await gitRevParseHead(dest);
    const parsed = await parseBundle(bundle.id, db, logger);
    const counts = await persistBundleItems(db, bundle.id, parsed);
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

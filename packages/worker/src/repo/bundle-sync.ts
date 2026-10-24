import { originGitRun } from './git-push.js';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { gitRevParseHead } from './bundle-ingest.js';
import { gitRun } from './git-exec.js';

/** Read-only `git fetch` against the bundle's local clone. Does NOT update
 *  the working tree — the explicit upgrade task is the only path that pulls
 *  + re-parses, so the daily tick can run unattended without breaking
 *  anything. */
async function gitFetch(cwd: string, branch: string | null): Promise<void> {
  const args = ['fetch', '--quiet', 'origin'];
  if (branch) args.push(branch);
  const res = await originGitRun(cwd, args, { GIT_ASKPASS: 'echo' });
  if (res.code !== 0) {
    const msg = res.stderr.replace(/https?:\/\/[^@]+@/g, 'https://***@').trim();
    throw new Error(`git fetch failed (exit ${res.noExit ?? res.code}): ${msg}`);
  }
}

async function gitRevParse(cwd: string, ref: string): Promise<string> {
  const res = await gitRun(cwd, ['rev-parse', ref]);
  if (res.code !== 0) {
    throw new Error(
      `git rev-parse ${ref} failed (exit ${res.noExit ?? res.code}): ${res.stderr.trim()}`,
    );
  }
  return res.stdout.trim();
}

export interface BundleGitSyncTickResult {
  scanned: number;
  updated: number;
  errors: number;
}

/** Walk every active git bundle and refresh its remote-tracking ref. The
 *  destructive operations (pull + re-parse + items rewrite) only happen when
 *  the user explicitly runs an upgrade — see `00-bundle-resync` and
 *  `handleResyncGit`. This tick's job is to keep the local clone fresh
 *  enough that `git rev-parse origin/<branch>` reports the real upstream
 *  HEAD when the upgrade-status endpoint compares it against
 *  `last_sync_commit`. */
export async function runBundleGitSyncTick(db: Database): Promise<BundleGitSyncTickResult> {
  const bundles = await db
    .select({
      id: schema.customBundles.id,
      gitBranch: schema.customBundles.gitBranch,
      storageRoot: schema.customBundles.storageRoot,
      sourceType: schema.customBundles.sourceType,
      status: schema.customBundles.status,
      lastSyncCommit: schema.customBundles.lastSyncCommit,
    })
    .from(schema.customBundles);

  let scanned = 0;
  let updated = 0;
  let errors = 0;
  const log = logger.child({ module: 'bundle-git-sync' });
  for (const b of bundles) {
    if (b.sourceType !== 'git' || b.status !== 'active') continue;
    scanned += 1;
    try {
      await gitFetch(b.storageRoot, b.gitBranch ?? null);
      const remoteRef = b.gitBranch ? `origin/${b.gitBranch}` : 'origin/HEAD';
      const remoteHead = await gitRevParse(b.storageRoot, remoteRef);
      const localHead = await gitRevParseHead(b.storageRoot).catch(() => null);
      // We update `last_sync_commit` to point at whatever the local HEAD is
      // right now (NOT remote) — that is "the commit our parsed items were
      // built against". The upgrade-status drift check compares it against
      // `git rev-parse origin/<branch>` at request time, so writing the
      // local head here keeps the column meaningful without re-parsing.
      const newSyncCommit = localHead ?? b.lastSyncCommit;
      if (newSyncCommit && newSyncCommit !== b.lastSyncCommit) {
        await db
          .update(schema.customBundles)
          .set({ lastSyncCommit: newSyncCommit, updatedAt: new Date() })
          .where(eq(schema.customBundles.id, b.id));
        updated += 1;
      }
      log.debug(
        { bundleId: b.id, remoteHead, localHead, lastSyncCommit: b.lastSyncCommit },
        'bundle-git-sync: fetched',
      );
    } catch (err) {
      errors += 1;
      log.warn({ err, bundleId: b.id }, 'bundle-git-sync: fetch failed for bundle');
    }
  }
  log.info({ scanned, updated, errors }, 'bundle-git-sync tick complete');
  return { scanned, updated, errors };
}

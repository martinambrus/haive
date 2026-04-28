/**
 * Companion to reset-bundle-to-commit.ts. Pulls a git bundle's local clone
 * forward to the latest upstream commit and re-parses bundle_items there,
 * leaving onboarding_artifacts and on-disk files at whatever prior baseline
 * was previously written. The hash divergence between the (now newer)
 * bundle_items and the (still older) artifact rows is what makes the
 * upgrade-status banner show "Upgrade available", driving the rest of the
 * dev/test flow without fabricating an upgrade task by hand.
 *
 * Usage (run inside the worker container):
 *   tsx scripts/advance-bundle-items.ts <bundleId> [<commitOrBranch>]
 *
 * Default target = origin/<bundle.gitBranch>.
 */
import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { parseBundle, persistBundleItems } from '../src/bundle-parser/index.js';

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const proc = spawn('git', args, { cwd, env });
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
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function main() {
  const bundleId = process.argv[2];
  const targetArg = process.argv[3] ?? null;
  if (!bundleId) {
    throw new Error('usage: advance-bundle-items.ts <bundleId> [<commitOrBranch>]');
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  const db: Database = createDatabase(dbUrl);
  const log = logger.child({ script: 'advance-bundle-items', bundleId });

  const bundle = await db.query.customBundles.findFirst({
    where: eq(schema.customBundles.id, bundleId),
  });
  if (!bundle) throw new Error(`bundle ${bundleId} not found`);
  if (bundle.sourceType !== 'git') throw new Error('only git-sourced bundles supported');

  const target = targetArg ?? `origin/${bundle.gitBranch ?? 'main'}`;

  log.info({ target }, 'fetch + reset to target');
  await runGit(bundle.storageRoot, ['fetch', '--all']);
  await runGit(bundle.storageRoot, ['reset', '--hard', target]);
  const localHead = await runGit(bundle.storageRoot, ['rev-parse', 'HEAD']);
  log.info({ localHead }, 'local clone advanced');

  log.info('re-parse + persist bundle_items at new HEAD');
  const parsed = await parseBundle(bundleId, db, log);
  const counts = await persistBundleItems(db, bundleId, parsed);
  log.info({ counts, ambiguous: parsed.ambiguous.length }, 'persisted bundle items');

  log.info('update last_sync_commit');
  await db
    .update(schema.customBundles)
    .set({ lastSyncCommit: localHead, updatedAt: new Date() })
    .where(eq(schema.customBundles.id, bundleId));

  log.info('done');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

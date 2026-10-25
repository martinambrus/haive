/**
 * One-shot dev/test helper. Reverts a git-sourced custom bundle to a specific
 * commit AND realigns its dependent state (custom_bundle_items, live
 * onboarding_artifacts rows, on-disk files) so an upgrade run from this state
 * to the upstream HEAD will surface real drift.
 *
 * Steps:
 *   1. `git fetch + reset --hard <commit>` in the bundle's storageRoot.
 *   2. parseBundle + persistBundleItems → custom_bundle_items reflect <commit>.
 *   3. Supersede live onboarding_artifacts rows tied to this bundle.
 *   4. Re-render via expandCustomBundlesFor and INSERT new artifact rows for
 *      each item × target, mirroring what 12-post-onboarding would do.
 *   5. Write the rendered content to disk inside the repo storage path.
 *   6. Set custom_bundles.last_sync_commit = <commit>.
 *
 * After this, the bundle/local clone/last_sync_commit/artifacts/disk are all
 * consistent at <commit>; the upstream remote has moved on, so the next
 * upgrade-task surfaces hasUpstreamChange and the plan classifies items per
 * the cf3a7365 → upstream diff.
 *
 * Usage (run inside the worker container):
 *   tsx scripts/reset-bundle-to-commit.ts <bundleId> <commitSha>
 */
import { pathToFileURL } from 'node:url';
import { writeFileNoFollow } from '@haive/shared/fs-safe';
import { and, eq, isNull, like } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';
import { getHaiveVersion, logger } from '@haive/shared';
import { parseBundle, persistBundleItems } from '../src/bundle-parser/index.js';
import { gitRun } from '../src/repo/git-exec.js';
import { originGitRun } from '../src/repo/git-push.js';
import {
  expandCustomBundlesFor,
  type ExpandedRendering,
  type TemplateRenderContext,
} from '../src/step-engine/template-manifest.js';
import { loadBundlesForExpansion } from '../src/step-engine/_custom-bundle-loader.js';
import { resolveSkillTargetDirs } from '../src/step-engine/steps/onboarding/_helpers.js';

export async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await gitRun(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function writeRenderedBundleFile(
  repoStoragePath: string,
  diskPath: string,
  content: string,
) {
  await writeFileNoFollow(repoStoragePath, diskPath, content, { createParents: true });
}

async function main() {
  const bundleId = process.argv[2];
  const commitSha = process.argv[3];
  if (!bundleId || !commitSha) {
    throw new Error('usage: reset-bundle-to-commit.ts <bundleId> <commitSha>');
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  const db: Database = createDatabase(dbUrl);
  const log = logger.child({ script: 'reset-bundle-to-commit', bundleId, commitSha });

  const bundle = await db.query.customBundles.findFirst({
    where: eq(schema.customBundles.id, bundleId),
  });
  if (!bundle) throw new Error(`bundle ${bundleId} not found`);
  if (bundle.sourceType !== 'git') throw new Error('only git-sourced bundles supported here');
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, bundle.repositoryId),
  });
  if (!repo) throw new Error(`repository ${bundle.repositoryId} not found`);
  if (!repo.storagePath) throw new Error('repository has no storagePath');
  const repoStoragePath: string = repo.storagePath;

  log.info('step 1: git reset --hard');
  const fetched = await originGitRun(bundle.storageRoot, ['fetch', 'origin']);
  if (fetched.code !== 0) {
    throw new Error(`git fetch origin failed (exit ${fetched.code}): ${fetched.stderr.trim()}`);
  }
  await runGit(bundle.storageRoot, ['reset', '--hard', commitSha]);
  const localHead = await runGit(bundle.storageRoot, ['rev-parse', 'HEAD']);
  log.info({ localHead }, 'local clone reset');

  log.info('step 2: re-parse + persist bundle_items');
  const parsed = await parseBundle(
    bundleId,
    db,
    log,
    process.env.BUNDLE_STORAGE_ROOT ?? '/var/lib/haive/bundles',
  );
  const counts = await persistBundleItems(db, bundleId, parsed);
  log.info({ counts, ambiguous: parsed.ambiguous.length }, 'persisted bundle items');

  log.info('step 3: supersede live artifacts for this bundle');
  const now = new Date();
  await db
    .update(schema.onboardingArtifacts)
    .set({ supersededAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, bundle.repositoryId),
        like(schema.onboardingArtifacts.templateId, `custom.${bundleId}.%`),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    );

  log.info('step 4: load renderCtx from latest live artifact snapshot');
  const liveWithSnapshot = await db
    .select({ snap: schema.onboardingArtifacts.formValuesSnapshot })
    .from(schema.onboardingArtifacts)
    .where(eq(schema.onboardingArtifacts.repositoryId, bundle.repositoryId))
    .limit(1);
  const renderCtx = (liveWithSnapshot[0]?.snap ?? null) as TemplateRenderContext | null;
  if (!renderCtx) throw new Error('no formValuesSnapshot available on any artifact row');

  log.info('step 5: expand bundle and write artifact rows + disk files');
  const bundles = await loadBundlesForExpansion(db, bundle.repositoryId, log);
  const skillTargets = await resolveSkillTargetDirs(db, bundle.userId);
  const onlyThisBundle = bundles.filter((b) => b.id === bundleId);
  const expanded: ExpandedRendering[] = expandCustomBundlesFor(
    onlyThisBundle,
    renderCtx.agentTargets,
    skillTargets,
  );

  // Pick a fake taskId from the latest task on this repo, since artifact rows
  // require a non-null taskId. Falls back to the bundle's most recent
  // onboarding task.
  const latestTask = await db.query.tasks.findFirst({
    where: and(
      eq(schema.tasks.repositoryId, bundle.repositoryId),
      eq(schema.tasks.userId, bundle.userId),
      eq(schema.tasks.status, 'completed'),
    ),
    orderBy: (t, { desc }) => desc(t.completedAt),
  });
  if (!latestTask) throw new Error('no completed task on this repo to attribute rows to');

  const rowsToInsert: (typeof schema.onboardingArtifacts.$inferInsert)[] = [];
  const haiveVersion = getHaiveVersion();
  for (const r of expanded) {
    await writeRenderedBundleFile(repoStoragePath, r.diskPath, r.content);

    const itemId = r.templateId.split('.').slice(2).join('.');
    rowsToInsert.push({
      userId: bundle.userId,
      repositoryId: bundle.repositoryId,
      taskId: latestTask.id,
      diskPath: r.diskPath,
      templateId: r.templateId,
      templateKind: r.templateKind,
      templateSchemaVersion: r.templateSchemaVersion,
      templateContentHash: r.templateContentHash,
      writtenHash: r.writtenHash,
      writtenContent: r.content,
      lastObservedDiskHash: r.writtenHash,
      userModified: false,
      formValuesSnapshot: renderCtx as unknown as Record<string, unknown>,
      sourceStepId: 'reset-bundle-to-commit',
      source: 'onboarding' as const,
      haiveVersion,
      bundleItemId: itemId,
    });
  }
  if (rowsToInsert.length > 0) {
    await db.insert(schema.onboardingArtifacts).values(rowsToInsert);
  }
  log.info({ inserted: rowsToInsert.length }, 'inserted artifact rows + wrote disk files');

  log.info('step 6: update last_sync_commit');
  await db
    .update(schema.customBundles)
    .set({ lastSyncCommit: commitSha, updatedAt: now })
    .where(eq(schema.customBundles.id, bundleId));

  log.info('done');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

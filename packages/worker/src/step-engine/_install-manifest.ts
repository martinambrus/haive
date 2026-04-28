import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import { getHaiveVersion, normalizeContent, type InstallManifest } from '@haive/shared';
import type { StepContext } from './step-definition.js';
import { loadBundlesForExpansion } from './_custom-bundle-loader.js';

/** Rewrite `.haive/install.json` from the live `onboarding_artifacts` rows for
 *  a repo. Used by 02-upgrade-apply (post-upgrade) and by 04-upgrade-rollback
 *  (post-rollback) so the on-disk install manifest is always in sync with the
 *  DB. Also folds in the active custom bundles via the bundles section so a
 *  consumer can see at-a-glance which bundles contributed items. */
export async function writeInstallManifestFromLiveRows(
  ctx: StepContext,
  repositoryId: string,
  currentSetHash: string,
): Promise<boolean> {
  const liveRows = await ctx.db
    .select({
      diskPath: schema.onboardingArtifacts.diskPath,
      templateId: schema.onboardingArtifacts.templateId,
      templateSchemaVersion: schema.onboardingArtifacts.templateSchemaVersion,
      templateContentHash: schema.onboardingArtifacts.templateContentHash,
    })
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, repositoryId),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    );

  const byTemplate = new Map<
    string,
    { id: string; schemaVersion: number; contentHash: string; diskPaths: string[] }
  >();
  for (const r of liveRows) {
    const existing = byTemplate.get(r.templateId);
    if (existing) {
      existing.diskPaths.push(r.diskPath);
      continue;
    }
    byTemplate.set(r.templateId, {
      id: r.templateId,
      schemaVersion: r.templateSchemaVersion,
      contentHash: r.templateContentHash,
      diskPaths: [r.diskPath],
    });
  }

  const bundles = await loadBundlesForExpansion(ctx.db, repositoryId, ctx.logger);

  const installManifest: InstallManifest = {
    schemaVersion: 1,
    haiveVersion: getHaiveVersion(),
    appliedAt: new Date().toISOString(),
    lastTaskId: ctx.taskId,
    templateSetHash: currentSetHash,
    templates: Array.from(byTemplate.values())
      .map((t) => ({ ...t, diskPaths: t.diskPaths.slice().sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    ...(bundles.length > 0
      ? {
          bundles: bundles
            .map((b) => ({
              id: b.id,
              name: b.name,
              sourceType: b.sourceType,
              lastSyncCommit: b.lastSyncCommit,
              itemCount: b.items.length,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        }
      : {}),
  };

  const installDir = path.join(ctx.repoPath, '.haive');
  const installPath = path.join(installDir, 'install.json');
  await mkdir(installDir, { recursive: true });
  const content = normalizeContent(`${JSON.stringify(installManifest, null, 2)}\n`);
  await writeFile(installPath, content, 'utf8');
  ctx.logger.info(
    {
      installPath: '.haive/install.json',
      templateCount: byTemplate.size,
      bundleCount: bundles.length,
    },
    'install-manifest: wrote install.json from live artifact rows',
  );
  return true;
}

import { Hono } from 'hono';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  TASK_JOB_NAMES,
  computeSetHash,
  getHaiveVersion,
  type TaskJobPayload,
  type UpgradeStatusResponse,
  type RollbackUpgradeResponse,
} from '@haive/shared';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { getTaskQueue } from '../queues.js';

export const upgradeRoutes = new Hono<AppEnv>();

upgradeRoutes.use('*', requireAuth);

/**
 * Report whether an upgrade is available for a repository by comparing the
 * installed artifact fingerprints against the worker-synced manifest cache.
 */
upgradeRoutes.get('/:id/upgrade-status', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: { id: true, applicableTemplateIds: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  const manifestCache = await db
    .select({
      templateId: schema.templateManifestCache.templateId,
      schemaVersion: schema.templateManifestCache.schemaVersion,
      contentHash: schema.templateManifestCache.contentHash,
      setHash: schema.templateManifestCache.setHash,
    })
    .from(schema.templateManifestCache);

  // Custom-bundle items live per-repo (not in the global manifest cache), so
  // they're loaded directly and folded into the current set. Each item
  // contributes one template entry of the form `custom.<bundleId>.<itemId>`,
  // mirroring the templateId scheme that 12-post-onboarding / 02-upgrade-
  // apply write into onboarding_artifacts.
  const bundleItems = await db
    .select({
      itemId: schema.customBundleItems.id,
      bundleId: schema.customBundleItems.bundleId,
      schemaVersion: schema.customBundleItems.schemaVersion,
      contentHash: schema.customBundleItems.contentHash,
    })
    .from(schema.customBundleItems)
    .innerJoin(schema.customBundles, eq(schema.customBundleItems.bundleId, schema.customBundles.id))
    .where(eq(schema.customBundles.repositoryId, repositoryId));
  const customCurrent = bundleItems.map((b) => ({
    templateId: `custom.${b.bundleId}.${b.itemId}`,
    schemaVersion: b.schemaVersion,
    contentHash: b.contentHash,
  }));

  const liveArtifacts = await db
    .select({
      templateId: schema.onboardingArtifacts.templateId,
      templateSchemaVersion: schema.onboardingArtifacts.templateSchemaVersion,
      templateContentHash: schema.onboardingArtifacts.templateContentHash,
      bundleItemId: schema.onboardingArtifacts.bundleItemId,
      haiveVersion: schema.onboardingArtifacts.haiveVersion,
      generatedAt: schema.onboardingArtifacts.generatedAt,
    })
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, repositoryId),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    );

  // Pick the most recently-written version stamp among live rows. Rows
  // written before migration 0011 have null haive_version — return null in
  // that case so the banner shows a "pre-tracking" line instead of a stale
  // placeholder.
  let installedHaiveVersion: string | null = null;
  let installedHaiveVersionAt = 0;
  for (const row of liveArtifacts) {
    if (!row.haiveVersion) continue;
    const ts = row.generatedAt?.getTime() ?? 0;
    if (ts >= installedHaiveVersionAt) {
      installedHaiveVersion = row.haiveVersion;
      installedHaiveVersionAt = ts;
    }
  }
  const currentHaiveVersion = getHaiveVersion();

  // "Has a prior upgrade we could roll back to" — true iff at least one live
  // onboarding_artifacts row was written by a completed upgrade (source =
  // 'upgrade'). After a rollback, those upgrade rows are superseded and the
  // new live rows have source = 'rollback', so this flips back to false —
  // matching the user expectation that the rollback button disappears once
  // there's nothing left to revert.
  const liveUpgradeRow = await db
    .select({ id: schema.onboardingArtifacts.id })
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, repositoryId),
        eq(schema.onboardingArtifacts.source, 'upgrade'),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    )
    .limit(1);
  const hasPriorUpgrade = liveUpgradeRow.length > 0;

  // "Upgrade in progress" iff there is a non-terminal onboarding-upgrade task
  // for this repo. The earlier heuristic (`hasPriorUpgrade && hasUpgradeAvailable`)
  // mis-flagged completed tasks whose drift was deliberately left unapplied
  // by the user as still-running sessions.
  const inProgressUpgradeTask = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.type, 'onboarding_upgrade'),
        inArray(schema.tasks.status, ['created', 'queued', 'running', 'paused', 'waiting_user']),
      ),
    )
    .limit(1);
  const hasInProgressUpgradeTask = inProgressUpgradeTask.length > 0;

  // "Installed" hash is computed the same way as `currentSetHash` but uses the
  // distinct set of (templateId, schemaVersion, contentHash) tuples present
  // on live artifact rows — multiple rows can reference the same template
  // (e.g. agent template rendered once per CLI).
  //
  // Dangling custom artifacts are excluded: when the source bundle item was
  // deleted in a re-parse (cascade-SET-NULL leaves bundle_item_id null) and
  // no live bundle item now matches the templateId, the row is user-owned —
  // the user explicitly kept it after a prior upgrade flagged it obsolete.
  // Including it in the drift comparison would make the banner perpetually
  // say "Upgrade available" with the same orphaned items.
  const liveCustomItemIds = new Set(customCurrent.map((c) => c.templateId));
  const distinctInstalled = new Map<
    string,
    {
      id: string;
      schemaVersion: number;
      contentHash: string;
    }
  >();
  for (const a of liveArtifacts) {
    if (
      a.templateId.startsWith('custom.') &&
      a.bundleItemId === null &&
      !liveCustomItemIds.has(a.templateId)
    ) {
      continue;
    }
    if (!distinctInstalled.has(a.templateId)) {
      distinctInstalled.set(a.templateId, {
        id: a.templateId,
        schemaVersion: a.templateSchemaVersion,
        contentHash: a.templateContentHash,
      });
    }
  }

  // Restrict comparisons to templates that are actually applicable to this
  // repo's gating context (e.g. drupal LSP plugins skip when php-extended
  // not selected). Worker writes `repositories.applicableTemplateIds` on
  // every apply. Fallback for legacy repos without that snapshot: use the
  // installed set itself, which means new-since-last-apply templates won't
  // be flagged in the banner — user must run a manual upgrade to discover
  // them, at which point the snapshot is populated and future banner runs
  // see them correctly.
  const applicableSet = new Set<string>(
    repo.applicableTemplateIds ?? Array.from(distinctInstalled.keys()),
  );

  interface CurrentTemplate {
    templateId: string;
    schemaVersion: number;
    contentHash: string;
  }
  const currentByTemplate = new Map<string, CurrentTemplate>(
    manifestCache
      .filter((m) => applicableSet.has(m.templateId))
      .map((m) => [
        m.templateId,
        { templateId: m.templateId, schemaVersion: m.schemaVersion, contentHash: m.contentHash },
      ]),
  );
  // Custom items are always considered applicable to the repo that owns them
  // (their bundle is bound to this repo by FK) — so they go in regardless of
  // the applicable_template_ids snapshot. This also lets brand-new bundle
  // items surface as drift even before the next onboarding/upgrade has had a
  // chance to refresh the snapshot.
  for (const c of customCurrent) {
    currentByTemplate.set(c.templateId, c);
  }
  const filteredInstalled = new Map(
    Array.from(distinctInstalled.entries()).filter(
      ([id]) => applicableSet.has(id) || id.startsWith('custom.'),
    ),
  );

  const installedTemplateSetHash =
    filteredInstalled.size > 0 ? computeSetHash(Array.from(filteredInstalled.values())) : null;
  const currentSetHash =
    currentByTemplate.size > 0
      ? computeSetHash(
          Array.from(currentByTemplate.values()).map((m) => ({
            id: m.templateId,
            schemaVersion: m.schemaVersion,
            contentHash: m.contentHash,
          })),
        )
      : '';

  // Per-template comparison: which template IDs differ between installed
  // and current manifest? Used by the UI banner.
  const changedTemplateIds: string[] = [];
  for (const [id, installed] of filteredInstalled.entries()) {
    const current = currentByTemplate.get(id);
    if (!current) {
      changedTemplateIds.push(id);
      continue;
    }
    if (
      current.contentHash !== installed.contentHash ||
      current.schemaVersion !== installed.schemaVersion
    ) {
      changedTemplateIds.push(id);
    }
  }
  for (const id of currentByTemplate.keys()) {
    if (!filteredInstalled.has(id) && !changedTemplateIds.includes(id)) {
      changedTemplateIds.push(id);
    }
  }

  const isOnboarded = distinctInstalled.size > 0;
  if (!isOnboarded) {
    const priorOnboarding = await db.query.tasks.findFirst({
      where: and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.userId, userId),
        eq(schema.tasks.type, 'onboarding'),
        eq(schema.tasks.status, 'completed'),
      ),
      columns: { id: true },
    });
    if (!priorOnboarding) {
      const res: UpgradeStatusResponse = {
        repositoryId,
        hasUpgradeAvailable: false,
        installedTemplateSetHash: null,
        currentTemplateSetHash: currentSetHash,
        changedTemplateIds: [],
        isOnboarded: false,
        installedHaiveVersion: null,
        currentHaiveVersion,
        hasInProgressUpgradeSession: false,
        hasPriorUpgrade: false,
      };
      return c.json(res);
    }
  }

  const hasUpgradeAvailable =
    installedTemplateSetHash !== currentSetHash && changedTemplateIds.length > 0;

  // Group `custom.<bundleId>.*` changes by bundle so the banner can render
  // "Bundle X: N changed items" alongside Haive template counts. Bundles with
  // zero changed items are omitted.
  const customChangedByBundle = new Map<string, number>();
  for (const id of changedTemplateIds) {
    if (!id.startsWith('custom.')) continue;
    const parts = id.split('.');
    const bundleId = parts[1];
    if (!bundleId) continue;
    customChangedByBundle.set(bundleId, (customChangedByBundle.get(bundleId) ?? 0) + 1);
  }
  const customChanges =
    customChangedByBundle.size > 0
      ? await Promise.all(
          Array.from(customChangedByBundle.entries()).map(async ([bundleId, count]) => {
            const bundle = await db
              .select({ name: schema.customBundles.name })
              .from(schema.customBundles)
              .where(eq(schema.customBundles.id, bundleId))
              .limit(1);
            return {
              bundleId,
              bundleName: bundle[0]?.name ?? bundleId,
              changedItemCount: count,
            };
          }),
        )
      : [];

  const res: UpgradeStatusResponse = {
    repositoryId,
    hasUpgradeAvailable,
    installedTemplateSetHash,
    currentTemplateSetHash: currentSetHash,
    changedTemplateIds,
    isOnboarded: true,
    installedHaiveVersion,
    currentHaiveVersion,
    hasInProgressUpgradeSession: hasInProgressUpgradeTask,
    hasPriorUpgrade,
    ...(customChanges.length > 0 ? { customChanges } : {}),
  };
  return c.json(res);
});

/**
 * Create a rollback task. The worker's upgrade-rollback step detects
 * `metadata.mode === 'rollback'` and reverts the most recent completed
 * onboarding_upgrade task for this repository.
 */
upgradeRoutes.post('/:id/rollback-upgrade', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: { id: true, name: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  const priorUpgrade = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.userId, userId),
        eq(schema.tasks.type, 'onboarding_upgrade'),
        eq(schema.tasks.status, 'completed'),
      ),
    )
    .orderBy(desc(schema.tasks.completedAt))
    .limit(1);
  if (priorUpgrade.length === 0) {
    throw new HttpError(409, 'No completed upgrade task to roll back');
  }

  const inserted = await db
    .insert(schema.tasks)
    .values({
      userId,
      type: 'onboarding_upgrade',
      title: `Rollback upgrade: ${repo.name}`,
      description: 'Revert the most recent onboarding upgrade for this repository.',
      repositoryId,
      metadata: { mode: 'rollback', rolledBackFromTaskId: priorUpgrade[0]!.id },
      status: 'created',
    })
    .returning();
  const task = inserted[0];
  if (!task) throw new HttpError(500, 'Failed to create rollback task');

  const queue = getTaskQueue();
  const payload: TaskJobPayload = { taskId: task.id, userId };
  await queue.add(TASK_JOB_NAMES.START, payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  const res: RollbackUpgradeResponse = { taskId: task.id };
  return c.json(res, 201);
});

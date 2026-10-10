import { Hono } from 'hono';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type DbTx } from '@haive/database';
import {
  agentSpecSchema,
  buildCliRulesBlockFromProviders,
  bundleAgentTemplateHash,
  CLI_RULES_SCHEMA_VERSION,
  CLI_RULES_TEMPLATE_ID,
  computeSetHash,
  getHaiveVersion,
  holdsRtkSettings,
  normalizeContent,
  RTK_SETTINGS_FILES,
  rtkSettingsNeeded,
  sha256Hex,
  skillEntrySchema,
  type UpgradeStatusResponse,
  type RollbackUpgradeResponse,
} from '@haive/shared';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import {
  historyOrigin,
  readRenderContextColumn,
  renderContextOrigin,
  renderContextProviderNames,
  type RenderContextOrigin,
  type SnapshotRowFacts,
} from '@haive/shared/project-state';
import {
  importRulesFilesFor,
  readUpgradeFile,
  removableClaim,
  rtkBlockFiles,
  rulesImportState,
} from '@haive/shared/rules-files';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import {
  LIVE_TASK_STATUSES,
  renderContextAdmitsUpgrade,
  upgradeAdmission,
} from '../lib/onboarding-state.js';
import { enqueueStart, markQueuedForStart } from '../lib/task-start.js';

export const upgradeRoutes = new Hono<AppEnv>();

upgradeRoutes.use('*', requireAuth);

/** Per-repo templates are tracked like Haive templates but live outside the
 *  global manifest cache, so their "current" hash is computed per repo rather
 *  than read from template_manifest_cache: custom bundle items and the
 *  AGENTS.md cli-rules region. */
function isPerRepoTemplateId(id: string): boolean {
  return id.startsWith('custom.') || id === CLI_RULES_TEMPLATE_ID;
}

/** The providers' import-mode rules files that do not import AGENTS.md, and those that link
 *  elsewhere, which no upgrade writes through. Null when the root is not a readable directory,
 *  since that says nothing about the files in it. */
export async function rulesImportGaps(
  root: string | null,
  providerNames: readonly string[],
): Promise<{ missing: string[]; linked: string[] } | null> {
  if (!root) return null;
  try {
    if ((await lstatNoFollow(root, '', { strict: true }))?.kind !== 'directory') return null;
  } catch {
    return null;
  }
  const missing: string[] = [];
  const linked: string[] = [];
  for (const file of importRulesFilesFor(providerNames)) {
    const state = await rulesImportState(root, file);
    if (state === 'missing') missing.push(file);
    else if (state === 'linked-elsewhere') linked.push(file);
  }
  return { missing, linked };
}

/** The providers a snapshot's `enabledCliProviders` names. */
function snapshotProviderNames(providers: unknown): string[] {
  if (!Array.isArray(providers)) return [];
  return providers.flatMap((p: unknown) => {
    const name = (p as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? [name] : [];
  });
}

/** The providers whose RTK settings files 01's render context reads, or null when it recorded no
 *  RTK choice: the column's own, else the caller's enabled ones, or the picked snapshot's. */
function rtkProviderNames(
  origin: RenderContextOrigin<SnapshotRowFacts & { snapshotProviders: unknown }>,
  enabledNames: readonly string[],
): string[] | null {
  if (origin.from === 'column') {
    return origin.rtkRecorded ? renderContextProviderNames(origin.column, enabledNames) : null;
  }
  return origin.from === 'snapshot' && origin.rtkRecorded
    ? snapshotProviderNames(origin.row.snapshotProviders)
    : null;
}

/** Whether 01's render context follows the repository's RTK switch, which it does only when the
 *  context it renders from recorded a choice: the column's stored flag, else the newest live
 *  snapshot, else the 07 detect output of the last completed onboarding, else, for a blank
 *  repository, the scaffold's own. */
async function rtkChoiceFollowsLive(
  db: ReturnType<typeof getDb>,
  repositoryId: string,
  origin: RenderContextOrigin<SnapshotRowFacts>,
  source: string,
): Promise<boolean> {
  if (origin.from !== 'history') return origin.rtkRecorded;
  const [onboarding] = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.type, 'onboarding'),
        eq(schema.tasks.status, 'completed'),
      ),
    )
    .orderBy(desc(schema.tasks.completedAt))
    .limit(1);
  if (!onboarding) return historyOrigin({ onboarding: null, source }).kind === 'blank';
  const [generate] = await db
    .select({
      recorded: sql<boolean | null>`(${schema.taskSteps.detectOutput} -> 'rtkEnabled') is not null`,
    })
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, onboarding.id),
        eq(schema.taskSteps.stepId, '07-generate-files'),
      ),
    )
    .limit(1);
  const history = historyOrigin({
    onboarding: { detected: generate !== undefined, rtkRecorded: generate?.recorded === true },
    source,
  });
  return history.kind === 'onboarding' && history.rtkRecorded;
}

/** The RTK settings files no live row records that still hold RTK's render or hook, which 01 offers
 *  for removal once RTK is off. A link, and a file that cannot be read whole, claim nothing, as there. */
async function rtkSettingsLeftovers(
  root: string,
  recorded: ReadonlySet<string>,
): Promise<string[]> {
  const found: string[] = [];
  for (const file of RTK_SETTINGS_FILES) {
    if (recorded.has(file.diskPath)) continue;
    const read = await readUpgradeFile(root, file.diskPath);
    if (read.kind === 'text' && holdsRtkSettings(file.templateId, read.text)) {
      found.push(file.diskPath);
    }
  }
  return found;
}

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
    columns: {
      id: true,
      applicableTemplateIds: true,
      storagePath: true,
      localPath: true,
      rtkEnabled: true,
      source: true,
      renderContext: true,
      status: true,
      onboardedAt: true,
      onboardingResetAt: true,
    },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  const manifestCache = await db
    .select({
      templateId: schema.templateManifestCache.templateId,
      templateKind: schema.templateManifestCache.templateKind,
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
      kind: schema.customBundleItems.kind,
      schemaVersion: schema.customBundleItems.schemaVersion,
      contentHash: schema.customBundleItems.contentHash,
      normalizedSpec: schema.customBundleItems.normalizedSpec,
    })
    .from(schema.customBundleItems)
    .innerJoin(schema.customBundles, eq(schema.customBundleItems.bundleId, schema.customBundles.id))
    .where(eq(schema.customBundles.repositoryId, repositoryId));
  // 01 skips an item whose spec fails the schema its loader parses it with, so no rendering is current.
  const customCurrent = bundleItems
    .filter(
      (b) =>
        (b.kind === 'agent' ? agentSpecSchema : skillEntrySchema).safeParse(b.normalizedSpec)
          .success,
    )
    .map((b) => ({
      templateId: `custom.${b.bundleId}.${b.itemId}`,
      schemaVersion: b.schemaVersion,
      // The hash the worker records on an agent's artifact rows (expandCustomBundlesFor).
      contentHash: b.kind === 'agent' ? bundleAgentTemplateHash(b.contentHash) : b.contentHash,
    }));

  // The AGENTS.md cli-rules region is per-repo content (the repo owner's merged
  // provider rules), so it is not in the global manifest cache. Recompute its
  // current hash here via the shared pure helper — byte-identical to what the
  // worker writes/records — so a rules change surfaces as drift. Providers are
  // sorted by name to match the deterministic onboarding/plan ordering.
  const ruleProviderRows = await db
    .select({
      name: schema.cliProviders.name,
      rulesContent: schema.cliProviders.rulesContent,
      enabled: schema.cliProviders.enabled,
    })
    .from(schema.cliProviders)
    .where(eq(schema.cliProviders.userId, userId));
  const cliRulesBlock = buildCliRulesBlockFromProviders(ruleProviderRows);
  const cliRulesCurrent = cliRulesBlock
    ? {
        templateId: CLI_RULES_TEMPLATE_ID,
        schemaVersion: CLI_RULES_SCHEMA_VERSION,
        contentHash: sha256Hex(normalizeContent(cliRulesBlock)),
      }
    : null;

  const liveArtifacts = await db
    .select({
      id: schema.onboardingArtifacts.id,
      diskPath: schema.onboardingArtifacts.diskPath,
      templateId: schema.onboardingArtifacts.templateId,
      templateSchemaVersion: schema.onboardingArtifacts.templateSchemaVersion,
      templateContentHash: schema.onboardingArtifacts.templateContentHash,
      writtenHash: schema.onboardingArtifacts.writtenHash,
      bundleItemId: schema.onboardingArtifacts.bundleItemId,
      haiveVersion: schema.onboardingArtifacts.haiveVersion,
      generatedAt: schema.onboardingArtifacts.generatedAt,
      hasSnapshot: sql<
        boolean | null
      >`jsonb_typeof(${schema.onboardingArtifacts.formValuesSnapshot}) = 'object'`,
      rtkRecorded: sql<
        boolean | null
      >`jsonb_typeof(${schema.onboardingArtifacts.formValuesSnapshot} -> 'rtkEnabled') = 'boolean'`,
      snapshotProviders: sql<unknown>`${schema.onboardingArtifacts.formValuesSnapshot} -> 'enabledCliProviders'`,
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
  const hasPriorUpgrade =
    (await latestUpgradeToRollBack(db, repositoryId)) !== null &&
    (liveUpgradeRow.length > 0 || (await lastUpgradeRemovedContent(db, repositoryId)));

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
        inArray(schema.tasks.status, [...LIVE_TASK_STATUSES]),
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
  const liveCustomItemIds = new Set(bundleItems.map((b) => `custom.${b.bundleId}.${b.itemId}`));
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

  // The set is what the render context renders, written by every apply and by a sync that changes the
  // column. A NULL set (legacy) reads as the installed one until an upgrade fills it.
  const applicableSet = new Set<string>(
    repo.applicableTemplateIds ?? Array.from(distinctInstalled.keys()),
  );
  const origin = renderContextOrigin({
    column: readRenderContextColumn(repo.renderContext),
    rows: liveArtifacts,
  });
  const enabledNames = ruleProviderRows.filter((p) => p.enabled).map((p) => p.name);
  // An upgrade run with RTK off left the RTK templates out of that snapshot, so with RTK back on they
  // apply again wherever the providers of the render context the upgrade uses read them.
  const rtkProviders = repo.rtkEnabled ? rtkProviderNames(origin, enabledNames) : null;
  if (rtkProviders) {
    for (const m of manifestCache) {
      if (m.templateKind === 'rtk-config' && rtkSettingsNeeded(m.templateId, rtkProviders)) {
        applicableSet.add(m.templateId);
      }
    }
  }

  interface CurrentTemplate {
    templateId: string;
    schemaVersion: number;
    contentHash: string;
  }
  // With RTK switched off no RTK settings file is current, so the ones installed read as changed.
  const currentByTemplate = new Map<string, CurrentTemplate>(
    manifestCache
      .filter(
        (m) =>
          applicableSet.has(m.templateId) && (repo.rtkEnabled || m.templateKind !== 'rtk-config'),
      )
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
  if (cliRulesCurrent) {
    currentByTemplate.set(cliRulesCurrent.templateId, cliRulesCurrent);
  }
  // A claim the set does not hold has no current entry, so it reads as changed while 02 could remove it.
  const root = repo.storagePath ?? repo.localPath;
  const outsideRemovable = new Set<string>();
  if (root) {
    for (const a of liveArtifacts) {
      const id = a.templateId;
      if (applicableSet.has(id) || isPerRepoTemplateId(id) || outsideRemovable.has(id)) continue;
      if (removableClaim(await readUpgradeFile(root, a.diskPath), a)) outsideRemovable.add(id);
    }
  }
  const filteredInstalled = new Map(
    Array.from(distinctInstalled.entries()).filter(
      ([id]) => applicableSet.has(id) || isPerRepoTemplateId(id) || outsideRemovable.has(id),
    ),
  );
  // One row stands for every rendering of a template, so a rendering that is not current (a
  // skipped conflict, a restored edit) has to be the one that stands, or its siblings hide it.
  for (const a of liveArtifacts) {
    const current = currentByTemplate.get(a.templateId);
    if (!current || !filteredInstalled.has(a.templateId)) continue;
    if (
      a.templateContentHash !== current.contentHash ||
      a.templateSchemaVersion !== current.schemaVersion
    ) {
      filteredInstalled.set(a.templateId, {
        id: a.templateId,
        schemaVersion: a.templateSchemaVersion,
        contentHash: a.templateContentHash,
      });
    }
  }

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

  const admission = await upgradeAdmission(db, userId, repo);
  let admitted = admission.admitted;
  let firstUpgradeOnThisInstall = false;
  if (admitted && distinctInstalled.size === 0) {
    const priorOnboarding = await db.query.tasks.findFirst({
      where: and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.userId, userId),
        eq(schema.tasks.type, 'onboarding'),
        eq(schema.tasks.status, 'completed'),
      ),
      columns: { id: true },
    });
    // The banner is the only place an upgrade starts, so a clone only its column admits is offered
    // one until a row records it, whatever became of an upgrade that recorded nothing.
    firstUpgradeOnThisInstall =
      !priorOnboarding && (await renderContextAdmitsUpgrade(db, userId, repo));
  }
  if (!admission.admitted && admission.reason === 'none') {
    // POST /tasks starts an upgrade only on an onboarded repository, so one any upgrade ran on is one.
    const [anyUpgrade] = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.repositoryId, repositoryId),
          eq(schema.tasks.userId, userId),
          eq(schema.tasks.type, 'onboarding_upgrade'),
        ),
      )
      .limit(1);
    admitted = anyUpgrade !== undefined;
  }
  if (!admitted) {
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

  // An upgrade restores a missing import (02-upgrade-apply), so the banner offers one for it too.
  const rulesImports = await rulesImportGaps(repo.storagePath ?? repo.localPath, enabledNames);
  const missingRulesImports = rulesImports?.missing ?? [];
  const linkedRulesFiles = rulesImports?.linked ?? [];
  // An upgrade also takes out the RTK block (02-upgrade-apply) once RTK is switched off.
  const rtkBlockLeftovers = !repo.rtkEnabled && root ? await rtkBlockFiles(root) : [];
  // No row records the RTK settings files a blank scaffold seeds, so no template comparison sees them.
  const rtkSettingsLeft =
    !repo.rtkEnabled &&
    root &&
    (repo.source === 'blank' || liveArtifacts.length === 0) &&
    (await rtkChoiceFollowsLive(db, repositoryId, origin, repo.source))
      ? await rtkSettingsLeftovers(root, new Set(liveArtifacts.map((a) => a.diskPath)))
      : [];

  const hasUpgradeAvailable =
    firstUpgradeOnThisInstall ||
    (installedTemplateSetHash !== currentSetHash && changedTemplateIds.length > 0) ||
    missingRulesImports.length > 0 ||
    rtkBlockLeftovers.length > 0 ||
    rtkSettingsLeft.length > 0;

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
    inProgressUpgradeTaskId: inProgressUpgradeTask[0]?.id ?? null,
    ...(customChanges.length > 0 ? { customChanges } : {}),
    ...(missingRulesImports.length > 0 ? { missingRulesImports } : {}),
    ...(linkedRulesFiles.length > 0 ? { linkedRulesFiles } : {}),
    ...(rtkBlockLeftovers.length > 0 ? { rtkBlockLeftovers } : {}),
    ...(rtkSettingsLeft.length > 0 ? { rtkSettingsLeftovers: rtkSettingsLeft } : {}),
    ...(firstUpgradeOnThisInstall ? { firstUpgradeOnThisInstall } : {}),
  };
  return c.json(res);
});

/** The upgrade a rollback would undo now: the most recent completed one, unless that was itself a
 *  rollback. The rollback step reverts the newest completed upgrade, so one started after a rollback
 *  would undo the same upgrade a second time. */
export async function latestUpgradeToRollBack(
  db: ReturnType<typeof getDb> | DbTx,
  repositoryId: string,
): Promise<string | null> {
  const [latest] = await db
    .select({ id: schema.tasks.id, metadata: schema.tasks.metadata })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.type, 'onboarding_upgrade'),
        eq(schema.tasks.status, 'completed'),
      ),
    )
    .orderBy(desc(schema.tasks.completedAt))
    .limit(1);
  if (!latest || (latest.metadata as { mode?: unknown } | null)?.mode === 'rollback') return null;
  return latest.id;
}

/** Refuse with 409, naming the live task, while an upgrade or rollback of the repository runs. */
export async function refuseBesideLiveUpgrade(
  db: ReturnType<typeof getDb> | DbTx,
  repositoryId: string,
): Promise<void> {
  const [live] = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.type, 'onboarding_upgrade'),
        inArray(schema.tasks.status, [...LIVE_TASK_STATUSES]),
      ),
    )
    .limit(1);
  if (live) {
    throw new HttpError(
      409,
      `An upgrade or rollback is already in progress for this repository (task ${live.id})`,
    );
  }
}

/** Insert an upgrade or a rollback task only while no other one of the repository is live, since two
 *  running side by side apply and revert the same files. Serialised per repository, so two clicks
 *  cannot both pass the check. */
export async function insertUpgradeTask<T>(
  db: ReturnType<typeof getDb>,
  repositoryId: string,
  insert: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`onboarding-upgrade:${repositoryId}`}, 0))`,
    );
    await refuseBesideLiveUpgrade(tx, repositoryId);
    return insert(tx);
  });
}

/** Whether the upgrade a rollback would undo removed a file, a rules region or an RTK block, or
 *  untracked a row: none leaves a live row, so nothing else could offer that rollback. */
export async function lastUpgradeRemovedContent(
  db: ReturnType<typeof getDb>,
  repositoryId: string,
): Promise<boolean> {
  const latest = await latestUpgradeToRollBack(db, repositoryId);
  if (!latest) return false;
  const [applied] = await db
    .select({ output: schema.taskSteps.output })
    .from(schema.taskSteps)
    .where(
      and(eq(schema.taskSteps.taskId, latest), eq(schema.taskSteps.stepId, '02-upgrade-apply')),
    )
    .limit(1);
  const output = applied?.output as {
    removedPaths?: unknown;
    rtkBlockStrips?: unknown;
    untrackedRowIds?: unknown;
  } | null;
  return [output?.removedPaths, output?.rtkBlockStrips, output?.untrackedRowIds].some(
    (l) => Array.isArray(l) && l.length > 0,
  );
}

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

  const { task, queued } = await insertUpgradeTask(db, repositoryId, async (tx) => {
    const priorUpgrade = await latestUpgradeToRollBack(tx, repositoryId);
    if (!priorUpgrade) {
      throw new HttpError(
        409,
        'No completed upgrade to roll back: none has completed, or the last one was rolled back',
      );
    }
    const [row] = await tx
      .insert(schema.tasks)
      .values({
        userId,
        type: 'onboarding_upgrade',
        title: `Rollback upgrade: ${repo.name}`,
        description: 'Revert the most recent onboarding upgrade for this repository.',
        repositoryId,
        metadata: { mode: 'rollback', rolledBackFromTaskId: priorUpgrade },
        status: 'created',
      })
      .returning();
    if (!row) throw new HttpError(500, 'Failed to create rollback task');
    // Queued with the insert: a `created` rollback left behind would block the next one.
    return { task: row, queued: await markQueuedForStart(tx, row.id) };
  });

  if (queued) await enqueueStart(task.id, userId);

  const res: RollbackUpgradeResponse = { taskId: task.id };
  return c.json(res, 201);
});

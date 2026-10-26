import {
  decodeUtf8Strict,
  errno,
  isPathContainmentError,
  ParkedFileError,
  rewriteFileIfNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { lockRepositoryTasksKey, schema } from '@haive/database';
import { safeErrorMessage } from '@haive/shared/logger';
import {
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  extractRegion,
  getHaiveVersion,
  normalizeContent,
  sha256Hex,
  upsertRegion,
} from '@haive/shared';
import { ledgerImportedSince } from '@haive/shared/onboarding-admission';
import {
  deriveRenderTargets,
  readRenderContextColumn,
  completeRecordedCliMembership,
  recoverCliMembership,
  isImportMarker,
  isRenderContextSnapshot,
  isRtkChoiceRecorded,
  namesGitData,
  PROJECT_STATE_IMPORT_STEP_ID,
} from '@haive/shared/project-state';
import { readUpgradeFile, RTK_BLOCK_FILES, RULES_FILE_READ_CAP } from '@haive/shared/rules-files';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import {
  expandManifestFor,
  getTemplateManifest,
  updateApplicableTemplateIds,
  type TemplateRenderContext,
} from '../../template-manifest.js';
import { extractBundleItemId } from '../../_custom-bundle-loader.js';
import { retireInstallManifest } from '../../_retire-install-manifest.js';
import { resolveRenderContext, unionExpandedFor } from '../../_upgrade-render.js';
import {
  failIfColumnStale,
  lockProjectState,
  refuseMovedColumn,
  refuseReleasedCheckout,
  writeProjectStateRecord,
} from '../../../project-state/write.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import {
  restoreRtkBlocks,
  RTK_BLOCK_HOME,
  RTK_BLOCK_RECORD,
  RTK_BLOCK_RESTORE_RECORD,
  takeOutRestoredRtkBlock,
} from '../onboarding/_rules-files.js';
import {
  loadLiveArtifacts,
  pickRenderSnapshot,
  type UpgradePlanOutput,
} from './01-upgrade-plan.js';
import {
  removeIfHaives,
  resolveBundleItemId,
  safeDiskRel,
  type RtkBlockStrip,
  type UpgradeApplyOutput,
} from './02-upgrade-apply.js';

export class UpgradeRollbackImportedError extends Error {
  constructor() {
    super(
      "upgrade-rollback: files were updated from another install's record since that upgrade, so it can no longer be rolled back",
    );
    this.name = 'UpgradeRollbackImportedError';
  }
}

function isRollback(ctx: StepContext): Promise<boolean> {
  return ctx.db
    .select({ metadata: schema.tasks.metadata })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, ctx.taskId))
    .limit(1)
    .then((rows) => {
      const meta = rows[0]?.metadata ?? null;
      return (
        meta !== null &&
        typeof meta === 'object' &&
        (meta as { mode?: unknown }).mode === 'rollback'
      );
    });
}

export async function shouldRunRollback(ctx: StepContext): Promise<boolean> {
  return isRollback(ctx);
}

export async function shouldRunUpgrade(ctx: StepContext): Promise<boolean> {
  return !(await isRollback(ctx));
}

interface RollbackTarget {
  diskPath: string;
  templateId: string;
  templateKind: string;
  templateSchemaVersion: number;
  priorArtifactId: string;
  /** Null where the upgrade removed what stood here and wrote nothing of its own. */
  upgradeArtifactId: string | null;
  /** The upgrade removed what stood here, so it goes back only where nothing stands now. */
  removed?: boolean;
  priorTemplateContentHash: string;
  priorWrittenHash: string;
  /** Stored content of the prior baseline row. Null on legacy rows written
   *  before migration 0013 — rollback falls back to re-rendering at current
   *  code in that case (best-effort, may drift). */
  priorWrittenContent: string | null;
  priorFormValuesSnapshot: Record<string, unknown> | null;
}

/** A new_artifact entry from the prior upgrade — file did not exist before
 *  the upgrade, so rolling back means deleting it from disk and superseding
 *  the live row. There is no baseline to restore. */
interface NewArtifactToUndo {
  diskPath: string;
  templateKind: string;
  upgradeArtifactId: string;
  /** What the upgrade wrote. Absent on a payload detected before it was recorded, which then
   *  deletes nothing. */
  writtenHash?: string;
  /** Whether the file itself was missing, where the upgrade recorded it. */
  fileCreated?: boolean;
  /** The live row the upgrade retired where nothing stood, put back live. */
  retiredRowId?: string;
}

interface RollbackDetect {
  repositoryId: string;
  rolledBackFromTaskId: string;
  targets: RollbackTarget[];
  newArtifactsToUndo: NewArtifactToUndo[];
  /** Paths the upgrade rewrote with the bytes standing there, which no row recorded: only its row
   *  is retired. Absent from a payload detected before the upgrade recorded its writes. */
  unrecordedRewrites?: { diskPath: string; upgradeArtifactId: string }[];
  warnings: string[];
  /** Rules files the upgrade took an RTK block out of. Absent from a payload detected before the
   *  upgrade recorded them. */
  rtkBlockStrips?: RtkBlockStrip[];
  /** Rules files the upgrade put the RTK block back into. Absent likewise. */
  rtkBlockRestores?: RtkBlockStrip[];
  /** Rows the upgrade untracked, each put back live where no live row stands at its path. Absent
   *  from a payload detected before the upgrade recorded them. */
  untrackedRowIds?: string[];
}

interface RollbackOutput extends RollbackDetect {
  revertedCount: number;
  /** What the project state record write did; 'failed' when it threw. Optional because it is read
   *  back from a persisted output that may predate it. */
  recordWrite?: 'written' | 'failed' | 'skipped';
}

interface RollbackRendering {
  content: string;
  writtenHash: string;
  templateContentHash: string;
  templateSchemaVersion: number;
  templateId: string;
  templateKind: string;
}

interface RollbackRestorePlan {
  content: string;
  writtenHash: string;
  templateContentHash: string;
  schemaVersion: number;
  templateId: string;
  templateKind: string;
}

/** Decide how to restore one rollback target. Prefers the prior row's stored
 *  bytes (migration 0013) — that is the exact file that was on disk, so it is a
 *  correct revert EVEN across a template schema_version bump. Only the legacy
 *  re-render fallback (no stored content) is blocked by a schema_version
 *  mismatch, because re-rendering a changed-shape template cannot reproduce the
 *  prior file. Pure so this branch selection — which has regressed before by
 *  letting the schema guard short-circuit the stored-content path — stays
 *  unit-tested. */
export function resolveRollbackRestore(
  target: RollbackTarget,
  rendering: RollbackRendering | undefined,
): { plan: RollbackRestorePlan; warning?: string } | { skip: string } {
  if (target.priorWrittenContent !== null) {
    return {
      plan: {
        content: target.priorWrittenContent,
        writtenHash: target.priorWrittenHash,
        templateContentHash: target.priorTemplateContentHash,
        schemaVersion: target.templateSchemaVersion,
        templateId: target.templateId,
        templateKind: target.templateKind,
      },
    };
  }
  if (rendering) {
    if (rendering.templateSchemaVersion !== target.templateSchemaVersion) {
      return {
        skip: `schema_version mismatch for ${target.diskPath} (prior=${target.templateSchemaVersion}, current=${rendering.templateSchemaVersion}) and no stored baseline content; skipping`,
      };
    }
    const plan: RollbackRestorePlan = {
      content: rendering.content,
      writtenHash: rendering.writtenHash,
      templateContentHash: rendering.templateContentHash,
      schemaVersion: rendering.templateSchemaVersion,
      templateId: rendering.templateId,
      templateKind: rendering.templateKind,
    };
    if (rendering.templateContentHash !== target.priorTemplateContentHash) {
      return {
        plan,
        warning: `content drifted for ${target.diskPath}; legacy row has no stored baseline content, restored from current code (best-effort)`,
      };
    }
    return { plan };
  }
  return {
    skip: `cannot restore ${target.diskPath}: no stored content and template ${target.templateId} no longer in manifest`,
  };
}

async function requireRepositoryId(ctx: StepContext): Promise<string> {
  const row = await ctx.db
    .select({ repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, ctx.taskId))
    .limit(1);
  const repoId = row[0]?.repositoryId ?? null;
  if (!repoId) throw new Error('upgrade-rollback: task has no repository_id');
  return repoId;
}

export const upgradeRollbackStep: StepDefinition<RollbackDetect, RollbackOutput> = {
  metadata: {
    id: '04-upgrade-rollback',
    workflowType: 'onboarding_upgrade',
    index: 4,
    title: 'Roll back upgrade',
    description: 'Reverts the most recent onboarding upgrade.',
    requiresCli: false,
  },

  async shouldRun(ctx) {
    return shouldRunRollback(ctx);
  },

  async detect(ctx): Promise<RollbackDetect> {
    const repositoryId = await requireRepositoryId(ctx);
    const warnings: string[] = [];

    // Find the most recent completed upgrade task (not this rollback one,
    // and not any prior rollback task — rollback tasks share the
    // `onboarding_upgrade` type and are distinguished only by
    // `metadata.mode='rollback'`. Without this filter, repeated rollback
    // clicks chain rollback→rollback and find no live rows to revert).
    const priorUpgrade = await ctx.db
      .select({ id: schema.tasks.id, completedAt: schema.tasks.completedAt })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.repositoryId, repositoryId),
          eq(schema.tasks.type, 'onboarding_upgrade'),
          eq(schema.tasks.status, 'completed'),
          ne(schema.tasks.id, ctx.taskId),
          sql`coalesce(${schema.tasks.metadata}->>'mode', '') <> 'rollback'`,
        ),
      )
      .orderBy(desc(schema.tasks.completedAt))
      .limit(1);
    const priorTaskId = priorUpgrade[0]?.id ?? null;
    const priorCompletedAt = priorUpgrade[0]?.completedAt ?? null;
    if (!priorTaskId) {
      throw new Error('upgrade-rollback: no prior completed onboarding_upgrade task to revert');
    }
    if (priorCompletedAt && (await ledgerImportedSince(ctx.db, repositoryId, priorCompletedAt))) {
      throw new UpgradeRollbackImportedError();
    }

    // Live rows that prior upgrade task WROTE. Its backfill rows record what was already there,
    // and read as files the upgrade introduced they would be deleted.
    const upgradeRows = await ctx.db
      .select({
        id: schema.onboardingArtifacts.id,
        diskPath: schema.onboardingArtifacts.diskPath,
        templateId: schema.onboardingArtifacts.templateId,
        templateKind: schema.onboardingArtifacts.templateKind,
        writtenHash: schema.onboardingArtifacts.writtenHash,
      })
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, repositoryId),
          eq(schema.onboardingArtifacts.taskId, priorTaskId),
          eq(schema.onboardingArtifacts.source, 'upgrade'),
          isNull(schema.onboardingArtifacts.supersededAt),
        ),
      );

    // 02 records where nothing stood and which rows it retired. A payload from before that record
    // falls back to the most recently superseded row at a path, and to deleting where there is none.
    const applied = (await loadPreviousStepOutput(ctx.db, priorTaskId, '02-upgrade-apply'))
      ?.output as
      | Pick<
          UpgradeApplyOutput,
          | 'createdPaths'
          | 'retiredRowIds'
          | 'removedPaths'
          | 'rtkBlockStrips'
          | 'rtkBlockRestores'
          | 'untrackedRowIds'
        >
      | null
      | undefined;
    const createdByPath =
      applied?.createdPaths && applied.retiredRowIds
        ? new Map(applied.createdPaths.map((c) => [c.diskPath, c]))
        : null;
    const retiredRowIds = createdByPath ? (applied?.retiredRowIds ?? []) : null;

    /** The newest row the upgrade retired at `diskPath`: 02 retires a live row and the record of
     *  what stood there in one instant, and the record, written later, wins. */
    const newestRetiredRow = async (diskPath: string, except?: string) => {
      const [row] = await ctx.db
        .select({
          id: schema.onboardingArtifacts.id,
          templateId: schema.onboardingArtifacts.templateId,
          templateKind: schema.onboardingArtifacts.templateKind,
          templateSchemaVersion: schema.onboardingArtifacts.templateSchemaVersion,
          templateContentHash: schema.onboardingArtifacts.templateContentHash,
          writtenHash: schema.onboardingArtifacts.writtenHash,
          writtenContent: schema.onboardingArtifacts.writtenContent,
          formValuesSnapshot: schema.onboardingArtifacts.formValuesSnapshot,
        })
        .from(schema.onboardingArtifacts)
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, repositoryId),
            eq(schema.onboardingArtifacts.diskPath, diskPath),
            except ? ne(schema.onboardingArtifacts.id, except) : undefined,
            retiredRowIds ? inArray(schema.onboardingArtifacts.id, retiredRowIds) : undefined,
            // Without that record, a row retired after the upgrade completed is a later task's.
            !retiredRowIds && priorCompletedAt
              ? or(
                  isNull(schema.onboardingArtifacts.supersededAt),
                  lte(schema.onboardingArtifacts.supersededAt, priorCompletedAt),
                )
              : undefined,
          ),
        )
        .orderBy(
          desc(schema.onboardingArtifacts.supersededAt),
          desc(schema.onboardingArtifacts.generatedAt),
        )
        .limit(1);
      return row;
    };
    const fromPrior = (prior: NonNullable<Awaited<ReturnType<typeof newestRetiredRow>>>) => ({
      templateId: prior.templateId,
      templateSchemaVersion: prior.templateSchemaVersion,
      priorArtifactId: prior.id,
      priorTemplateContentHash: prior.templateContentHash,
      priorWrittenHash: prior.writtenHash,
      priorWrittenContent: prior.writtenContent ?? null,
      priorFormValuesSnapshot: (prior.formValuesSnapshot ?? null) as Record<string, unknown> | null,
    });

    const targets: RollbackTarget[] = [];
    const newArtifactsToUndo: NewArtifactToUndo[] = [];
    const unrecordedRewrites: { diskPath: string; upgradeArtifactId: string }[] = [];
    for (const upgradeRow of upgradeRows) {
      const created = createdByPath?.get(upgradeRow.diskPath);
      if (created) {
        newArtifactsToUndo.push({
          diskPath: upgradeRow.diskPath,
          templateKind: upgradeRow.templateKind,
          upgradeArtifactId: upgradeRow.id,
          writtenHash: upgradeRow.writtenHash,
          fileCreated: created.fileCreated,
          retiredRowId: created.retiredRowId ?? undefined,
        });
        continue;
      }
      const prior = await newestRetiredRow(upgradeRow.diskPath, upgradeRow.id);
      if (!prior && createdByPath) {
        // Something stood there that no row recorded, and 02 records one for any bytes but its own.
        unrecordedRewrites.push({
          diskPath: upgradeRow.diskPath,
          upgradeArtifactId: upgradeRow.id,
        });
        continue;
      }
      if (!prior) {
        newArtifactsToUndo.push({
          diskPath: upgradeRow.diskPath,
          templateKind: upgradeRow.templateKind,
          upgradeArtifactId: upgradeRow.id,
          writtenHash: upgradeRow.writtenHash,
        });
        continue;
      }
      targets.push({
        ...fromPrior(prior),
        diskPath: upgradeRow.diskPath,
        templateKind: upgradeRow.templateKind,
        upgradeArtifactId: upgradeRow.id,
      });
    }
    // A path the upgrade removed has no row of its own: what it held is the baseline 02 kept there.
    for (const diskPath of retiredRowIds ? (applied?.removedPaths ?? []) : []) {
      if (upgradeRows.some((r) => r.diskPath === diskPath)) continue;
      const prior = await newestRetiredRow(diskPath);
      if (!prior) {
        warnings.push(`cannot restore ${diskPath}: no row records what the upgrade removed`);
        continue;
      }
      targets.push({
        ...fromPrior(prior),
        diskPath,
        templateKind: prior.templateKind,
        upgradeArtifactId: null,
        removed: true,
      });
    }
    const rtkBlockStrips = (applied?.rtkBlockStrips ?? []).filter((s) =>
      RTK_BLOCK_FILES.includes(s.file),
    );
    const rtkBlockRestores = (applied?.rtkBlockRestores ?? []).filter(
      (s) => s.file === RTK_BLOCK_HOME,
    );
    const untrackedRowIds = applied?.untrackedRowIds ?? [];
    if (
      targets.length === 0 &&
      newArtifactsToUndo.length === 0 &&
      unrecordedRewrites.length === 0 &&
      rtkBlockStrips.length === 0 &&
      rtkBlockRestores.length === 0 &&
      untrackedRowIds.length === 0
    ) {
      warnings.push(
        'no live rows or recorded removals attributable to the prior upgrade task; nothing to revert',
      );
    }

    return {
      repositoryId,
      rolledBackFromTaskId: priorTaskId,
      targets,
      newArtifactsToUndo,
      unrecordedRewrites,
      warnings,
      rtkBlockStrips,
      rtkBlockRestores,
      untrackedRowIds,
    };
  },

  async apply(ctx, args): Promise<RollbackOutput> {
    const detected = args.detected;
    const [columnBefore] = await ctx.db
      .select({ renderContext: schema.repositories.renderContext })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, detected.repositoryId));
    const expectedColumns = [columnBefore?.renderContext ?? null];
    const warnings = [...detected.warnings];
    const manifest = getTemplateManifest();
    let revertedCount = 0;

    // Re-render using whichever snapshot the prior baseline carried, else the repository's own context.
    const snapshot =
      detected.targets
        .map((t) => t.priorFormValuesSnapshot)
        .find((s) => isRenderContextSnapshot(s)) ?? null;
    let renderCtx = snapshot as unknown as TemplateRenderContext | null;
    if (!renderCtx && detected.targets.length > 0) {
      renderCtx =
        (
          await resolveRenderContext(ctx.db, {
            repositoryId: detected.repositoryId,
            userId: ctx.userId,
            liveRows: await loadLiveArtifacts(ctx.db, detected.repositoryId),
            logger: ctx.logger,
          })
        )?.renderCtx ?? null;
      if (!renderCtx) {
        throw new Error(
          'upgrade-rollback apply: no form_values_snapshot available on any prior baseline row',
        );
      }
    }
    const expanded = renderCtx ? expandManifestFor(renderCtx, manifest) : [];
    const byTemplateAndPath = new Map<string, (typeof expanded)[number]>();
    for (const r of expanded) {
      byTemplateAndPath.set(`${r.templateId}:${r.diskPath}`, r);
    }

    const rowsToInsert: (typeof schema.onboardingArtifacts.$inferInsert)[] = [];
    const upgradeRowIds: string[] = [];
    const haiveVersion = getHaiveVersion();

    // The prior row's templateId may reference a bundle item that has since
    // been deleted (e.g. user replaced the ZIP). bundleItemId is FK-enforced,
    // so we resolve all candidate ids against custom_bundle_items first and
    // only set the linkage for items that still exist.
    const putBackIds = detected.newArtifactsToUndo.flatMap((u) =>
      u.retiredRowId ? [u.retiredRowId] : [],
    );
    const retiredRows =
      putBackIds.length > 0
        ? await ctx.db
            .select()
            .from(schema.onboardingArtifacts)
            .where(inArray(schema.onboardingArtifacts.id, putBackIds))
        : [];
    const untrackedIds = detected.untrackedRowIds ?? [];
    const untrackedRows =
      untrackedIds.length > 0
        ? await ctx.db
            .select()
            .from(schema.onboardingArtifacts)
            .where(
              and(
                inArray(schema.onboardingArtifacts.id, untrackedIds),
                eq(schema.onboardingArtifacts.repositoryId, detected.repositoryId),
                isNotNull(schema.onboardingArtifacts.supersededAt),
              ),
            )
        : [];
    const candidateBundleItemIds = new Set<string>();
    for (const templateId of [
      ...detected.targets.map((t) => t.templateId),
      ...retiredRows.map((r) => r.templateId),
      ...untrackedRows.map((r) => r.templateId),
    ]) {
      const id = extractBundleItemId(templateId);
      if (id) candidateBundleItemIds.add(id);
    }
    const liveBundleItemIds = new Set<string>();
    if (candidateBundleItemIds.size > 0) {
      const found = await ctx.db
        .select({ id: schema.customBundleItems.id })
        .from(schema.customBundleItems)
        .where(inArray(schema.customBundleItems.id, Array.from(candidateBundleItemIds)));
      for (const row of found) liveBundleItemIds.add(row.id);
    }

    const restoredRow = (
      row: typeof schema.onboardingArtifacts.$inferSelect,
    ): typeof schema.onboardingArtifacts.$inferInsert => ({
      userId: ctx.userId,
      repositoryId: detected.repositoryId,
      diskPath: row.diskPath,
      templateId: row.templateId,
      templateKind: row.templateKind,
      templateSchemaVersion: row.templateSchemaVersion,
      templateContentHash: row.templateContentHash,
      writtenHash: row.writtenHash,
      writtenContent: row.writtenContent,
      lastObservedDiskHash: row.lastObservedDiskHash,
      userModified: row.userModified,
      formValuesSnapshot: row.formValuesSnapshot,
      bundleItemId: resolveBundleItemId(row.templateId, liveBundleItemIds),
      ...(isImportMarker(row)
        ? {
            taskId: null,
            sourceStepId: PROJECT_STATE_IMPORT_STEP_ID,
            source: 'backfill' as const,
            importedAt: row.importedAt,
            haiveVersion: row.haiveVersion,
          }
        : {
            taskId: ctx.taskId,
            sourceStepId: '04-upgrade-rollback',
            source: 'rollback' as const,
            haiveVersion,
          }),
    });

    // What each upgrade row left at its path: the bytes a rollback may replace, and no others.
    const judgedIds = detected.targets.flatMap((t) =>
      t.upgradeArtifactId && !t.removed ? [t.upgradeArtifactId] : [],
    );
    const leftByRow = new Map<string, string>();
    if (judgedIds.length > 0) {
      for (const r of await ctx.db
        .select({
          id: schema.onboardingArtifacts.id,
          writtenHash: schema.onboardingArtifacts.writtenHash,
          lastObservedDiskHash: schema.onboardingArtifacts.lastObservedDiskHash,
        })
        .from(schema.onboardingArtifacts)
        .where(inArray(schema.onboardingArtifacts.id, judgedIds))) {
        leftByRow.set(r.id, r.lastObservedDiskHash ?? r.writtenHash);
      }
    }

    // What the rollback did to the block, in the record kind 02 writes for the same act, so the
    // newest record of the file stays Haive's last action on it.
    const recordRtkBlockAction = (
      templateKind: string,
      file: string,
      held: string,
      left: string,
    ) => {
      const heldHash = sha256Hex(normalizeContent(held));
      const now = new Date();
      return ctx.db.insert(schema.onboardingArtifacts).values({
        userId: ctx.userId,
        repositoryId: detected.repositoryId,
        taskId: ctx.taskId,
        diskPath: file,
        templateId: templateKind,
        templateKind,
        templateSchemaVersion: 1,
        templateContentHash: heldHash,
        writtenHash: heldHash,
        writtenContent: held,
        lastObservedDiskHash: sha256Hex(normalizeContent(left)),
        sourceStepId: '04-upgrade-rollback',
        source: 'backfill',
        haiveVersion,
        supersededAt: now,
        updatedAt: now,
      });
    };

    // Once per rollback task and file, whether this pass or an earlier attempt moved the block, and a
    // failure fails the step: a rollback that moved the block without a record misleads the offer.
    const ensureRtkBlockAction = async (
      templateKind: string,
      file: string,
      held: string,
      left: string,
    ) => {
      const [existing] = await ctx.db
        .select({ id: schema.onboardingArtifacts.id })
        .from(schema.onboardingArtifacts)
        .where(
          and(
            eq(schema.onboardingArtifacts.taskId, ctx.taskId),
            eq(schema.onboardingArtifacts.templateKind, templateKind),
            eq(schema.onboardingArtifacts.diskPath, file),
          ),
        )
        .limit(1);
      if (!existing) await recordRtkBlockAction(templateKind, file, held, left);
    };

    // Ahead of the rules region, while a file nobody touched since still holds what the strip left.
    const strips = detected.rtkBlockStrips ?? [];
    const loadRtkRecords = (recordIds: string[], templateKind: string) =>
      recordIds.length === 0
        ? []
        : ctx.db
            .select({
              id: schema.onboardingArtifacts.id,
              diskPath: schema.onboardingArtifacts.diskPath,
              writtenContent: schema.onboardingArtifacts.writtenContent,
              lastObservedDiskHash: schema.onboardingArtifacts.lastObservedDiskHash,
            })
            .from(schema.onboardingArtifacts)
            .where(
              and(
                inArray(schema.onboardingArtifacts.id, recordIds),
                eq(schema.onboardingArtifacts.repositoryId, detected.repositoryId),
                eq(schema.onboardingArtifacts.templateKind, templateKind),
              ),
            );
    const stripRecords = await loadRtkRecords(
      strips.map((s) => s.recordId),
      RTK_BLOCK_RECORD,
    );
    for (const strip of strips) {
      const record = stripRecords.find((r) => r.id === strip.recordId && r.diskPath === strip.file);
      if (!record?.writtenContent) {
        warnings.push(`cannot put back the RTK block in ${strip.file}: no record of what it held`);
        continue;
      }
      let back: Awaited<ReturnType<typeof restoreRtkBlocks>>;
      try {
        back = await restoreRtkBlocks(
          ctx.repoPath,
          strip.file,
          record.writtenContent,
          record.lastObservedDiskHash,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`could not put back the RTK block in ${strip.file}: ${msg}`);
        continue;
      }
      if (back.outcome === 'restored' || back.outcome === 'standing') {
        revertedCount += 1;
        if (strip.file === RTK_BLOCK_HOME) {
          const held = back.outcome === 'restored' ? back.held : record.writtenContent;
          const left = back.outcome === 'restored' ? back.left : record.writtenContent;
          await ensureRtkBlockAction(RTK_BLOCK_RESTORE_RECORD, strip.file, held, left);
        }
        continue;
      }
      const why = back.outcome === 'absent' ? 'it was removed after the upgrade' : back.reason;
      warnings.push(`did not put back the RTK block in ${strip.file}: ${why}`);
    }

    // The block a restore put in comes out only while the file still holds what the restore left.
    const restores = detected.rtkBlockRestores ?? [];
    const restoreRecords = await loadRtkRecords(
      restores.map((r) => r.recordId),
      RTK_BLOCK_RESTORE_RECORD,
    );
    for (const restore of restores) {
      const record = restoreRecords.find(
        (r) => r.id === restore.recordId && r.diskPath === restore.file,
      );
      if (typeof record?.writtenContent !== 'string' || !record.lastObservedDiskHash) {
        warnings.push(
          `cannot take the RTK block back out of ${restore.file}: no record of what it held`,
        );
        continue;
      }
      let back: Awaited<ReturnType<typeof takeOutRestoredRtkBlock>>;
      try {
        back = await takeOutRestoredRtkBlock(
          ctx.repoPath,
          restore.file,
          record.writtenContent,
          record.lastObservedDiskHash,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`could not take the RTK block back out of ${restore.file}: ${msg}`);
        continue;
      }
      if (back.outcome === 'removed' || back.outcome === 'already') {
        revertedCount += 1;
        const held = back.outcome === 'removed' ? back.held : record.writtenContent;
        const left = back.outcome === 'removed' ? back.left : record.writtenContent;
        await ensureRtkBlockAction(RTK_BLOCK_RECORD, restore.file, held, left);
        continue;
      }
      const why = back.outcome === 'absent' ? 'it was removed after the upgrade' : back.reason;
      warnings.push(`did not take the RTK block back out of ${restore.file}: ${why}`);
    }

    for (const target of detected.targets) {
      const rendering = byTemplateAndPath.get(`${target.templateId}:${target.diskPath}`);

      const decision = resolveRollbackRestore(target, rendering);
      if ('skip' in decision) {
        warnings.push(decision.skip);
        continue;
      }
      if (decision.warning) warnings.push(decision.warning);
      const {
        content: restoreContent,
        writtenHash: restoreWrittenHash,
        templateContentHash: restoreTemplateContentHash,
        schemaVersion: restoreSchemaVersion,
        templateId: restoreTemplateId,
        templateKind: restoreTemplateKind,
      } = decision.plan;

      const rel = safeDiskRel(target.diskPath);
      if (rel === null) {
        warnings.push(
          `refusing to restore ${target.diskPath}: ${namesGitData(target.diskPath) ? 'it names git data' : 'not a path inside the repository'}`,
        );
        continue;
      }
      // A kept path's ledger reverts too, so the next upgrade judges it against the version before.
      let observedHash: string | null = restoreWrittenHash;
      let putBack = true;
      if (target.removed) {
        const back = await restoreRemoved(ctx.repoPath, rel, restoreTemplateKind, restoreContent);
        if (back !== 'restored') {
          warnings.push(
            back === 'unread'
              ? `did not put back ${target.diskPath}: it could not be compared with what the upgrade removed (a link, not a regular file, or larger than ${RULES_FILE_READ_CAP} bytes)`
              : back === 'undecodable'
                ? `did not put back ${target.diskPath}: it is not valid UTF-8, so writing it back would change more than the upgrade removed`
                : `did not put back ${target.diskPath}: it changed after the upgrade removed it`,
          );
          continue;
        }
      } else {
        const left = target.upgradeArtifactId ? leftByRow.get(target.upgradeArtifactId) : undefined;
        const restore = await restoreIfUpgrades(
          ctx.repoPath,
          rel,
          restoreTemplateKind,
          left,
          restoreContent,
        );
        if (restore.outcome !== 'restored') {
          warnings.push(restoreRefusal(target.diskPath, restoreTemplateKind, restore));
          putBack = false;
          observedHash = restore.outcome === 'edited' ? restore.hash : null;
        }
      }
      if (putBack) revertedCount += 1;

      if (target.upgradeArtifactId) upgradeRowIds.push(target.upgradeArtifactId);

      rowsToInsert.push({
        userId: ctx.userId,
        repositoryId: detected.repositoryId,
        taskId: ctx.taskId,
        diskPath: target.diskPath,
        templateId: restoreTemplateId,
        templateKind: restoreTemplateKind,
        templateSchemaVersion: restoreSchemaVersion,
        templateContentHash: restoreTemplateContentHash,
        writtenHash: restoreWrittenHash,
        writtenContent: restoreContent,
        lastObservedDiskHash: observedHash,
        userModified: !putBack,
        formValuesSnapshot: snapshot,
        sourceStepId: '04-upgrade-rollback',
        source: 'rollback' as const,
        haiveVersion,
        bundleItemId: resolveBundleItemId(restoreTemplateId, liveBundleItemIds),
      });
    }

    // Undo new_artifact entries: delete the file from disk + supersede the
    // upgrade row. There's no prior baseline to restore — the file did not
    // exist before the upgrade. Idempotent on disk: missing file is fine.
    const undoneNewArtifactIds: string[] = [];
    for (const item of detected.newArtifactsToUndo) {
      try {
        const rel = safeDiskRel(item.diskPath);
        if (rel === null) {
          warnings.push(
            `refusing to undo ${item.diskPath}: ${namesGitData(item.diskPath) ? 'it names git data' : 'not a path inside the repository'}`,
          );
          continue;
        }
        const removal = await removeIfHaives(ctx.repoPath, rel, item, item.writtenHash);
        // A row the upgrade retired where it found nothing goes back live, so the path reads as
        // before: deleted by the person, or never installed.
        const retired = retiredRows.find((r) => r.id === item.retiredRowId);
        if (retired) {
          rowsToInsert.push(restoredRow(retired));
        }
        if (removal.outcome === 'kept') {
          // The upgrade's row is still undone; what stands there now stays.
          warnings.push(removal.refusal);
          undoneNewArtifactIds.push(item.upgradeArtifactId);
          continue;
        }
        undoneNewArtifactIds.push(item.upgradeArtifactId);
        revertedCount += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`failed to delete ${item.diskPath}: ${msg}`);
      }
    }

    // A row the upgrade untracked goes back live where nothing records its path now, an earlier
    // attempt of this rollback aside. The file was never touched, so nothing on disk changes.
    if (untrackedRows.length > 0) {
      const standing = new Set(
        (
          await ctx.db
            .select({ diskPath: schema.onboardingArtifacts.diskPath })
            .from(schema.onboardingArtifacts)
            .where(
              and(
                eq(schema.onboardingArtifacts.repositoryId, detected.repositoryId),
                inArray(
                  schema.onboardingArtifacts.diskPath,
                  untrackedRows.map((r) => r.diskPath),
                ),
                or(
                  isNull(schema.onboardingArtifacts.taskId),
                  ne(schema.onboardingArtifacts.taskId, ctx.taskId),
                ),
                isNull(schema.onboardingArtifacts.supersededAt),
              ),
            )
        ).map((r) => r.diskPath),
      );
      for (const row of untrackedRows) {
        if (standing.has(row.diskPath) || rowsToInsert.some((r) => r.diskPath === row.diskPath)) {
          warnings.push(
            `did not put back the row for ${row.diskPath}: another row records that path now`,
          );
          continue;
        }
        rowsToInsert.push(restoredRow(row));
        revertedCount += 1;
      }
    }

    // Defensive: supersede every live row at the diskPaths we are about to
    // insert (in addition to the explicit upgrade row ids and the new-artifact
    // undo ids), then insert. Wrapped in a single transaction so a
    // half-applied state is impossible.
    const rewriteIds = (detected.unrecordedRewrites ?? []).map((u) => u.upgradeArtifactId);
    revertedCount += rewriteIds.length;

    const insertPaths = Array.from(new Set(rowsToInsert.map((r) => r.diskPath)));
    const allRowsToSupersede = [...upgradeRowIds, ...undoneNewArtifactIds, ...rewriteIds];
    if (allRowsToSupersede.length > 0 || insertPaths.length > 0) {
      await ctx.db.transaction(async (tx) => {
        const now = new Date();
        if (allRowsToSupersede.length > 0) {
          await tx
            .update(schema.onboardingArtifacts)
            .set({ supersededAt: now, updatedAt: now })
            .where(
              and(
                inArray(schema.onboardingArtifacts.id, allRowsToSupersede),
                isNull(schema.onboardingArtifacts.supersededAt),
              ),
            );
        }
        if (insertPaths.length > 0) {
          await tx
            .update(schema.onboardingArtifacts)
            .set({ supersededAt: now, updatedAt: now })
            .where(
              and(
                eq(schema.onboardingArtifacts.repositoryId, detected.repositoryId),
                inArray(schema.onboardingArtifacts.diskPath, insertPaths),
                isNull(schema.onboardingArtifacts.supersededAt),
              ),
            );
        }
        if (rowsToInsert.length > 0) {
          await tx.insert(schema.onboardingArtifacts).values(rowsToInsert);
        }
      });
    }

    // A rollback that restored no snapshot (the upgrade only created files or untracked rows) takes
    // the context the rows live now carry, which is the one the repository had before the upgrade.
    const [repo] = await ctx.db
      .select({
        rtkEnabled: schema.repositories.rtkEnabled,
        rtkChoiceMadeAt: schema.repositories.rtkChoiceMadeAt,
      })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, detected.repositoryId))
      .limit(1);
    let recorded =
      snapshot ??
      pickRenderSnapshot(
        await loadLiveArtifacts(ctx.db, detected.repositoryId),
        repo?.rtkChoiceMadeAt,
      );

    const currentColumn = readRenderContextColumn(columnBefore?.renderContext);
    const maintained =
      currentColumn.kind === 'column'
        ? completeRecordedCliMembership(
            currentColumn.column,
            currentColumn.column.cliTargets === undefined
              ? recoverCliMembership(await loadLiveArtifacts(ctx.db, detected.repositoryId))
              : undefined,
          )
        : null;
    if (recorded && maintained?.cliTargets !== undefined) {
      const cliTargets = maintained.cliTargets;
      const targets = deriveRenderTargets(
        cliTargets,
        recorded.lspLanguages as string[],
        maintained.agentTargets,
        maintained.legacyAgentFallback,
      );
      recorded = {
        ...recorded,
        cliTargets,
        agentTargets: targets.agentTargets,
        enabledCliProviders: targets.enabledCliProviders,
      };
      if (maintained.legacyAgentFallback !== undefined)
        recorded.legacyAgentFallback = maintained.legacyAgentFallback;
      else delete recorded.legacyAgentFallback;
    }

    // Refresh applicable_template_ids from a fresh expansion against the
    // restored render context. After a rollback the repo's gating may differ
    // (e.g. prior baseline didn't include LSP plugins) — recompute from
    // ground truth.
    let chosen = false;
    if (recorded) {
      // A choice is what the plan of the upgrade being undone found, not what the value looks like:
      // a context from before RTK is stored with a synthesized `rtkEnabled: false`.
      const plan = (
        await loadPreviousStepOutput(ctx.db, detected.rolledBackFromTaskId, '01-upgrade-plan')
      )?.output as Pick<UpgradePlanOutput, 'rtkFollowsLive'> | null | undefined;
      chosen = plan?.rtkFollowsLive === true && typeof recorded.rtkEnabled === 'boolean';
      const restored = recorded as unknown as TemplateRenderContext;
      await ctx.db.transaction(async (tx) => {
        await lockRepositoryTasksKey(tx, detected.repositoryId);
        await lockProjectState(tx, detected.repositoryId);
        await refuseReleasedCheckout(tx, ctx.taskId, detected.repositoryId);
        await refuseMovedColumn(tx, detected.repositoryId, expectedColumns);
        const [live] = await tx
          .select({
            rtkEnabled: schema.repositories.rtkEnabled,
            rtkChoiceMadeAt: schema.repositories.rtkChoiceMadeAt,
          })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, detected.repositoryId))
          .for('update');
        const applicableExpanded = await unionExpandedFor(tx, {
          repositoryId: detected.repositoryId,
          userId: ctx.userId,
          renderCtx:
            live && isRtkChoiceRecorded(chosen, live.rtkChoiceMadeAt)
              ? { ...restored, rtkEnabled: live.rtkEnabled }
              : restored,
          logger: ctx.logger,
        });
        await updateApplicableTemplateIds(tx, detected.repositoryId, applicableExpanded);
      });
    }

    let recordWrite: RollbackOutput['recordWrite'] = recorded ? 'written' : 'skipped';
    try {
      if (recorded) {
        await writeProjectStateRecord(ctx.db, {
          repositoryId: detected.repositoryId,
          repoPath: ctx.repoPath,
          context: recorded as unknown as TemplateRenderContext,
          rtkChoiceRecorded: chosen,
          expectedColumns,
          holdingTaskId: ctx.taskId,
        });
        await retireInstallManifest(ctx, warnings);
      }
    } catch (err) {
      failIfColumnStale(err);
      recordWrite = 'failed';
      const message = safeErrorMessage(err);
      warnings.push(`project state record write failed: ${message}`);
      ctx.logger.warn({ err }, 'project state record write failed');
    }

    ctx.logger.info(
      { revertedCount, warnings, rolledBackFromTaskId: detected.rolledBackFromTaskId },
      'upgrade-rollback complete',
    );

    return {
      ...detected,
      warnings,
      revertedCount,
      recordWrite,
    };
  },
};

type RestoreResult =
  | { outcome: 'restored' }
  | { outcome: 'edited'; hash: string }
  | { outcome: 'absent' }
  | { outcome: 'unjudged' }
  | { outcome: 'undecodable' }
  | { outcome: 'parked'; parkedAt: string; rewrote: boolean };

/** Put back what an upgrade replaced only while the file, or its rules region, still holds what the
 *  upgrade left there, judged on the bytes replaced: an edit or a removal since is the person's and
 *  stays. Holding the prior bytes already is an earlier attempt of this rollback, and counts. */
async function restoreIfUpgrades(
  repoPath: string,
  rel: string,
  templateKind: string,
  left: string | undefined,
  content: string,
): Promise<RestoreResult> {
  if (left === undefined) return { outcome: 'unjudged' };
  const hashOf = (text: string) => sha256Hex(normalizeContent(text));
  const priorHash = hashOf(content);
  const region = templateKind === CLI_RULES_TEMPLATE_KIND;
  let judged: RestoreResult = { outcome: 'unjudged' };
  let rewrote = false;
  try {
    const result = await rewriteFileIfNoFollow(
      repoPath,
      rel,
      (data) => {
        const current = decodeUtf8Strict(data);
        if (current === null) {
          judged = { outcome: 'undecodable' };
          return null;
        }
        const text = region ? extractRegion(current, CLI_RULES_START, CLI_RULES_END) : current;
        if (text === null) {
          judged = { outcome: 'absent' };
          return null;
        }
        const hash = hashOf(text);
        if (hash === left) {
          rewrote = true;
          return Buffer.from(
            region ? upsertRegion(current, content, CLI_RULES_START, CLI_RULES_END) : content,
            'utf8',
          );
        }
        judged = hash === priorHash ? { outcome: 'restored' } : { outcome: 'edited', hash };
        return null;
      },
      { maxBytes: RULES_FILE_READ_CAP },
    );
    if (result === 'rewritten') return { outcome: 'restored' };
    return result === 'absent' ? { outcome: 'absent' } : judged;
  } catch (err) {
    if (err instanceof ParkedFileError) {
      return { outcome: 'parked', parkedAt: err.parkedAt, rewrote };
    }
    if (isPathContainmentError(err)) {
      if (['link', 'not-directory', 'not-regular-file'].includes(err.reason)) {
        return { outcome: 'unjudged' };
      }
    } else if (['ENOENT', 'ENOTDIR'].includes(errno(err) ?? '')) {
      return { outcome: 'absent' };
    }
    throw err;
  }
}

function restoreRefusal(
  diskPath: string,
  templateKind: string,
  result: Exclude<RestoreResult, { outcome: 'restored' }>,
): string {
  const what =
    templateKind === CLI_RULES_TEMPLATE_KIND ? `the rules region in ${diskPath}` : diskPath;
  switch (result.outcome) {
    case 'edited':
      return `kept ${what} as it is: it was edited after the upgrade wrote it`;
    case 'absent':
      return `did not put back ${what}: it was removed after the upgrade wrote it`;
    case 'parked':
      return `kept ${what} as it is: it was saved while the rollback judged it, and ${result.rewrote ? 'what the rollback put back' : 'what stood there before'} is at ${result.parkedAt}`;
    case 'unjudged':
      return `did not put back ${what}: it could not be compared with what the upgrade wrote there`;
    case 'undecodable':
      return `did not put back ${what}: it is not valid UTF-8, so writing it back would change more than the upgrade did`;
  }
}

/** Put back what an upgrade removed, only where nothing stands now: a file there, a region in
 *  AGENTS.md, or AGENTS.md gone altogether is what someone did since, and stays. What stands there
 *  already holding the restore is an earlier attempt of this rollback, and counts as put back.
 *  What cannot be read there, past the cap or not a regular file, is left as it is. */
async function restoreRemoved(
  repoPath: string,
  rel: string,
  templateKind: string,
  content: string,
): Promise<'restored' | 'changed' | 'unread' | 'undecodable'> {
  const unreadable = (err: unknown) =>
    isPathContainmentError(err) &&
    ['link', 'not-directory', 'not-regular-file'].includes(err.reason);
  if (templateKind !== CLI_RULES_TEMPLATE_KIND) {
    try {
      await writeFileNoFollow(repoPath, rel, content, {
        mode: 'create-exclusive',
        createParents: true,
      });
      return 'restored';
    } catch (err) {
      if (unreadable(err)) return 'unread';
      if (errno(err) !== 'EEXIST') throw err;
      const read = await readUpgradeFile(repoPath, rel);
      if (read.kind === 'unread') return read.reason === 'undecodable' ? 'undecodable' : 'unread';
      return read.kind === 'text' && read.text === content ? 'restored' : 'changed';
    }
  }
  let judged = false;
  let undecodable = false;
  let alreadyBack = false;
  let result;
  try {
    result = await rewriteFileIfNoFollow(
      repoPath,
      rel,
      (data) => {
        judged = true;
        const current = decodeUtf8Strict(data);
        if (current === null) {
          undecodable = true;
          return null;
        }
        const region = extractRegion(current, CLI_RULES_START, CLI_RULES_END);
        if (region !== null) {
          alreadyBack = region === content;
          return null;
        }
        return Buffer.from(upsertRegion(current, content, CLI_RULES_START, CLI_RULES_END), 'utf8');
      },
      { maxBytes: RULES_FILE_READ_CAP },
    );
  } catch (err) {
    if (unreadable(err)) return 'unread';
    throw err;
  }
  if (result === 'rewritten' || alreadyBack) return 'restored';
  if (undecodable) return 'undecodable';
  return result === 'kept' && !judged ? 'unread' : 'changed';
}

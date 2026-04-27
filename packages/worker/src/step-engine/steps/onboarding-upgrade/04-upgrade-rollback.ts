import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { schema } from '@haive/database';
import { getHaiveVersion, normalizeContent, type InstallManifest } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import {
  expandManifestFor,
  getTemplateManifest,
  updateApplicableTemplateIds,
  type TemplateRenderContext,
} from '../../template-manifest.js';

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
  upgradeArtifactId: string;
  priorTemplateContentHash: string;
  priorWrittenHash: string;
  /** Stored content of the prior baseline row. Null on legacy rows written
   *  before migration 0013 — rollback falls back to re-rendering at current
   *  code in that case (best-effort, may drift). */
  priorWrittenContent: string | null;
  priorFormValuesSnapshot: Record<string, unknown> | null;
}

interface RollbackDetect {
  repositoryId: string;
  rolledBackFromTaskId: string;
  targets: RollbackTarget[];
  warnings: string[];
}

interface RollbackOutput extends RollbackDetect {
  revertedCount: number;
  installManifestWritten: boolean;
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

    // Find the most recent completed upgrade task (not this rollback one).
    const priorUpgrade = await ctx.db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.repositoryId, repositoryId),
          eq(schema.tasks.type, 'onboarding_upgrade'),
          eq(schema.tasks.status, 'completed'),
          ne(schema.tasks.id, ctx.taskId),
        ),
      )
      .orderBy(desc(schema.tasks.completedAt))
      .limit(1);
    const priorTaskId = priorUpgrade[0]?.id ?? null;
    if (!priorTaskId) {
      throw new Error('upgrade-rollback: no prior completed onboarding_upgrade task to revert');
    }

    // Live rows written by that prior upgrade task.
    const upgradeRows = await ctx.db
      .select({
        id: schema.onboardingArtifacts.id,
        diskPath: schema.onboardingArtifacts.diskPath,
        templateId: schema.onboardingArtifacts.templateId,
        templateKind: schema.onboardingArtifacts.templateKind,
      })
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, repositoryId),
          eq(schema.onboardingArtifacts.taskId, priorTaskId),
          isNull(schema.onboardingArtifacts.supersededAt),
        ),
      );
    if (upgradeRows.length === 0) {
      warnings.push('no live rows attributable to the prior upgrade task; nothing to revert');
    }

    // For each upgrade row, find the immediately-prior (now-superseded) row
    // for the same disk_path. Take the most-recently-superseded one.
    const targets: RollbackTarget[] = [];
    for (const upgradeRow of upgradeRows) {
      const priorCandidates = await ctx.db
        .select({
          id: schema.onboardingArtifacts.id,
          templateId: schema.onboardingArtifacts.templateId,
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
            eq(schema.onboardingArtifacts.diskPath, upgradeRow.diskPath),
            ne(schema.onboardingArtifacts.id, upgradeRow.id),
          ),
        )
        .orderBy(desc(schema.onboardingArtifacts.supersededAt))
        .limit(1);
      const prior = priorCandidates[0];
      if (!prior) {
        warnings.push(`no prior baseline for ${upgradeRow.diskPath}; skipping`);
        continue;
      }
      targets.push({
        diskPath: upgradeRow.diskPath,
        templateId: prior.templateId,
        templateKind: upgradeRow.templateKind,
        templateSchemaVersion: prior.templateSchemaVersion,
        priorArtifactId: prior.id,
        upgradeArtifactId: upgradeRow.id,
        priorTemplateContentHash: prior.templateContentHash,
        priorWrittenHash: prior.writtenHash,
        priorWrittenContent: prior.writtenContent ?? null,
        priorFormValuesSnapshot: (prior.formValuesSnapshot ?? null) as Record<
          string,
          unknown
        > | null,
      });
    }

    return {
      repositoryId,
      rolledBackFromTaskId: priorTaskId,
      targets,
      warnings,
    };
  },

  async apply(ctx, args): Promise<RollbackOutput> {
    const detected = args.detected;
    const warnings = [...detected.warnings];
    const manifest = getTemplateManifest();
    let revertedCount = 0;

    // Re-render using whichever snapshot the prior baseline carried.
    const snapshot =
      detected.targets.find((t) => t.priorFormValuesSnapshot)?.priorFormValuesSnapshot ?? null;
    if (!snapshot && detected.targets.length > 0) {
      throw new Error(
        'upgrade-rollback apply: no form_values_snapshot available on any prior baseline row',
      );
    }
    const renderCtx = (snapshot ?? {}) as unknown as TemplateRenderContext;
    const expanded = snapshot ? expandManifestFor(renderCtx, manifest) : [];
    const byTemplateAndPath = new Map<string, (typeof expanded)[number]>();
    for (const r of expanded) {
      byTemplateAndPath.set(`${r.templateId}:${r.diskPath}`, r);
    }

    const rowsToInsert: (typeof schema.onboardingArtifacts.$inferInsert)[] = [];
    const upgradeRowIds: string[] = [];
    const haiveVersion = getHaiveVersion();

    for (const target of detected.targets) {
      const rendering = byTemplateAndPath.get(`${target.templateId}:${target.diskPath}`);
      // Schema version mismatch is unrecoverable in either restore mode —
      // shape changed, no way to safely revert without prior code.
      if (rendering && rendering.templateSchemaVersion !== target.templateSchemaVersion) {
        warnings.push(
          `schema_version mismatch for ${target.diskPath} (prior=${target.templateSchemaVersion}, current=${rendering.templateSchemaVersion}); skipping`,
        );
        continue;
      }

      // Preferred path: restore exact baseline content from the prior row's
      // stored writtenContent. Works correctly across body drift since we
      // store the actual bytes that were on disk.
      let restoreContent: string | null = null;
      let restoreWrittenHash: string;
      let restoreTemplateContentHash: string;
      let restoreSchemaVersion: number;
      let restoreTemplateId: string;
      let restoreTemplateKind: string;

      if (target.priorWrittenContent !== null) {
        restoreContent = target.priorWrittenContent;
        restoreWrittenHash = target.priorWrittenHash;
        restoreTemplateContentHash = target.priorTemplateContentHash;
        restoreSchemaVersion = target.templateSchemaVersion;
        restoreTemplateId = target.templateId;
        restoreTemplateKind = target.templateKind;
      } else if (rendering) {
        // Legacy fallback: prior row predates migration 0013 (no stored
        // content). Re-render against current manifest code — exact match
        // when template body hasn't drifted, best-effort otherwise.
        if (rendering.templateContentHash !== target.priorTemplateContentHash) {
          warnings.push(
            `content drifted for ${target.diskPath}; legacy row has no stored baseline content, restored from current code (best-effort)`,
          );
        }
        restoreContent = rendering.content;
        restoreWrittenHash = rendering.writtenHash;
        restoreTemplateContentHash = rendering.templateContentHash;
        restoreSchemaVersion = rendering.templateSchemaVersion;
        restoreTemplateId = rendering.templateId;
        restoreTemplateKind = rendering.templateKind;
      } else {
        warnings.push(
          `cannot restore ${target.diskPath}: no stored content and template ${target.templateId} no longer in manifest`,
        );
        continue;
      }

      const absPath = path.join(ctx.repoPath, target.diskPath);
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, restoreContent, 'utf8');
      revertedCount += 1;

      upgradeRowIds.push(target.upgradeArtifactId);

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
        lastObservedDiskHash: restoreWrittenHash,
        userModified: false,
        formValuesSnapshot: (snapshot ?? {}) as Record<string, unknown>,
        sourceStepId: '04-upgrade-rollback',
        source: 'rollback' as const,
        haiveVersion,
      });
    }

    if (upgradeRowIds.length > 0) {
      const now = new Date();
      await ctx.db
        .update(schema.onboardingArtifacts)
        .set({ supersededAt: now, updatedAt: now })
        .where(
          and(
            inArray(schema.onboardingArtifacts.id, upgradeRowIds),
            isNull(schema.onboardingArtifacts.supersededAt),
          ),
        );
    }

    if (rowsToInsert.length > 0) {
      await ctx.db.insert(schema.onboardingArtifacts).values(rowsToInsert);
    }

    // Refresh applicable_template_ids from a fresh expansion against the
    // restored render context. After a rollback the repo's gating may differ
    // (e.g. prior baseline didn't include LSP plugins) — recompute from
    // ground truth.
    if (snapshot) {
      const applicableExpanded = expandManifestFor(
        snapshot as unknown as TemplateRenderContext,
        manifest,
      );
      await updateApplicableTemplateIds(ctx.db, detected.repositoryId, applicableExpanded);
    }

    const installManifestWritten = await writeInstallManifest(
      ctx,
      detected.repositoryId,
      manifest.setHash,
    );

    ctx.logger.info(
      { revertedCount, warnings, rolledBackFromTaskId: detected.rolledBackFromTaskId },
      'upgrade-rollback complete',
    );

    return {
      ...detected,
      warnings,
      revertedCount,
      installManifestWritten,
    };
  },
};

async function writeInstallManifest(
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

  const installManifest: InstallManifest = {
    schemaVersion: 1,
    haiveVersion: getHaiveVersion(),
    appliedAt: new Date().toISOString(),
    lastTaskId: ctx.taskId,
    templateSetHash: currentSetHash,
    templates: Array.from(byTemplate.values())
      .map((t) => ({ ...t, diskPaths: t.diskPaths.slice().sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };

  const installDir = path.join(ctx.repoPath, '.haive');
  const installPath = path.join(installDir, 'install.json');
  await mkdir(installDir, { recursive: true });
  const content = normalizeContent(`${JSON.stringify(installManifest, null, 2)}\n`);
  await writeFile(installPath, content, 'utf8');

  return true;
}

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  getHaiveVersion,
  normalizeContent,
  sha256Hex,
  type FormSchema,
  type InstallManifest,
} from '@haive/shared';
import type { StepDefinition } from '../../step-definition.js';
import {
  expandManifestFor,
  getTemplateManifest,
  updateApplicableTemplateIds,
  type TemplateRenderContext,
} from '../../template-manifest.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import type { UpgradePlanOutput, UpgradePlanEntry } from './01-upgrade-plan.js';

const CONFLICT_CHOICE_VALUES = ['apply_theirs', 'keep_ours', 'skip'] as const;
type ConflictChoice = (typeof CONFLICT_CHOICE_VALUES)[number];

function conflictFieldId(entryId: string): string {
  // radio field ids must not contain characters the renderer treats specially;
  // entryId already embeds disk path so we hash it for a stable short key.
  return `conflict__${sha256Hex(entryId).slice(0, 16)}`;
}

const TEMPLATE_KIND_LABELS: Record<string, string> = {
  agent: 'Agents',
  'agents-index': 'Agent index',
  command: 'Commands',
  'workflow-config': 'Workflow config',
  'plugin-file': 'Plugin files',
  'agents-md-block': 'AGENTS.md blocks',
  'cli-rules-block': 'CLI rules blocks',
};

function templateKindLabel(kind: string): string {
  return TEMPLATE_KIND_LABELS[kind] ?? kind;
}

interface UpgradeApplyOutput {
  appliedCount: number;
  skippedCount: number;
  deletedCount: number;
  warnings: string[];
  installManifestWritten: boolean;
}

async function resolvePlanFromStep(ctx: {
  db: import('@haive/database').Database;
  taskId: string;
}): Promise<UpgradePlanOutput> {
  const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-upgrade-plan');
  const plan = (prev?.output ?? null) as UpgradePlanOutput | null;
  if (!plan) throw new Error('upgrade-apply: 01-upgrade-plan output missing');
  return plan;
}

function groupEntriesForForm(entries: UpgradePlanEntry[]): {
  cleanUpdates: UpgradePlanEntry[];
  newArtifacts: UpgradePlanEntry[];
  userDeleted: UpgradePlanEntry[];
  conflicts: UpgradePlanEntry[];
  obsolete: UpgradePlanEntry[];
} {
  return {
    cleanUpdates: entries.filter((e) => e.bucket === 'clean_update'),
    newArtifacts: entries.filter((e) => e.bucket === 'new_artifact'),
    userDeleted: entries.filter((e) => e.bucket === 'user_deleted'),
    conflicts: entries.filter((e) => e.bucket === 'conflict'),
    obsolete: entries.filter((e) => e.bucket === 'obsolete'),
  };
}

export const upgradeApplyStep: StepDefinition<UpgradePlanOutput, UpgradeApplyOutput> = {
  metadata: {
    id: '02-upgrade-apply',
    workflowType: 'onboarding_upgrade',
    index: 2,
    title: 'Apply upgrade',
    description: 'Select which template changes to apply. Conflicts require explicit resolution.',
    requiresCli: false,
  },

  async shouldRun(ctx) {
    const { shouldRunUpgrade } = await import('./04-upgrade-rollback.js');
    return shouldRunUpgrade(ctx);
  },

  async detect(ctx): Promise<UpgradePlanOutput> {
    return resolvePlanFromStep({ db: ctx.db, taskId: ctx.taskId });
  },

  form(_ctx, detected): FormSchema | null {
    const { cleanUpdates, newArtifacts, userDeleted, conflicts, obsolete } = groupEntriesForForm(
      detected.entries,
    );
    const fields: FormSchema['fields'] = [];

    const toOptions = (entries: UpgradePlanEntry[]) =>
      entries.map((e) => ({
        value: e.entryId,
        label: e.diskPath,
        group: templateKindLabel(e.templateKind),
      }));

    if (cleanUpdates.length > 0) {
      fields.push({
        type: 'multi-select',
        id: 'selectedUpdates',
        label: 'Template updates (safe to apply)',
        description: `${cleanUpdates.length} artifact(s) changed upstream; your copies match the prior baseline.`,
        options: toOptions(cleanUpdates),
        defaults: cleanUpdates.map((e) => e.entryId),
      });
    }
    if (newArtifacts.length > 0) {
      fields.push({
        type: 'multi-select',
        id: 'selectedNew',
        label: 'New templates (not yet installed)',
        description: `${newArtifacts.length} new artifact(s) introduced by the current Haive release.`,
        options: toOptions(newArtifacts),
        defaults: newArtifacts.map((e) => e.entryId),
      });
    }
    if (userDeleted.length > 0) {
      fields.push({
        type: 'multi-select',
        id: 'selectedReinstate',
        label: 'Reinstate deleted files',
        description: `${userDeleted.length} artifact(s) you had installed are missing from disk.`,
        options: toOptions(userDeleted),
        defaults: [],
      });
    }
    for (const c of conflicts) {
      fields.push({
        type: 'radio',
        id: conflictFieldId(c.entryId),
        label: `Conflict: ${c.diskPath}`,
        description:
          'Your copy differs from the prior baseline AND the template changed. Pick one.',
        options: [
          { value: 'apply_theirs', label: 'Overwrite with new template' },
          { value: 'keep_ours', label: 'Keep my edits (do not update)' },
          { value: 'skip', label: 'Skip (re-prompt on next upgrade)' },
        ],
        default: 'skip',
      });
    }
    if (obsolete.length > 0) {
      fields.push({
        type: 'multi-select',
        id: 'selectedObsoleteRemovals',
        label: 'Delete obsolete files',
        description: `${obsolete.length} artifact(s) Haive no longer manages. Select to remove from disk.`,
        options: toOptions(obsolete),
        defaults: [],
      });
    }

    if (fields.length === 0) return null;

    return {
      title: 'Upgrade selections',
      description: 'Pick which template changes to apply. Unselected items are skipped.',
      fields,
      submitLabel: 'Apply selected changes',
    };
  },

  async apply(ctx, args): Promise<UpgradeApplyOutput> {
    const plan = args.detected;
    const values = args.formValues;
    const warnings: string[] = [];
    const manifest = getTemplateManifest();
    const haiveVersion = getHaiveVersion();

    const selectedUpdates = new Set<string>(toStringArray(values.selectedUpdates));
    const selectedNew = new Set<string>(toStringArray(values.selectedNew));
    const selectedReinstate = new Set<string>(toStringArray(values.selectedReinstate));
    const selectedObsoleteRemovals = new Set<string>(
      toStringArray(values.selectedObsoleteRemovals),
    );

    const conflictChoices = new Map<string, ConflictChoice>();
    for (const e of plan.entries) {
      if (e.bucket !== 'conflict') continue;
      const raw = values[conflictFieldId(e.entryId)];
      const choice =
        typeof raw === 'string' && (CONFLICT_CHOICE_VALUES as readonly string[]).includes(raw)
          ? (raw as ConflictChoice)
          : 'skip';
      conflictChoices.set(e.entryId, choice);
    }

    let appliedCount = 0;
    let skippedCount = 0;
    let deletedCount = 0;

    const rowsToSupersede: string[] = [];
    const rowsToInsert: (typeof schema.onboardingArtifacts.$inferInsert)[] = [];

    for (const entry of plan.entries) {
      const shouldApply =
        (entry.bucket === 'clean_update' && selectedUpdates.has(entry.entryId)) ||
        (entry.bucket === 'new_artifact' && selectedNew.has(entry.entryId)) ||
        (entry.bucket === 'user_deleted' && selectedReinstate.has(entry.entryId)) ||
        (entry.bucket === 'conflict' && conflictChoices.get(entry.entryId) === 'apply_theirs');

      const shouldDelete =
        entry.bucket === 'obsolete' && selectedObsoleteRemovals.has(entry.entryId);

      if (!shouldApply && !shouldDelete) {
        skippedCount += 1;
        continue;
      }

      if (shouldDelete) {
        try {
          await rm(path.join(ctx.repoPath, entry.diskPath), { force: true });
          if (entry.liveArtifactId) rowsToSupersede.push(entry.liveArtifactId);
          deletedCount += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`failed to delete ${entry.diskPath}: ${msg}`);
        }
        continue;
      }

      if (!entry.newContent) {
        warnings.push(`entry ${entry.diskPath} has no newContent; skipping`);
        skippedCount += 1;
        continue;
      }

      const absPath = path.join(ctx.repoPath, entry.diskPath);
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, entry.newContent, 'utf8');
      appliedCount += 1;

      if (entry.liveArtifactId) rowsToSupersede.push(entry.liveArtifactId);

      const writtenHash = sha256Hex(normalizeContent(entry.newContent));
      rowsToInsert.push({
        userId: ctx.userId,
        repositoryId: plan.repositoryId,
        taskId: ctx.taskId,
        diskPath: entry.diskPath,
        templateId: entry.templateId,
        templateKind: entry.templateKind,
        templateSchemaVersion: entry.templateSchemaVersion ?? 1,
        templateContentHash: entry.currentTemplateContentHash ?? '',
        writtenHash,
        writtenContent: entry.newContent,
        lastObservedDiskHash: writtenHash,
        userModified: false,
        formValuesSnapshot: plan.renderCtxSnapshot,
        sourceStepId: '02-upgrade-apply',
        source: 'upgrade' as const,
        haiveVersion,
      });
    }

    if (rowsToSupersede.length > 0) {
      const now = new Date();
      await ctx.db
        .update(schema.onboardingArtifacts)
        .set({ supersededAt: now, updatedAt: now })
        .where(
          and(
            inArray(schema.onboardingArtifacts.id, rowsToSupersede),
            isNull(schema.onboardingArtifacts.supersededAt),
          ),
        );
    }

    if (rowsToInsert.length > 0) {
      await ctx.db.insert(schema.onboardingArtifacts).values(rowsToInsert);
    }

    // Refresh applicable_template_ids on the repo from a fresh expansion
    // against the plan's render context — the source of truth for which
    // templates apply to this repo right now (gating included).
    const applicableExpanded = expandManifestFor(
      plan.renderCtxSnapshot as unknown as TemplateRenderContext,
      manifest,
    );
    await updateApplicableTemplateIds(ctx.db, plan.repositoryId, applicableExpanded);

    // Rewrite .haive/install.json to reflect the post-upgrade state. Query
    // live rows fresh so deletions and upgrades are both accounted for.
    const installManifestWritten = await writeInstallManifest(
      ctx,
      plan.repositoryId,
      manifest.setHash,
    );

    ctx.logger.info(
      { appliedCount, skippedCount, deletedCount, rowsInserted: rowsToInsert.length, warnings },
      'upgrade-apply complete',
    );

    return {
      appliedCount,
      skippedCount,
      deletedCount,
      warnings,
      installManifestWritten,
    };
  },
};

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

async function writeInstallManifest(
  ctx: import('../../step-definition.js').StepContext,
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
  ctx.logger.info(
    { installPath: '.haive/install.json', templateCount: byTemplate.size },
    'upgrade-apply: rewrote install manifest',
  );
  return true;
}

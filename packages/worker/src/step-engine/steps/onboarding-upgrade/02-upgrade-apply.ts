import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import { getHaiveVersion, normalizeContent, sha256Hex, type FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import {
  expandCustomBundlesFor,
  expandManifestFor,
  getTemplateManifest,
  updateApplicableTemplateIds,
  type ExpandedRendering,
  type TemplateRenderContext,
} from '../../template-manifest.js';
import {
  extractBundleItemId,
  loadBundlesForExpansion,
  resolveSkillTargets,
} from '../../_custom-bundle-loader.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import type { UpgradePlanOutput, UpgradePlanEntry } from './01-upgrade-plan.js';

const CONFLICT_CHOICE_VALUES = ['apply_theirs', 'keep_ours', 'skip'] as const;
type ConflictChoice = (typeof CONFLICT_CHOICE_VALUES)[number];

/** Action the apply loop should take for a single plan entry. */
export type ApplyAction = 'apply' | 'delete' | 'untrack' | 'skip';

export interface ApplySelections {
  selectedUpdates: ReadonlySet<string>;
  selectedNew: ReadonlySet<string>;
  selectedReinstate: ReadonlySet<string>;
  selectedObsoleteRemovals: ReadonlySet<string>;
  conflictChoices: ReadonlyMap<string, ConflictChoice>;
}

/** Pure classifier for the apply loop. Splits the per-entry decision out of
 *  the imperative loop so the four branches (`apply`, `delete`, `untrack`,
 *  `skip`) can be unit-tested without a DB or file system. The `untrack`
 *  branch — supersede the artifact row without touching disk — fires when
 *  the user skipped an obsolete custom-bundle row whose source bundle item
 *  is gone AND no other entry in the plan rewrites the same diskPath; that
 *  combination signals the file is now user-owned and should drop out of
 *  drift tracking on the next upgrade. */
export function classifyApplyAction(
  entry: UpgradePlanEntry,
  allEntries: ReadonlyArray<UpgradePlanEntry>,
  selections: ApplySelections,
): ApplyAction {
  const shouldApply =
    (entry.bucket === 'clean_update' && selections.selectedUpdates.has(entry.entryId)) ||
    (entry.bucket === 'new_artifact' && selections.selectedNew.has(entry.entryId)) ||
    (entry.bucket === 'user_deleted' && selections.selectedReinstate.has(entry.entryId)) ||
    (entry.bucket === 'conflict' &&
      selections.conflictChoices.get(entry.entryId) === 'apply_theirs');
  if (shouldApply) return 'apply';

  const shouldDelete =
    entry.bucket === 'obsolete' && selections.selectedObsoleteRemovals.has(entry.entryId);
  if (shouldDelete) return 'delete';

  const shouldUntrackDangling =
    entry.bucket === 'obsolete' &&
    !selections.selectedObsoleteRemovals.has(entry.entryId) &&
    entry.templateId.startsWith('custom.') &&
    entry.liveArtifactId !== null &&
    !allEntries.some(
      (other) =>
        other !== entry &&
        other.diskPath === entry.diskPath &&
        (other.bucket === 'clean_update' ||
          other.bucket === 'conflict' ||
          other.bucket === 'new_artifact'),
    );
  if (shouldUntrackDangling) return 'untrack';

  return 'skip';
}

/** Resolve a candidate `bundle_item_id` to either the live row's id or null.
 *  The bundle_item_id column is FK-enforced; templateIds may reference items
 *  that have since been deleted (e.g. user replaced the source ZIP). Use this
 *  helper to guard inserts so we never violate the FK. */
export function resolveBundleItemId(
  templateId: string,
  liveBundleItemIds: ReadonlySet<string>,
): string | null {
  const id = extractBundleItemId(templateId);
  return id && liveBundleItemIds.has(id) ? id : null;
}

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
  'custom-agent': 'Bundle agents',
  'custom-skill': 'Bundle skills',
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
      entries.map((e) => {
        const opt: {
          value: string;
          label: string;
          group: string;
          details?: {
            kind: 'diff';
            baseline: string | null;
            current: string;
            editable: boolean;
          };
        } = {
          value: e.entryId,
          label: e.diskPath,
          group: templateKindLabel(e.templateKind),
        };
        if (e.newContent !== null) {
          // Diff baseline = what's actually on disk now (currentContent), so
          // the user sees the change relative to their current state — not the
          // prior baseline hash. For new_artifact / user_deleted, currentContent
          // is null and the renderer treats null as an empty file (all-added).
          opt.details = {
            kind: 'diff',
            baseline: e.currentContent,
            current: e.newContent,
            editable: false,
          };
        }
        return opt;
      });

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
        details:
          c.newContent !== null
            ? {
                kind: 'diff' as const,
                baseline: c.currentContent,
                current: c.newContent,
                editable: false,
              }
            : undefined,
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

    // bundle_item_id is FK-enforced. Resolve all candidate ids from entry
    // templateIds against custom_bundle_items so we can null out linkage for
    // items that have since been deleted (race with bundle re-ingest).
    const candidateBundleItemIds = new Set<string>();
    for (const entry of plan.entries) {
      const id = extractBundleItemId(entry.templateId);
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

    const selections: ApplySelections = {
      selectedUpdates,
      selectedNew,
      selectedReinstate,
      selectedObsoleteRemovals,
      conflictChoices,
    };

    for (const entry of plan.entries) {
      const action = classifyApplyAction(entry, plan.entries, selections);

      if (action === 'skip') {
        skippedCount += 1;
        continue;
      }

      if (action === 'untrack' && entry.liveArtifactId) {
        rowsToSupersede.push(entry.liveArtifactId);
        skippedCount += 1;
        continue;
      }

      if (action === 'delete') {
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
        bundleItemId: resolveBundleItemId(entry.templateId, liveBundleItemIds),
      });
    }

    // Defensive supersede + insert. Plan's `liveArtifactId` is what the plan
    // *thinks* is the live row at each entry's diskPath, but if the plan was
    // generated under stale state (or with a buggy expansion that classified
    // a path as `new_artifact` while a live row already existed) the INSERT
    // would collide on the (repository_id, disk_path) WHERE supersededAt IS
    // NULL unique idx. So before inserting we supersede ANY live row at the
    // diskPaths we are about to write, in addition to the explicit ids the
    // plan attached. Wrapped in a single transaction so a half-applied state
    // is impossible.
    const insertPaths = Array.from(new Set(rowsToInsert.map((r) => r.diskPath)));
    if (rowsToSupersede.length > 0 || insertPaths.length > 0) {
      await ctx.db.transaction(async (tx) => {
        const now = new Date();
        if (rowsToSupersede.length > 0) {
          await tx
            .update(schema.onboardingArtifacts)
            .set({ supersededAt: now, updatedAt: now })
            .where(
              and(
                inArray(schema.onboardingArtifacts.id, rowsToSupersede),
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
                eq(schema.onboardingArtifacts.repositoryId, plan.repositoryId),
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

    // Refresh applicable_template_ids on the repo from a fresh expansion
    // against the plan's render context — the source of truth for which
    // templates apply to this repo right now (gating included). Joins Haive
    // template expansion with custom-bundle expansion so the per-repo
    // applicable set covers `custom.*` ids as well.
    const renderCtx = plan.renderCtxSnapshot as unknown as TemplateRenderContext;
    const haiveApplicable = expandManifestFor(renderCtx, manifest);
    const bundles = await loadBundlesForExpansion(ctx.db, plan.repositoryId, ctx.logger);
    const skillTargets = await resolveSkillTargets(ctx.db, ctx.userId);
    const customApplicable = expandCustomBundlesFor(bundles, renderCtx.agentTargets, skillTargets);
    const applicableExpanded: ExpandedRendering[] = [...haiveApplicable, ...customApplicable];
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
  ctx: StepContext,
  repositoryId: string,
  currentSetHash: string,
): Promise<boolean> {
  const { writeInstallManifestFromLiveRows } = await import('../../_install-manifest.js');
  return writeInstallManifestFromLiveRows(ctx, repositoryId, currentSetHash);
}

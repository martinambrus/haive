import {
  errno,
  isPathContainmentError,
  readTextNoFollow,
  removeFileIfNoFollow,
  rewriteFileIfNoFollow,
  toSafeRel,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  extractRegion,
  getHaiveVersion,
  normalizeContent,
  sha256Hex,
  upsertRegion,
  type FormSchema,
} from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import {
  expandCustomBundlesFor,
  expandManifestFor,
  getTemplateManifest,
  updateApplicableTemplateIds,
  type ExpandedRendering,
  type TemplateRenderContext,
} from '../../template-manifest.js';
import { extractBundleItemId, loadBundlesForExpansion } from '../../_custom-bundle-loader.js';
import { loadPreviousStepOutput, resolveSkillTargetDirs } from '../onboarding/_helpers.js';
import {
  cliRulesRegionRecord,
  enabledImportRulesFiles,
  loadCliRulesRenderHashes,
  restoreRulesImportStubs,
  stripRtkBlocks,
  type RulesImportStubOutcome,
} from '../onboarding/_rules-files.js';
import { withoutRtkHookEntry } from '../onboarding/_rtk-templates.js';
import {
  backfillRecord,
  type UpgradePlanOutput,
  type UpgradePlanEntry,
} from './01-upgrade-plan.js';

const CONFLICT_CHOICE_VALUES = ['apply_theirs', 'keep_ours', 'skip'] as const;
type ConflictChoice = (typeof CONFLICT_CHOICE_VALUES)[number];

/** Action the apply loop should take for a single plan entry. */
export type ApplyAction = 'apply' | 'delete' | 'strip' | 'untrack' | 'keep' | 'skip';

export interface ApplySelections {
  selectedUpdates: ReadonlySet<string>;
  selectedNew: ReadonlySet<string>;
  selectedReinstate: ReadonlySet<string>;
  selectedObsoleteRemovals: ReadonlySet<string>;
  selectedRtkHookStrips: ReadonlySet<string>;
  conflictChoices: ReadonlyMap<string, ConflictChoice>;
}

/** Pure classifier for the apply loop. Splits the per-entry decision out of
 *  the imperative loop so the five branches (`apply`, `delete`, `untrack`,
 *  `keep`, `skip`) can be unit-tested without a DB or file system. The `untrack`
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
  if (
    entry.bucket === 'conflict' &&
    selections.conflictChoices.get(entry.entryId) === 'keep_ours'
  ) {
    return 'keep';
  }

  const shouldDelete =
    entry.bucket === 'obsolete' && selections.selectedObsoleteRemovals.has(entry.entryId);
  if (shouldDelete) return 'delete';
  if (entry.bucket === 'obsolete' && selections.selectedRtkHookStrips.has(entry.entryId)) {
    return 'strip';
  }

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

/** The file an edited, obsolete RTK settings entry would become with the RTK hook taken out, which
 *  the form offers in place of a delete that would keep it. Null for every other entry. */
export function rtkHookStripPreview(entry: UpgradePlanEntry): string | null {
  if (entry.bucket !== 'obsolete' || entry.templateKind !== 'rtk-config') return null;
  if (entry.currentContent === null || entry.currentHash === entry.baselineWrittenHash) return null;
  return withoutRtkHookEntry(entry.templateId, entry.currentContent);
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

/** What sits at a path as its row records it, and hashed the way the plan compares it: the whole
 *  file, or the rules region alone. Null only when nothing is there: a link or anything but a
 *  regular file throws, so no caller mistakes it for absence and removes it. */
export async function pathContent(
  repoPath: string,
  rel: string,
  templateKind: string,
): Promise<{ content: string; hash: string } | null> {
  const raw = await readTextNoFollow(repoPath, rel, { strict: true });
  if (raw === null) return null;
  if (templateKind !== CLI_RULES_TEMPLATE_KIND) {
    return { content: raw, hash: sha256Hex(normalizeContent(raw)) };
  }
  const region = extractRegion(raw, CLI_RULES_START, CLI_RULES_END);
  if (region === null) return null;
  const content = normalizeContent(region);
  return { content, hash: sha256Hex(content) };
}

/** What "Keep my edits" writes over a live row: the version declined, under that version's identity,
 *  and the bytes kept, for a later rollback to restore. `writtenHash` stays, claiming none of them. */
export function keptRowUpdate(
  entry: Pick<UpgradePlanEntry, 'templateId' | 'templateSchemaVersion'>,
  declinedTemplateContentHash: string,
  kept: { content: string; hash: string },
  liveBundleItemIds: ReadonlySet<string>,
) {
  return {
    templateId: entry.templateId,
    bundleItemId: resolveBundleItemId(entry.templateId, liveBundleItemIds),
    templateContentHash: declinedTemplateContentHash,
    templateSchemaVersion: entry.templateSchemaVersion ?? 1,
    writtenContent: kept.content,
    lastObservedDiskHash: kept.hash,
    userModified: true,
  };
}

const keptRefusal = (diskPath: string) =>
  `kept ${diskPath}: it does not hold what Haive wrote there, so delete it by hand if it should go`;

/** `content` is what a removal took: the file, or the rules region with its markers. */
export type Removal =
  | { outcome: 'removed'; content: string }
  | { outcome: 'absent' }
  | { outcome: 'kept'; refusal: string };

/** Remove the file at `rel`, or the rules region alone, only while it holds `writtenHash`, judged on
 *  the bytes removed: a row alone proves nothing, since 12 records one for a file 07 skipped. */
export async function removeIfHaives(
  repoPath: string,
  rel: string,
  entry: { diskPath: string; templateKind: string; fileCreated?: boolean },
  writtenHash: string | null | undefined,
): Promise<Removal> {
  const haives = (text: string) => sha256Hex(normalizeContent(text)) === writtenHash;
  const kept: Removal = { outcome: 'kept', refusal: keptRefusal(entry.diskPath) };
  try {
    let content = '';
    if (entry.templateKind !== CLI_RULES_TEMPLATE_KIND) {
      const result = await removeFileIfNoFollow(repoPath, rel, (data) => {
        content = data.toString('utf8');
        return haives(content);
      });
      if (result === 'kept') return kept;
      return result === 'removed' ? { outcome: 'removed', content } : { outcome: 'absent' };
    }
    if (entry.fileCreated) {
      // A file created for the region goes whole while nothing but the region was written to it.
      const whole = await removeFileIfNoFollow(repoPath, rel, (data) => {
        const current = data.toString('utf8');
        const region = extractRegion(current, CLI_RULES_START, CLI_RULES_END);
        content = region ?? '';
        return (
          region !== null &&
          haives(region) &&
          upsertRegion(current, '', CLI_RULES_START, CLI_RULES_END).trim() === ''
        );
      });
      if (whole === 'removed') return { outcome: 'removed', content };
      if (whole === 'absent') return { outcome: 'absent' };
    }
    let noRegion = false;
    const result = await rewriteFileIfNoFollow(repoPath, rel, (data) => {
      const current = data.toString('utf8');
      const region = extractRegion(current, CLI_RULES_START, CLI_RULES_END);
      noRegion = region === null;
      if (region === null || !haives(region)) return null;
      content = region;
      return Buffer.from(upsertRegion(current, '', CLI_RULES_START, CLI_RULES_END), 'utf8');
    });
    if (result === 'rewritten') return { outcome: 'removed', content };
    return result === 'absent' || noRegion ? { outcome: 'absent' } : kept;
  } catch (err) {
    if (isPathContainmentError(err)) {
      if (['link', 'not-directory', 'not-regular-file'].includes(err.reason)) return kept;
    } else if (['ENOENT', 'ENOTDIR'].includes(errno(err) ?? '')) {
      return { outcome: 'absent' };
    }
    throw err;
  }
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
  'rtk-config': 'RTK token-saver',
};

function templateKindLabel(kind: string): string {
  return TEMPLATE_KIND_LABELS[kind] ?? kind;
}

/** Read a file, returning '' when it does not exist. Used by the cli-rules
 *  region writes so a missing AGENTS.md is treated as empty (upsertRegion then
 *  creates the region) rather than throwing.
 *
 *  Takes `(anchor, rel)` like every other repository read: `null` covers absence AND a refusal —
 *  a link, or a non-regular file — which both mean "nothing to merge into", exactly what the
 *  `catch` this replaces already concluded for an unreadable path. */
export async function readFileOrEmpty(anchor: string, rel: string): Promise<string> {
  return (await readTextNoFollow(anchor, rel)) ?? '';
}

/** `diskPath` reaches this step from a plan row — i.e. from the database — and is joined onto the
 *  repository root, so it is validated before it addresses anything.
 *
 *  A bad one is REPORTED and skipped rather than thrown. An upgrade must not fail wholesale because
 *  one row carries a path it should not, and `onboarding_artifacts` was EMPTY on the install this
 *  shipped from, so nothing measured what is actually out there; failing soft is the only honest
 *  default. It also matters that the apply branch below is not inside a `try` — a throw there would
 *  abort every remaining entry.
 *
 *  This validates the derived DISK PATH and never a template id: an id is a composite key that
 *  embeds a path (`plugin.drupal-php-lsp..claude/plugins/…`), which `toSafeRel` would accept while
 *  yielding nonsense, because its first segment contains `..` without BEING `..`. */
export function safeDiskRel(diskPath: string): string | null {
  let rel: string;
  try {
    rel = toSafeRel(diskPath);
  } catch {
    return null;
  }
  // `toSafeRel('')` is NOT an error: it drops empty segments and returns `''`, which addresses the
  // ANCHOR itself — legitimate for a read, never for one of these writes or deletes. Left to fall
  // through it would reach the primitives, which refuse it by throwing, in the one branch that has
  // no `try` around it.
  return rel === '' ? null : rel;
}

export interface UpgradeApplyOutput {
  appliedCount: number;
  skippedCount: number;
  deletedCount: number;
  warnings: string[];
  installManifestWritten: boolean;
  rulesImportStubs: RulesImportStubOutcome[];
  /** Every repository path this run wrote, for 03 to stage. Optional because it is read back
   *  from a persisted output that may predate it. */
  writtenPaths?: string[];
  /** Every repository path this run removed, for 03 to stage the removal. Optional likewise. */
  deletedPaths?: string[];
  /** Every path this run wrote where nothing stood (no file, or for the rules region no region),
   *  with the live row it retired there, so a rollback puts the absence back. Optional likewise. */
  createdPaths?: CreatedPath[];
  /** Every row this run retired or kept as a baseline: the only rows a rollback of it restores. */
  retiredRowIds?: string[];
  /** Every path whose file, or rules region, this run removed. Each has a baseline among
   *  `retiredRowIds` holding what it removed, so a rollback puts it back. Optional likewise. */
  removedPaths?: string[];
}

/** What a row records about the bytes at its path. */
interface ArtifactRecord {
  templateContentHash: string;
  writtenHash: string;
  writtenContent: string;
  lastObservedDiskHash: string | null;
  userModified: boolean;
}

export interface CreatedPath {
  diskPath: string;
  /** Whether the file itself was missing, which for the rules region is more than the region. */
  fileCreated: boolean;
  retiredRowId: string | null;
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
        description: c.liveArtifactId
          ? 'Your copy differs from the prior baseline AND the template changed. Pick one.'
          : 'Haive has no record of writing this file, and it differs from the template. Pick one.',
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
    const strippable = obsolete.flatMap((e) => {
      const stripped = rtkHookStripPreview(e);
      return stripped === null ? [] : [{ entry: e, stripped }];
    });
    const removable = obsolete.filter((e) => !strippable.some((s) => s.entry === e));
    if (removable.length > 0) {
      fields.push({
        type: 'multi-select',
        id: 'selectedObsoleteRemovals',
        label: 'Delete obsolete files',
        description: `${removable.length} artifact(s) Haive no longer manages. Select to remove from disk.`,
        options: toOptions(removable),
        defaults: [],
      });
    }
    if (strippable.length > 0) {
      fields.push({
        type: 'multi-select',
        id: 'selectedRtkHookStrips',
        label: 'Remove the RTK hook from settings files you edited',
        description:
          `${strippable.length} RTK settings file(s) Haive no longer manages still hold its hook, ` +
          'and your edits keep them from being deleted. Select one to take out the RTK hook alone; ' +
          'the rest of the file stays.',
        options: strippable.map(({ entry, stripped }) => ({
          value: entry.entryId,
          label: entry.diskPath,
          group: templateKindLabel(entry.templateKind),
          details: {
            kind: 'diff' as const,
            baseline: entry.currentContent,
            current: stripped,
            editable: false,
          },
        })),
        defaults: [],
      });
    }
    const missingImports = detected.missingRulesImports ?? [];
    if (missingImports.length > 0) {
      fields.push({
        type: 'note',
        id: 'rulesImportNote',
        label: 'Restores the AGENTS.md import',
        body:
          `${missingImports.map((f) => `\`${f}\``).join(', ')} will get an \`@AGENTS.md\` line, ` +
          'so its CLI loads AGENTS.md and the rules in it.',
        variant: 'info',
      });
    }
    const rtkBlocks = detected.rtkBlockLeftovers ?? [];
    if (rtkBlocks.length > 0) {
      fields.push({
        type: 'note',
        id: 'rtkBlockNote',
        label: 'Takes out the RTK block',
        body:
          'RTK is switched off for this repository, so the RTK block comes out of ' +
          `${rtkBlocks.map((f) => `\`${f}\``).join(', ')}.`,
        variant: 'info',
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

    // The form parks between the plan and this apply, and RTK switched meanwhile leaves the plan's
    // RTK actions pointing the wrong way.
    const plannedRtk = plan.renderCtxSnapshot.rtkEnabled;
    if (plan.rtkFollowsLive === true && typeof plannedRtk === 'boolean') {
      const [repo] = await ctx.db
        .select({ rtkEnabled: schema.repositories.rtkEnabled })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, plan.repositoryId))
        .limit(1);
      if (repo && repo.rtkEnabled !== plannedRtk) {
        throw new Error(
          `RTK was switched ${repo.rtkEnabled ? 'on' : 'off'} after this upgrade was planned, so ` +
            'its plan no longer holds. Retry the plan step to plan the upgrade again.',
        );
      }
    }
    const manifest = getTemplateManifest();
    const haiveVersion = getHaiveVersion();

    const selectedUpdates = new Set<string>(toStringArray(values.selectedUpdates));
    const selectedNew = new Set<string>(toStringArray(values.selectedNew));
    const selectedReinstate = new Set<string>(toStringArray(values.selectedReinstate));
    const selectedObsoleteRemovals = new Set<string>(
      toStringArray(values.selectedObsoleteRemovals),
    );
    const selectedRtkHookStrips = new Set<string>(toStringArray(values.selectedRtkHookStrips));

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
    const writtenPaths: string[] = [];
    const deletedPaths: string[] = [];
    const created: Omit<CreatedPath, 'retiredRowId'>[] = [];
    const removedPaths: string[] = [];

    const rowsToSupersede: string[] = [];
    const rowsToInsert: (typeof schema.onboardingArtifacts.$inferInsert)[] = [];
    // Superseded baselines for what a written path with no row already held.
    const baselineRows: (typeof schema.onboardingArtifacts.$inferInsert)[] = [];
    // Live rows whose conflict was answered "Keep my edits", moved to the version declined.
    const keptInPlace: { id: string; update: ReturnType<typeof keptRowUpdate> }[] = [];
    // Baselines of what a removal took, each written before the removal it records.
    const removalRecords: string[] = [];
    const earlierRemovals = new Map<string, string>();
    for (const r of await ctx.db
      .select({
        id: schema.onboardingArtifacts.id,
        diskPath: schema.onboardingArtifacts.diskPath,
        templateId: schema.onboardingArtifacts.templateId,
      })
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.taskId, ctx.taskId),
          eq(schema.onboardingArtifacts.sourceStepId, '02-upgrade-apply'),
          eq(schema.onboardingArtifacts.source, 'backfill'),
          isNotNull(schema.onboardingArtifacts.supersededAt),
        ),
      )) {
      earlierRemovals.set(`${r.templateId}\n${r.diskPath}`, r.id);
    }

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
      selectedRtkHookStrips,
      conflictChoices,
    };

    for (const entry of plan.entries) {
      const action = classifyApplyAction(entry, plan.entries, selections);
      const artifactRow = (record: ArtifactRecord, source: 'upgrade' | 'backfill') => ({
        userId: ctx.userId,
        repositoryId: plan.repositoryId,
        taskId: ctx.taskId,
        diskPath: entry.diskPath,
        templateId: entry.templateId,
        templateKind: entry.templateKind,
        templateSchemaVersion: entry.templateSchemaVersion ?? 1,
        ...record,
        formValuesSnapshot: plan.renderCtxSnapshot,
        sourceStepId: '02-upgrade-apply',
        source,
        haiveVersion,
        bundleItemId: resolveBundleItemId(entry.templateId, liveBundleItemIds),
      });
      // What a path holds that its row does not record (no row, or bytes edited since) is kept as
      // a superseded baseline before it is replaced, so a rollback of this upgrade restores it.
      const baseline = (prior: ArtifactRecord) => baselineRows.push(artifactRow(prior, 'backfill'));

      if (action === 'skip') {
        skippedCount += 1;
        continue;
      }

      if (action === 'keep') {
        // A decision, not a write: the version declined is recorded against the bytes kept, so
        // the next upgrade offers only a newer one. An untracked path gets a row claiming nothing.
        skippedCount += 1;
        const rel = safeDiskRel(entry.diskPath);
        let kept: { content: string; hash: string } | null = null;
        try {
          kept = rel === null ? null : await pathContent(ctx.repoPath, rel, entry.templateKind);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`did not record keeping ${entry.diskPath}: ${msg}`);
          continue;
        }
        if (kept === null || !entry.currentTemplateContentHash || !entry.newContentHash) continue;
        if (entry.liveArtifactId) {
          keptInPlace.push({
            id: entry.liveArtifactId,
            update: keptRowUpdate(entry, entry.currentTemplateContentHash, kept, liveBundleItemIds),
          });
          continue;
        }
        rowsToInsert.push({
          userId: ctx.userId,
          repositoryId: plan.repositoryId,
          taskId: ctx.taskId,
          diskPath: entry.diskPath,
          templateId: entry.templateId,
          templateKind: entry.templateKind,
          templateSchemaVersion: entry.templateSchemaVersion ?? 1,
          templateContentHash: entry.currentTemplateContentHash,
          writtenHash: entry.newContentHash,
          writtenContent: kept.content,
          lastObservedDiskHash: kept.hash,
          userModified: true,
          formValuesSnapshot: plan.renderCtxSnapshot,
          sourceStepId: '02-upgrade-apply',
          source: 'backfill' as const,
          haiveVersion,
          bundleItemId: resolveBundleItemId(entry.templateId, liveBundleItemIds),
        });
        continue;
      }

      if (action === 'untrack' && entry.liveArtifactId) {
        rowsToSupersede.push(entry.liveArtifactId);
        skippedCount += 1;
        continue;
      }

      if (action === 'delete') {
        const rel = safeDiskRel(entry.diskPath);
        if (rel === null) {
          warnings.push(`refusing to delete ${entry.diskPath}: not a path inside the repository`);
          skippedCount += 1;
          continue;
        }
        // What a removal takes is recorded before it runs, so a rollback of this upgrade can put it
        // back, and so a retry that finds the path gone can tell its own removal from a person's.
        const recordRemoval = async (content: string) => {
          const now = new Date();
          const [row] = await ctx.db
            .insert(schema.onboardingArtifacts)
            .values({
              ...artifactRow(
                backfillRecord(
                  {
                    templateContentHash: entry.baselineTemplateContentHash ?? '',
                    writtenHash: entry.baselineWrittenHash ?? '',
                  },
                  { content, hash: sha256Hex(normalizeContent(content)) },
                ),
                'backfill',
              ),
              supersededAt: now,
              updatedAt: now,
            })
            .returning({ id: schema.onboardingArtifacts.id });
          return row!.id;
        };
        const dropRecord = async (id: string) => {
          await ctx.db
            .delete(schema.onboardingArtifacts)
            .where(eq(schema.onboardingArtifacts.id, id));
        };
        const earlier = earlierRemovals.get(`${entry.templateId}\n${entry.diskPath}`) ?? null;
        const planned =
          entry.currentContent !== null && entry.currentHash === entry.baselineWrittenHash
            ? entry.currentContent
            : null;
        let recorded: string | null = null;
        try {
          recorded = earlier ?? (planned === null ? null : await recordRemoval(planned));
          const removal = await removeIfHaives(ctx.repoPath, rel, entry, entry.baselineWrittenHash);
          if (removal.outcome === 'kept') {
            if (recorded !== null) await dropRecord(recorded);
            warnings.push(removal.refusal);
            skippedCount += 1;
            continue;
          }
          if (entry.templateKind !== CLI_RULES_TEMPLATE_KIND) deletedPaths.push(rel);
          else if (removal.outcome === 'removed') writtenPaths.push(rel);
          if (entry.liveArtifactId) rowsToSupersede.push(entry.liveArtifactId);
          if (removal.outcome === 'removed') {
            const id = recorded ?? (await recordRemoval(removal.content));
            if (recorded !== null && removal.content !== planned) {
              await ctx.db
                .update(schema.onboardingArtifacts)
                .set({ writtenContent: removal.content })
                .where(eq(schema.onboardingArtifacts.id, id));
            }
            removalRecords.push(id);
            removedPaths.push(entry.diskPath);
          } else if (earlier !== null) {
            // Gone with an earlier attempt's record standing: that attempt removed it.
            removalRecords.push(earlier);
            removedPaths.push(entry.diskPath);
          } else if (recorded !== null) {
            // Gone before this step ran, so there is nothing of the upgrade's to put back.
            await dropRecord(recorded);
          }
          deletedCount += 1;
        } catch (err) {
          if (recorded !== null && recorded !== earlier) {
            await dropRecord(recorded).catch((dropErr: unknown) =>
              ctx.logger.warn({ err: dropErr, diskPath: entry.diskPath }, 'removal record left'),
            );
          }
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`failed to delete ${entry.diskPath}: ${msg}`);
        }
        continue;
      }

      if (action === 'strip') {
        const rel = safeDiskRel(entry.diskPath);
        if (rel === null) {
          warnings.push(`refusing to edit ${entry.diskPath}: not a path inside the repository`);
          skippedCount += 1;
          continue;
        }
        // Taken from the bytes it replaces, so a save since the plan keeps its edits too.
        const edit: { before?: string; after?: string; notUtf8?: boolean } = {};
        try {
          await rewriteFileIfNoFollow(ctx.repoPath, rel, (data) => {
            const before = data.toString('utf8');
            // A byte that is not UTF-8 decodes to U+FFFD, which would be written back in its place.
            if (!Buffer.from(before, 'utf8').equals(data)) {
              edit.notUtf8 = true;
              return null;
            }
            const after = withoutRtkHookEntry(entry.templateId, before);
            if (after === null) {
              // An earlier attempt that edited the file and then failed left what the plan's bytes
              // strip to, and the plan still holds what stood there before it.
              const planned = entry.currentContent;
              if (planned !== null && withoutRtkHookEntry(entry.templateId, planned) === before) {
                edit.before = planned;
                edit.after = before;
              }
              return null;
            }
            edit.before = before;
            edit.after = after;
            return Buffer.from(after, 'utf8');
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`failed to remove the RTK hook from ${entry.diskPath}: ${msg}`);
          skippedCount += 1;
          continue;
        }
        if (edit.notUtf8) {
          warnings.push(
            `did not remove the RTK hook from ${entry.diskPath}: it is not valid UTF-8, so writing it back would change more than the hook`,
          );
          skippedCount += 1;
          continue;
        }
        if (edit.before === undefined || edit.after === undefined) {
          warnings.push(
            `did not remove the RTK hook from ${entry.diskPath}: it no longer holds one`,
          );
          skippedCount += 1;
          continue;
        }
        // Both the bytes it held and the bytes it holds now are the person's, so neither row claims
        // them: `writtenHash` stays the render's.
        const recorded = {
          templateContentHash: entry.baselineTemplateContentHash ?? '',
          writtenHash: entry.baselineWrittenHash ?? '',
        };
        const record = (content: string) =>
          backfillRecord(recorded, { content, hash: sha256Hex(normalizeContent(content)) });
        baseline(record(edit.before));
        rowsToInsert.push(artifactRow(record(edit.after), 'upgrade'));
        if (entry.liveArtifactId) rowsToSupersede.push(entry.liveArtifactId);
        writtenPaths.push(rel);
        appliedCount += 1;
        continue;
      }

      if (!entry.newContent) {
        warnings.push(`entry ${entry.diskPath} has no newContent; skipping`);
        skippedCount += 1;
        continue;
      }

      // Validated before anything is written, and a refusal skips this entry rather than throwing:
      // this branch is NOT inside a `try`, so a throw here would abort every remaining entry.
      const rel = safeDiskRel(entry.diskPath);
      if (rel === null) {
        warnings.push(`refusing to write ${entry.diskPath}: not a path inside the repository`);
        skippedCount += 1;
        continue;
      }
      if (entry.templateKind === CLI_RULES_TEMPLATE_KIND) {
        // Merge the new block into the existing AGENTS.md in place, replacing
        // only the cli-rules region and leaving every other region untouched.
        const onDisk = await readTextNoFollow(ctx.repoPath, rel);
        const existing = onDisk ?? '';
        const priorRegion = extractRegion(existing, CLI_RULES_START, CLI_RULES_END);
        if (priorRegion === null) {
          created.push({ diskPath: entry.diskPath, fileCreated: onDisk === null });
        }
        if (
          priorRegion &&
          (entry.liveArtifactId === null ||
            sha256Hex(normalizeContent(priorRegion)) !== entry.baselineWrittenHash)
        ) {
          const prior = cliRulesRegionRecord(
            priorRegion,
            entry.newContent,
            await loadCliRulesRenderHashes(ctx.db, plan.repositoryId),
          );
          baseline({
            templateContentHash: prior.templateContentHash,
            writtenHash: prior.writtenHash,
            writtenContent: prior.content,
            lastObservedDiskHash: prior.templateContentHash,
            userModified: !prior.haiveWritten,
          });
        }
        await writeFileNoFollow(
          ctx.repoPath,
          rel,
          upsertRegion(existing, entry.newContent, CLI_RULES_START, CLI_RULES_END),
          { createParents: true },
        );
      } else {
        const existing = await readTextNoFollow(ctx.repoPath, rel);
        if (existing === null) {
          created.push({ diskPath: entry.diskPath, fileCreated: true });
        } else {
          const renderHash = sha256Hex(normalizeContent(entry.newContent));
          const existingHash = sha256Hex(normalizeContent(existing));
          const unrecorded =
            entry.liveArtifactId === null
              ? existingHash !== renderHash
              : existingHash !== entry.baselineWrittenHash;
          if (unrecorded) {
            baseline(
              backfillRecord(
                {
                  templateContentHash: entry.currentTemplateContentHash ?? '',
                  writtenHash: renderHash,
                },
                { content: existing, hash: existingHash },
              ),
            );
          }
        }
        await writeFileNoFollow(ctx.repoPath, rel, entry.newContent, { createParents: true });
      }
      writtenPaths.push(rel);
      appliedCount += 1;

      if (entry.liveArtifactId) rowsToSupersede.push(entry.liveArtifactId);

      const writtenHash = sha256Hex(normalizeContent(entry.newContent));
      rowsToInsert.push(
        artifactRow(
          {
            templateContentHash: entry.currentTemplateContentHash ?? '',
            writtenHash,
            writtenContent: entry.newContent,
            lastObservedDiskHash: writtenHash,
            userModified: false,
          },
          'upgrade',
        ),
      );
    }

    // Not an artifact, but without its `@AGENTS.md` line a claude-family CLI never loads AGENTS.md.
    const rulesImportStubs = await restoreRulesImportStubs(
      ctx.repoPath,
      await enabledImportRulesFiles(ctx.db, ctx.userId),
    );
    for (const stub of rulesImportStubs) {
      if (stub.result === 'created' || stub.result === 'appended') writtenPaths.push(stub.file);
      if (stub.result === 'refused') {
        warnings.push(`did not restore the @AGENTS.md import in ${stub.file}: ${stub.error}`);
      }
    }

    // The RTK block is no manifest item, so no obsolete entry takes it out once RTK is off.
    if (plan.renderCtxSnapshot.rtkEnabled === false) {
      for (const strip of await stripRtkBlocks(ctx.repoPath)) {
        if (strip.result === 'stripped') writtenPaths.push(strip.file);
        if (strip.result === 'refused') {
          warnings.push(`could not check ${strip.file} for an RTK block: ${strip.error}`);
        }
      }
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
    const retiredShape = {
      id: schema.onboardingArtifacts.id,
      diskPath: schema.onboardingArtifacts.diskPath,
    };
    const retired: { id: string; diskPath: string }[] = [];
    const baselineIds: string[] = [];
    if (
      rowsToSupersede.length > 0 ||
      insertPaths.length > 0 ||
      baselineRows.length > 0 ||
      keptInPlace.length > 0 ||
      removalRecords.length > 0
    ) {
      await ctx.db.transaction(async (tx) => {
        const now = new Date();
        if (removalRecords.length > 0) {
          // Retired in the instant the row at their path is, so the rollback takes the baseline.
          await tx
            .update(schema.onboardingArtifacts)
            .set({ supersededAt: now, updatedAt: now })
            .where(inArray(schema.onboardingArtifacts.id, removalRecords));
        }
        if (rowsToSupersede.length > 0) {
          retired.push(
            ...(await tx
              .update(schema.onboardingArtifacts)
              .set({ supersededAt: now, updatedAt: now })
              .where(
                and(
                  inArray(schema.onboardingArtifacts.id, rowsToSupersede),
                  isNull(schema.onboardingArtifacts.supersededAt),
                ),
              )
              .returning(retiredShape)),
          );
        }
        if (insertPaths.length > 0) {
          retired.push(
            ...(await tx
              .update(schema.onboardingArtifacts)
              .set({ supersededAt: now, updatedAt: now })
              .where(
                and(
                  eq(schema.onboardingArtifacts.repositoryId, plan.repositoryId),
                  inArray(schema.onboardingArtifacts.diskPath, insertPaths),
                  isNull(schema.onboardingArtifacts.supersededAt),
                ),
              )
              .returning(retiredShape)),
          );
        }
        for (const k of keptInPlace) {
          await tx
            .update(schema.onboardingArtifacts)
            .set({ ...k.update, updatedAt: now })
            .where(
              and(
                eq(schema.onboardingArtifacts.id, k.id),
                isNull(schema.onboardingArtifacts.supersededAt),
              ),
            );
        }
        if (baselineRows.length > 0) {
          // Insert as already-superseded so the live upgrade row is the only
          // non-superseded row at this diskPath (the partial unique index holds)
          // while rollback can still find this as the prior baseline to restore.
          const inserted = await tx
            .insert(schema.onboardingArtifacts)
            .values(baselineRows.map((r) => ({ ...r, supersededAt: now, updatedAt: now })))
            .returning({ id: schema.onboardingArtifacts.id });
          baselineIds.push(...inserted.map((r) => r.id));
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
    const skillTargets = await resolveSkillTargetDirs(ctx.db, ctx.userId);
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
      rulesImportStubs,
      writtenPaths,
      deletedPaths,
      createdPaths: created.map((c) => ({
        ...c,
        retiredRowId: retired.find((r) => r.diskPath === c.diskPath)?.id ?? null,
      })),
      retiredRowIds: [...retired.map((r) => r.id), ...baselineIds, ...removalRecords],
      removedPaths,
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

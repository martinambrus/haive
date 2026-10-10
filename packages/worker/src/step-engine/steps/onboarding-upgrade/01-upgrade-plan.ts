import { readUpgradeFile, rtkBlockFiles, type UnreadReason } from '@haive/shared/rules-files';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_PROVIDER_LIST,
  CLI_RULES_TEMPLATE_KIND,
  extractRegion,
  getHaiveVersion,
  holdsRtkSettings,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import { rtkLeftoversToRemove } from '@haive/shared/project-state';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import {
  expandManifestFor,
  getTemplateManifest,
  updateApplicableTemplateIds,
  type ExpandedRendering,
  type TemplateRenderContext,
} from '../../template-manifest.js';
import { extractBundleItemId } from '../../_custom-bundle-loader.js';
import {
  loadLiveArtifacts,
  pickRenderSnapshot,
  resolveRenderContext,
  unionExpandedFor,
  type LiveArtifactRow,
} from '../../_upgrade-render.js';
import {
  cliRulesRegionRecord,
  enabledImportRulesFiles,
  loadCliRulesRenderHashes,
  missingRulesImportStubs,
  readAgentsRulesRegion,
} from '../onboarding/_rules-files.js';
import { computeLineDelta } from './_diff.js';

export { loadLiveArtifacts, pickRenderSnapshot, type LiveArtifactRow };

export type UpgradePlanBucket =
  | 'unchanged'
  | 'clean_update'
  | 'adopt'
  | 'conflict'
  | 'new_artifact'
  | 'user_deleted'
  | 'obsolete';

export interface UpgradePlanEntry {
  /** Stable per-row identifier used by step 02's form to refer to this entry. */
  entryId: string;
  bucket: UpgradePlanBucket;
  templateId: string;
  templateKind: string;
  diskPath: string;
  /** Prior live row id (if any). Null for `new_artifact`. */
  liveArtifactId: string | null;
  /** Contents currently on disk (null if missing). */
  currentContent: string | null;
  /** Contents a fresh render would produce (null if template is obsolete). */
  newContent: string | null;
  /** Baseline content from when this artifact was last written. Null for
   *  `new_artifact` (no baseline exists yet). */
  baselineContent: string | null;
  /** Hash of content currently on disk; null if file is missing. */
  currentHash: string | null;
  /** Hash recorded the last time Haive wrote this artifact. */
  baselineWrittenHash: string | null;
  /** Content hash the fresh render would produce. Null for obsolete rows. */
  newContentHash: string | null;
  /** Template content hash recorded when the live row was written. */
  baselineTemplateContentHash: string | null;
  /** Content hash of the manifest item for this template at current code. */
  currentTemplateContentHash: string | null;
  templateSchemaVersion: number | null;
  delta: { added: number; removed: number } | null;
  /** Set when the plan did not read the path, which no action is then offered on: its hash is
   *  `UNREAD_HASH`, and its content is withheld. */
  unread?: UnreadReason;
}

/** The hash of a path the plan did not read, which matches no record and never reads as absent. */
export const UNREAD_HASH = 'unread';

export interface UpgradePlanDetect {
  repositoryId: string;
  ranBackfill: boolean;
  entries: UpgradePlanEntry[];
  counts: Record<UpgradePlanBucket, number>;
  installedTemplateSetHash: string | null;
  currentTemplateSetHash: string;
  /** Opaque render-context snapshot (shape = TemplateRenderContext). Persisted
   *  onto every new onboarding_artifacts row the upgrade-apply step writes so
   *  future upgrades/rollbacks can reconstruct rendering without this task. */
  renderCtxSnapshot: Record<string, unknown>;
  /** Whether `renderCtxSnapshot.rtkEnabled` is the repository's live choice, which 02 checks again
   *  before it applies. A value synthesized for a context from before RTK is not. Optional:
   *  persisted plans predate it. */
  rtkFollowsLive?: boolean;
  /** Import-mode rules files lacking `@AGENTS.md`, which 02 restores. Optional: persisted plans
   *  predate it. */
  missingRulesImports?: string[];
  /** Rules files holding the RTK block of a repository that switched RTK off, which 02 takes it
   *  out of. Optional: persisted plans predate it. */
  rtkBlockLeftovers?: string[];
}

export interface UpgradePlanOutput extends UpgradePlanDetect {
  backfilledRows: number;
}

async function requireRepositoryId(ctx: StepContext): Promise<string> {
  const row = await ctx.db
    .select({ repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, ctx.taskId))
    .limit(1);
  const repoId = row[0]?.repositoryId ?? null;
  if (!repoId) throw new Error('upgrade-plan: task has no repository_id');
  return repoId;
}

export async function readDiskContent(
  repoPath: string,
  diskPath: string,
): Promise<{ content: string | null; hash: string | null; unread?: UnreadReason }> {
  const read = await readUpgradeFile(repoPath, diskPath);
  if (read.kind === 'absent') return { content: null, hash: null };
  if (read.kind === 'unread') return { content: null, hash: UNREAD_HASH, unread: read.reason };
  return { content: read.text, hash: sha256Hex(normalizeContent(read.text)) };
}

/** What a backfill records for one rendering. The bytes on disk, edited or not, so a rollback
 *  restores what was there; the render's hash, so an edited file is never taken as Haive's; and
 *  for an edited file its own hash as the template's, so the template reads as not installed. */
export function backfillRecord(
  r: Pick<ExpandedRendering, 'templateContentHash' | 'writtenHash'>,
  disk: { content: string; hash: string },
): {
  templateContentHash: string;
  writtenHash: string;
  writtenContent: string;
  lastObservedDiskHash: string;
  userModified: boolean;
} {
  const editedHash = disk.hash !== r.writtenHash ? disk.hash : null;
  return {
    templateContentHash: editedHash ?? r.templateContentHash,
    writtenHash: r.writtenHash,
    writtenContent: disk.content,
    lastObservedDiskHash: disk.hash,
    userModified: editedHash !== null,
  };
}

export function classifyEntry(args: {
  live: LiveArtifactRow | null;
  current: ExpandedRendering | null;
  diskHash: string | null;
  /** Hashes of what Haive rendered at this path before; a file holding one is Haive's to replace. */
  recordedRenderHashes?: ReadonlySet<string>;
}): UpgradePlanBucket {
  const { live, current, diskHash } = args;

  if (live && !current) return 'obsolete';
  if (!live && current) {
    // A file already there that no render accounts for is somebody's, so it is offered, never
    // pre-selected for overwriting.
    const haiveBytes =
      diskHash === null ||
      diskHash === current.writtenHash ||
      (args.recordedRenderHashes?.has(diskHash) ?? false);
    return haiveBytes ? 'new_artifact' : 'conflict';
  }
  if (!live || !current) throw new Error('classifyEntry: both live and current null');

  if (diskHash === null) return 'user_deleted';

  const templateUnchanged =
    live.templateSchemaVersion === current.templateSchemaVersion &&
    live.templateContentHash === current.templateContentHash;
  const diskMatchesBaseline = diskHash === live.writtenHash;
  // For custom items, a templateId mismatch means the live row references a
  // bundle item that has since been replaced (e.g. ZIP re-uploaded → old
  // items deleted, new ones created with fresh UUIDs). Even when content is
  // byte-identical, we need apply to rewrite the artifact row so its
  // templateId/bundle_item_id realigns with the live bundle item — otherwise
  // upgrade-status keeps reporting drift forever.
  const customTemplateIdShifted =
    live.templateId !== current.templateId &&
    (live.templateId.startsWith('custom.') || current.templateId.startsWith('custom.'));

  if (templateUnchanged && !customTemplateIdShifted) return 'unchanged';
  if (diskMatchesBaseline) return 'clean_update';
  // The file already holds what this upgrade would write, such as one another install upgraded.
  if (diskHash === current.writtenHash) return 'adopt';
  return 'conflict';
}

export class RenderContextUnresolvedError extends Error {}

/** The context a row records: without `rtkEnabled` unless that is the repository's live choice. */
export function recordableContext<T extends object>(context: T, rtkFollowsLive: boolean): T {
  if (rtkFollowsLive) return context;
  const { rtkEnabled: _unrecorded, ...rest } = context as T & { rtkEnabled?: unknown };
  return rest as T;
}

export const upgradePlanStep: StepDefinition<UpgradePlanDetect, UpgradePlanOutput> = {
  metadata: {
    id: '01-upgrade-plan',
    workflowType: 'onboarding_upgrade',
    index: 1,
    title: 'Plan upgrade',
    description: 'Scans installed artifacts, computes diffs and buckets them for selection.',
    requiresCli: false,
  },

  async shouldRun(ctx) {
    const { shouldRunUpgrade } = await import('./04-upgrade-rollback.js');
    return shouldRunUpgrade(ctx);
  },

  async detect(ctx): Promise<UpgradePlanDetect> {
    const repositoryId = await requireRepositoryId(ctx);
    const manifest = getTemplateManifest();
    const liveRows = await loadLiveArtifacts(ctx.db, repositoryId);
    const resolved = await resolveRenderContext(ctx.db, {
      repositoryId,
      userId: ctx.userId,
      liveRows,
      logger: ctx.logger,
    });
    if (!resolved) {
      throw new RenderContextUnresolvedError(
        'upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
      );
    }
    const { renderCtx } = resolved;

    const expanded = await unionExpandedFor(ctx.db, {
      repositoryId,
      userId: ctx.userId,
      renderCtx,
      logger: ctx.logger,
    });
    const installedTemplateSetHash =
      liveRows.length > 0 ? computeInstalledSetHashFromRows(liveRows) : null;

    const byPath = new Map<string, ExpandedRendering>();
    for (const r of expanded) byPath.set(r.diskPath, r);
    const liveByPath = new Map<string, LiveArtifactRow>();
    for (const r of liveRows) liveByPath.set(r.diskPath, r);

    const allPaths = new Set<string>([...byPath.keys(), ...liveByPath.keys()]);
    const entries: UpgradePlanEntry[] = [];
    let counterByBucket = 0;
    const cliRulesRenderHashes = await loadCliRulesRenderHashes(ctx.db, repositoryId);

    for (const diskPath of allPaths) {
      const current = byPath.get(diskPath) ?? null;
      const live = liveByPath.get(diskPath) ?? null;
      const disk = await readDiskContent(ctx.repoPath, diskPath);
      // The cli-rules artifact owns only the marker-delimited region inside
      // AGENTS.md, not the whole file. Compare and diff against just that region
      // so the project-info + RTK regions and any user content stay out of scope.
      const isCliRules = (current?.templateKind ?? live?.templateKind) === CLI_RULES_TEMPLATE_KIND;
      let diskContent = disk.content;
      let diskHash = disk.hash;
      if (isCliRules && disk.unread === undefined) {
        const region = disk.content
          ? extractRegion(disk.content, CLI_RULES_START, CLI_RULES_END)
          : null;
        // Normalize so the on-disk region (extractRegion drops the trailing
        // newline) and the rendered block (buildCliRulesBlock keeps one) compare
        // and diff cleanly — otherwise the end marker churns in the UI diff.
        diskContent = region ? normalizeContent(region) : null;
        diskHash = diskContent ? sha256Hex(diskContent) : null;
      }

      const bucket = classifyEntry({
        live,
        current,
        diskHash,
        recordedRenderHashes: isCliRules ? cliRulesRenderHashes : undefined,
      });
      let newContent = current?.content ?? null;
      if (isCliRules && newContent) newContent = normalizeContent(newContent);
      const baselineContent = live && current && diskHash === live.writtenHash ? diskContent : null;
      const delta =
        newContent && !disk.unread ? computeLineDelta(diskContent ?? '', newContent) : null;

      entries.push({
        entryId: `e${counterByBucket++}:${diskPath}`,
        bucket,
        templateId: current?.templateId ?? live?.templateId ?? 'unknown',
        templateKind: current?.templateKind ?? live?.templateKind ?? 'unknown',
        diskPath,
        liveArtifactId: live?.id ?? null,
        currentContent: diskContent,
        newContent,
        baselineContent,
        currentHash: diskHash,
        baselineWrittenHash: live?.writtenHash ?? null,
        newContentHash: current?.writtenHash ?? null,
        baselineTemplateContentHash: live?.templateContentHash ?? null,
        currentTemplateContentHash: current?.templateContentHash ?? null,
        templateSchemaVersion:
          current?.templateSchemaVersion ?? live?.templateSchemaVersion ?? null,
        delta,
        ...(disk.unread ? { unread: disk.unread } : {}),
      });
    }

    // Nothing records the RTK settings files a blank scaffold seeds, or the ones of a repository with
    // no rows at all, so with RTK now off they are found by rendering them as if it were on, for every
    // CLI: the scaffold seeded them for the ones enabled then, which may not be the ones enabled now.
    let unrecordedRtk: ExpandedRendering[] = [];
    if (rtkLeftoversToRemove(resolved.rtkLive, renderCtx.rtkEnabled)) {
      const [repo] = await ctx.db
        .select({ source: schema.repositories.source })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, repositoryId))
        .limit(1);
      if (liveRows.length === 0 || repo?.source === 'blank') {
        const everyCli = CLI_PROVIDER_LIST.map((p) => ({
          name: p.name,
          rulesFile: p.rulesFile,
          rulesFileMode: p.rulesFileMode,
        }));
        unrecordedRtk = expandManifestFor(
          { ...renderCtx, rtkEnabled: true, enabledCliProviders: everyCli },
          manifest,
        ).filter(
          (r) =>
            r.templateKind === 'rtk-config' &&
            !byPath.has(r.diskPath) &&
            !liveByPath.has(r.diskPath),
        );
      }
    }
    for (const r of unrecordedRtk) {
      const disk = await readDiskContent(ctx.repoPath, r.diskPath);
      if (disk.content === null || disk.hash === null) continue;
      if (!holdsRtkSettings(r.templateId, disk.content)) continue;
      const holdsRender = disk.hash === r.writtenHash;
      entries.push({
        entryId: `e${counterByBucket++}:${r.diskPath}`,
        bucket: 'obsolete',
        templateId: r.templateId,
        templateKind: r.templateKind,
        diskPath: r.diskPath,
        liveArtifactId: null,
        currentContent: disk.content,
        newContent: null,
        baselineContent: holdsRender ? disk.content : null,
        currentHash: disk.hash,
        baselineWrittenHash: r.writtenHash,
        newContentHash: null,
        baselineTemplateContentHash: r.templateContentHash,
        currentTemplateContentHash: null,
        templateSchemaVersion: r.templateSchemaVersion,
        delta: null,
      });
    }

    const counts: Record<UpgradePlanBucket, number> = {
      unchanged: 0,
      clean_update: 0,
      adopt: 0,
      conflict: 0,
      new_artifact: 0,
      user_deleted: 0,
      obsolete: 0,
    };
    for (const e of entries) counts[e.bucket] += 1;

    const ranBackfill = liveRows.length === 0;
    const missingRulesImports = await missingRulesImportStubs(
      ctx.repoPath,
      await enabledImportRulesFiles(ctx.db, ctx.userId),
    );
    const rtkBlockLeftovers = rtkLeftoversToRemove(resolved.rtkLive, renderCtx.rtkEnabled)
      ? await rtkBlockFiles(ctx.repoPath)
      : [];

    return {
      repositoryId,
      ranBackfill,
      entries,
      counts,
      installedTemplateSetHash,
      currentTemplateSetHash: manifest.setHash,
      renderCtxSnapshot: renderCtx as unknown as Record<string, unknown>,
      rtkFollowsLive: resolved.rtkLive,
      missingRulesImports,
      rtkBlockLeftovers,
    };
  },

  async apply(ctx, args): Promise<UpgradePlanOutput> {
    const detected = args.detected;
    let backfilledRows = 0;

    if (detected.ranBackfill) {
      const liveRows = await loadLiveArtifacts(ctx.db, detected.repositoryId);
      const resolved = await resolveRenderContext(ctx.db, {
        repositoryId: detected.repositoryId,
        userId: ctx.userId,
        liveRows,
        logger: ctx.logger,
      });
      if (!resolved) {
        throw new Error('upgrade-plan apply: render context unexpectedly missing during backfill');
      }
      const { renderCtx } = resolved;
      // A context that recorded no RTK choice must not record one through its rows.
      const snapshot = recordableContext(renderCtx, resolved.rtkLive);
      const expanded = await unionExpandedFor(ctx.db, {
        repositoryId: detected.repositoryId,
        userId: ctx.userId,
        renderCtx,
        logger: ctx.logger,
      });
      // An offered conflict stays unrecorded until 02 writes it: a row would belong to this upgrade
      // with no prior, which a rollback takes for a file the upgrade introduced and deletes.
      const offered = new Set(
        detected.entries.filter((e) => e.bucket === 'conflict').map((e) => e.diskPath),
      );

      const rowsToInsert: (typeof schema.onboardingArtifacts.$inferInsert)[] = [];
      const haiveVersion = getHaiveVersion();
      for (const r of expanded) {
        if (offered.has(r.diskPath)) continue;
        let recorded;
        if (r.templateKind === CLI_RULES_TEMPLATE_KIND) {
          // The region, never the whole file: a rollback writes this row's content into the region.
          const read = await readAgentsRulesRegion(ctx.repoPath);
          if ('unreadable' in read || read.region === null) continue;
          const record = cliRulesRegionRecord(
            read.region,
            r.content,
            await loadCliRulesRenderHashes(ctx.db, detected.repositoryId),
          );
          recorded = {
            templateContentHash: record.templateContentHash,
            writtenHash: record.writtenHash,
            writtenContent: record.content,
            lastObservedDiskHash: record.templateContentHash,
            userModified: !record.haiveWritten,
          };
        } else {
          // Nor for a file missing from disk: a rollback would restore a row here as what stood before.
          const disk = await readDiskContent(ctx.repoPath, r.diskPath);
          if (disk.content === null || disk.hash === null) continue;
          recorded = backfillRecord(r, { content: disk.content, hash: disk.hash });
        }
        rowsToInsert.push({
          userId: ctx.userId,
          repositoryId: detected.repositoryId,
          taskId: ctx.taskId,
          diskPath: r.diskPath,
          templateId: r.templateId,
          templateKind: r.templateKind,
          templateSchemaVersion: r.templateSchemaVersion,
          ...recorded,
          formValuesSnapshot: snapshot as unknown as Record<string, unknown>,
          sourceStepId: '01-upgrade-plan',
          source: 'backfill' as const,
          haiveVersion,
          bundleItemId: extractBundleItemId(r.templateId),
        });
      }
      if (rowsToInsert.length > 0) {
        await ctx.db.insert(schema.onboardingArtifacts).values(rowsToInsert);
        backfilledRows = rowsToInsert.length;
      }
      ctx.logger.info(
        { backfilledRows, repositoryId: detected.repositoryId },
        'upgrade-plan: lazy backfill complete',
      );
    }

    // Always refresh applicable_template_ids on plan, regardless of backfill,
    // so legacy repos onboarded before the column existed get populated on
    // their first upgrade attempt. Joins the manifest expansion with bundle
    // expansion so custom items show up in the per-repo applicable set.
    const applicableExpanded = await unionExpandedFor(ctx.db, {
      repositoryId: detected.repositoryId,
      userId: ctx.userId,
      renderCtx: detected.renderCtxSnapshot as unknown as TemplateRenderContext,
      logger: ctx.logger,
    });
    await updateApplicableTemplateIds(ctx.db, detected.repositoryId, applicableExpanded);

    return { ...detected, backfilledRows };
  },
};

function computeInstalledSetHashFromRows(rows: LiveArtifactRow[]): string {
  const parts = rows
    .slice()
    .sort((a, b) => a.templateId.localeCompare(b.templateId))
    .map((r) => `${r.templateId}:${r.templateSchemaVersion}:${r.templateContentHash}`)
    .join('\n');
  return sha256Hex(parts);
}

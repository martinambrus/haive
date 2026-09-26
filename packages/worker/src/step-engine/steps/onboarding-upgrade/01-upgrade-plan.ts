import { readTextNoFollow } from '@haive/shared/fs-safe';
import { rtkBlockFiles } from '@haive/shared/rules-files';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  buildCliRulesBlockFromProviders,
  CLI_RULES_DISK_PATH,
  CLI_RULES_END,
  CLI_RULES_SCHEMA_VERSION,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_ID,
  CLI_RULES_TEMPLATE_KIND,
  extractRegion,
  getCliProviderMetadata,
  getHaiveVersion,
  newestArtifactsFirst,
  normalizeContent,
  sha256Hex,
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
import {
  extractBundleItemId,
  loadBundlesForExpansion,
  type BundleWithMeta,
} from '../../_custom-bundle-loader.js';
import { resolveSkillTargetDirs } from '../onboarding/_helpers.js';
import {
  cliRulesRegionRecord,
  enabledImportRulesFiles,
  loadCliRulesRenderHashes,
  missingRulesImportStubs,
  readAgentsRulesRegion,
} from '../onboarding/_rules-files.js';
import type { GenerateFilesDetect } from '../onboarding/07-generate-files.js';
import { computeLineDelta } from './_diff.js';
import { buildBlankRenderContext } from '../../../repo/blank-scaffold.js';

export type UpgradePlanBucket =
  'unchanged' | 'clean_update' | 'conflict' | 'new_artifact' | 'user_deleted' | 'obsolete';

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
}

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

export interface LiveArtifactRow {
  id: string;
  diskPath: string;
  templateId: string;
  templateKind: string;
  templateContentHash: string;
  templateSchemaVersion: number;
  writtenHash: string;
  formValuesSnapshot: Record<string, unknown> | null;
  sourceStepId: string;
  bundleItemId: string | null;
  generatedAt: Date | null;
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

async function loadLiveArtifacts(
  ctx: StepContext,
  repositoryId: string,
): Promise<LiveArtifactRow[]> {
  const rows = await ctx.db
    .select({
      id: schema.onboardingArtifacts.id,
      diskPath: schema.onboardingArtifacts.diskPath,
      templateId: schema.onboardingArtifacts.templateId,
      templateKind: schema.onboardingArtifacts.templateKind,
      templateContentHash: schema.onboardingArtifacts.templateContentHash,
      templateSchemaVersion: schema.onboardingArtifacts.templateSchemaVersion,
      writtenHash: schema.onboardingArtifacts.writtenHash,
      formValuesSnapshot: schema.onboardingArtifacts.formValuesSnapshot,
      sourceStepId: schema.onboardingArtifacts.sourceStepId,
      bundleItemId: schema.onboardingArtifacts.bundleItemId,
      generatedAt: schema.onboardingArtifacts.generatedAt,
    })
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, repositoryId),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    diskPath: r.diskPath,
    templateId: r.templateId,
    templateKind: r.templateKind,
    templateContentHash: r.templateContentHash,
    templateSchemaVersion: r.templateSchemaVersion,
    writtenHash: r.writtenHash,
    formValuesSnapshot: (r.formValuesSnapshot ?? null) as Record<string, unknown> | null,
    sourceStepId: r.sourceStepId,
    bundleItemId: r.bundleItemId,
    generatedAt: r.generatedAt ?? null,
  }));
}

/** The live snapshot to render from: the newest that recorded an RTK choice, since a snapshot from
 *  before RTK would keep the repository's RTK switch from reaching the upgrade, and the upgrade
 *  banner reads the same one. */
export function pickRenderSnapshot(
  liveRows: ReadonlyArray<Pick<LiveArtifactRow, 'id' | 'generatedAt' | 'formValuesSnapshot'>>,
): Record<string, unknown> | null {
  const rows = newestArtifactsFirst(liveRows);
  const recorded = rows.find((r) => typeof r.formValuesSnapshot?.rtkEnabled === 'boolean');
  return (recorded ?? rows.find((r) => r.formValuesSnapshot))?.formValuesSnapshot ?? null;
}

/** Load the render context for this repository. Tries a live artifact's snapshot
 *  first, then falls back to the most recent completed onboarding task's step 07
 *  detect output (used for lazy backfill). */
async function resolveRenderContext(
  ctx: StepContext,
  repositoryId: string,
  liveRows: LiveArtifactRow[],
): Promise<ResolvedRenderContext | null> {
  const snapshot = pickRenderSnapshot(liveRows);
  if (snapshot) {
    return withLiveRtk(
      ctx,
      repositoryId,
      snapshot as unknown as TemplateRenderContext,
      typeof snapshot.rtkEnabled === 'boolean',
    );
  }

  const priorOnboarding = await ctx.db
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
  const priorTaskId = priorOnboarding[0]?.id ?? null;
  if (!priorTaskId) {
    // A repository created BLANK has its scaffold seeded at init and has never
    // been onboarded, so there is no snapshot and no step-07 output to recover
    // from — the one state this function otherwise reports as unresolvable,
    // which the backfill turns into a thrown error. Rebuild the same context
    // init used, from the same builder, so the seeded files can be adopted.
    //
    // Scoped to `source: 'blank'` on purpose: for any other repo, "onboarded
    // once but every trace is gone" is genuinely ambiguous, and adopting files
    // against a blank context there would record the wrong baseline for a later
    // rollback. Throwing stays the honest answer for that case.
    const [repo] = await ctx.db
      .select({ source: schema.repositories.source, name: schema.repositories.name })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repositoryId))
      .limit(1);
    if (repo?.source !== 'blank') return null;
    const renderCtx = await buildBlankRenderContext(ctx.db, {
      userId: ctx.userId,
      repositoryId,
      repoName: repo.name ?? null,
    });
    return { renderCtx, rtkLive: true };
  }

  const stepRow = await ctx.db
    .select({ detectOutput: schema.taskSteps.detectOutput })
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, priorTaskId),
        eq(schema.taskSteps.stepId, '07-generate-files'),
      ),
    )
    .limit(1);
  const detect = (stepRow[0]?.detectOutput ?? null) as Partial<GenerateFilesDetect> | null;
  if (!detect) return null;

  // Onboarding tasks completed before the manifest-versioning work stored
  // detectOutput without `agentTargets`. Fall back to a claude-agents default
  // so expandManifestFor doesn't trip on undefined fan-out arrays during the
  // lazy-backfill path. The resulting context reflects best-effort recovery;
  // conflicts get surfaced to the user via the plan UI.
  const fallbackAgentTargets: TemplateRenderContext['agentTargets'] = [
    { dir: '.claude/agents', format: 'markdown', supportsLsp: false },
  ];

  const lspLanguages = detect.lspLanguages ?? [];
  const hasCapableProvider = (detect.cliProviders ?? []).some(
    (provider) => getCliProviderMetadata(provider.name).supportsLsp,
  );
  const agentTargets = (detect.agentTargets ?? fallbackAgentTargets).map((target) => ({
    ...target,
    supportsLsp:
      target.supportsLsp ??
      (target.dir === '.claude/agents' && hasCapableProvider && lspLanguages.length > 0),
  }));

  const recorded: TemplateRenderContext = {
    projectInfo: detect.projectInfo ?? {
      name: null,
      framework: null,
      primaryLanguage: null,
      description: null,
      localUrl: null,
      databaseType: null,
      databaseVersion: null,
      webserver: null,
      docroot: null,
      runtimeVersions: {},
      testFrameworks: [],
      testPaths: [],
      buildTool: null,
      commands: [],
      containerType: null,
    },
    framework: detect.framework ?? null,
    acceptedAgentIds: detect.acceptedAgentIds ?? [],
    customAgentSpecs: detect.customAgentSpecs ?? [],
    agentTargets,
    lspLanguages,
    // A detect output from before rtk shipped recorded no choice: off, not the column's default.
    rtkEnabled: detect.rtkEnabled ?? false,
    enabledCliProviders: detect.enabledCliProviders ?? [],
  };
  return withLiveRtk(ctx, repositoryId, recorded, detect.rtkEnabled !== undefined);
}

/** A render context, and whether its RTK choice is the repository's live one. */
interface ResolvedRenderContext {
  renderCtx: TemplateRenderContext;
  rtkLive: boolean;
}

/** A context that recorded an RTK choice follows the repository's live one, so switching RTK off
 *  reaches the upgrade. One from before RTK recorded none and stays off: the column defaults on. */
async function withLiveRtk(
  ctx: StepContext,
  repositoryId: string,
  recorded: TemplateRenderContext,
  recordedChoice: boolean,
): Promise<ResolvedRenderContext> {
  if (!recordedChoice) return { renderCtx: recorded, rtkLive: false };
  const [repo] = await ctx.db
    .select({ rtkEnabled: schema.repositories.rtkEnabled })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  return repo
    ? { renderCtx: { ...recorded, rtkEnabled: repo.rtkEnabled }, rtkLive: true }
    : { renderCtx: recorded, rtkLive: false };
}

async function readDiskContent(
  repoPath: string,
  diskPath: string,
): Promise<{ content: string | null; hash: string | null }> {
  try {
    // The probe and the read collapse into ONE lenient call: null already covers absent,
    // unreadable and refused, which is what `pathExists` plus this `catch` folded together — and
    // that probe was `stat`-based, so it followed a link and read a dangling one as absent.
    // `diskPath` comes from the manifest, so a malformed one throws `invalid-path` from inside the
    // primitive and lands in this same catch: one unreadable row, never a failed upgrade plan.
    const raw = await readTextNoFollow(repoPath, diskPath);
    if (raw === null) return { content: null, hash: null };
    const normalized = normalizeContent(raw);
    return { content: raw, hash: sha256Hex(normalized) };
  } catch {
    return { content: null, hash: null };
  }
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
  diskContent: string | null;
  diskHash: string | null;
  /** Hashes of what Haive rendered at this path before; a file holding one is Haive's to replace. */
  recordedRenderHashes?: ReadonlySet<string>;
}): UpgradePlanBucket {
  const { live, current, diskContent, diskHash } = args;

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

  if (diskContent === null) return 'user_deleted';

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
  return 'conflict';
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
    const liveRows = await loadLiveArtifacts(ctx, repositoryId);
    const resolved = await resolveRenderContext(ctx, repositoryId, liveRows);
    if (!resolved) {
      throw new Error(
        'upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
      );
    }
    const { renderCtx } = resolved;

    const expanded = await unionExpandedFor(ctx, renderCtx, repositoryId);
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
      if (isCliRules) {
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
        diskContent,
        diskHash,
        recordedRenderHashes: isCliRules ? cliRulesRenderHashes : undefined,
      });
      let newContent = current?.content ?? null;
      if (isCliRules && newContent) newContent = normalizeContent(newContent);
      const baselineContent = live && current && diskHash === live.writtenHash ? diskContent : null;
      const delta = newContent ? computeLineDelta(diskContent ?? '', newContent) : null;

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
      });
    }

    const counts: Record<UpgradePlanBucket, number> = {
      unchanged: 0,
      clean_update: 0,
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
    const rtkBlockLeftovers =
      renderCtx.rtkEnabled === false ? await rtkBlockFiles(ctx.repoPath) : [];

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
      const liveRows = await loadLiveArtifacts(ctx, detected.repositoryId);
      const resolved = await resolveRenderContext(ctx, detected.repositoryId, liveRows);
      if (!resolved) {
        throw new Error('upgrade-plan apply: render context unexpectedly missing during backfill');
      }
      const { renderCtx } = resolved;
      const expanded = await unionExpandedFor(ctx, renderCtx, detected.repositoryId);
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
          formValuesSnapshot: renderCtx as unknown as Record<string, unknown>,
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
    const applicableExpanded = await unionExpandedFor(
      ctx,
      detected.renderCtxSnapshot as unknown as TemplateRenderContext,
      detected.repositoryId,
    );
    await updateApplicableTemplateIds(ctx.db, detected.repositoryId, applicableExpanded);

    return { ...detected, backfilledRows };
  },
};

/** Union the deterministic Haive-template expansion with the per-repo
 *  custom-bundle expansion, deduping on diskPath (Haive items take priority
 *  on collision — should not happen in practice). Wraps the two
 *  responsibilities so plan/backfill/applicable-set computations all see the
 *  same combined set without copy-pasting the merge loop. */
async function unionExpandedFor(
  ctx: StepContext,
  renderCtx: TemplateRenderContext,
  repositoryId: string,
): Promise<ExpandedRendering[]> {
  const manifest = getTemplateManifest();
  const haiveExpanded = expandManifestFor(renderCtx, manifest);

  const bundles: BundleWithMeta[] = await loadBundlesForExpansion(ctx.db, repositoryId, ctx.logger);
  const skillTargets = await resolveSkillTargetDirs(ctx.db, ctx.userId);
  const customExpanded = expandCustomBundlesFor(bundles, renderCtx.agentTargets, skillTargets);

  const out: ExpandedRendering[] = [];
  const seen = new Set<string>();
  for (const r of haiveExpanded) {
    if (seen.has(r.diskPath)) continue;
    seen.add(r.diskPath);
    out.push(r);
  }
  for (const r of customExpanded) {
    if (seen.has(r.diskPath)) {
      ctx.logger.warn(
        { diskPath: r.diskPath, templateId: r.templateId },
        'upgrade-plan: bundle rendering collides with Haive template, dropping bundle row',
      );
      continue;
    }
    seen.add(r.diskPath);
    out.push(r);
  }

  // Current-side expansion of the AGENTS.md cli-rules region. It is per-repo
  // (built from the repo owner's current enabled providers, sorted by name),
  // so it is not in the global manifest — recompute it here exactly the way
  // step 12 and the API do, so a rules change surfaces as drift. A null block
  // (no rules-bearing provider) means the region is obsolete: omit it so a live
  // row with no current match classifies as `obsolete` (region removal).
  const ruleRows = await ctx.db
    .select({
      name: schema.cliProviders.name,
      rulesContent: schema.cliProviders.rulesContent,
      enabled: schema.cliProviders.enabled,
    })
    .from(schema.cliProviders)
    .where(eq(schema.cliProviders.userId, ctx.userId));
  const cliRulesBlock = buildCliRulesBlockFromProviders(ruleRows);
  if (cliRulesBlock && !seen.has(CLI_RULES_DISK_PATH)) {
    const writtenHash = sha256Hex(normalizeContent(cliRulesBlock));
    out.push({
      templateId: CLI_RULES_TEMPLATE_ID,
      templateKind: CLI_RULES_TEMPLATE_KIND,
      templateSchemaVersion: CLI_RULES_SCHEMA_VERSION,
      templateContentHash: writtenHash,
      diskPath: CLI_RULES_DISK_PATH,
      content: cliRulesBlock,
      writtenHash,
    });
  }
  return out;
}

function computeInstalledSetHashFromRows(rows: LiveArtifactRow[]): string {
  const parts = rows
    .slice()
    .sort((a, b) => a.templateId.localeCompare(b.templateId))
    .map((r) => `${r.templateId}:${r.templateSchemaVersion}:${r.templateContentHash}`)
    .join('\n');
  return sha256Hex(parts);
}

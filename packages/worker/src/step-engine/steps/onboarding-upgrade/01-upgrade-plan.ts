import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import { getHaiveVersion, normalizeContent, sha256Hex } from '@haive/shared';
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
  type BundleWithMeta,
} from '../../_custom-bundle-loader.js';
import { pathExists } from '../onboarding/_helpers.js';
import type { GenerateFilesDetect } from '../onboarding/07-generate-files.js';
import { computeLineDelta } from './_diff.js';

export type UpgradePlanBucket =
  | 'unchanged'
  | 'clean_update'
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
  }));
}

/** Load the render context for this repository. Tries the most recent live
 *  artifact's snapshot first, then falls back to the most recent completed
 *  onboarding task's step 07 detect output (used for lazy backfill). */
async function resolveRenderContext(
  ctx: StepContext,
  repositoryId: string,
  liveRows: LiveArtifactRow[],
): Promise<TemplateRenderContext | null> {
  const snapshot = liveRows.find((r) => r.formValuesSnapshot)?.formValuesSnapshot ?? null;
  if (snapshot) return snapshot as unknown as TemplateRenderContext;

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
  if (!priorTaskId) return null;

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
    { dir: '.claude/agents', format: 'markdown' },
  ];

  return {
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
      containerType: null,
    },
    prefs: detect.prefs ?? {},
    framework: detect.framework ?? null,
    acceptedAgentIds: detect.acceptedAgentIds ?? [],
    customAgentSpecs: detect.customAgentSpecs ?? [],
    agentTargets: detect.agentTargets ?? fallbackAgentTargets,
    lspLanguages: detect.lspLanguages ?? [],
    // Legacy detect outputs (pre-rtk) didn't snapshot these fields; default
    // to "rtk off, no providers" so backfilled renders don't accidentally
    // surface rtk artifacts the user never opted into. The live
    // upgrade-plan path uses the current `repositories.rtk_enabled` value
    // via step 04 / 07 detect; this fallback is only hit during artifact
    // reconstruction for repos onboarded before rtk shipped.
    rtkEnabled: detect.rtkEnabled ?? false,
    enabledCliProviders: detect.enabledCliProviders ?? [],
  };
}

async function readDiskContent(
  repoPath: string,
  diskPath: string,
): Promise<{ content: string | null; hash: string | null }> {
  const abs = path.join(repoPath, diskPath);
  if (!(await pathExists(abs))) return { content: null, hash: null };
  try {
    const raw = await readFile(abs, 'utf8');
    const normalized = normalizeContent(raw);
    return { content: raw, hash: sha256Hex(normalized) };
  } catch {
    return { content: null, hash: null };
  }
}

export function classifyEntry(args: {
  live: LiveArtifactRow | null;
  current: ExpandedRendering | null;
  diskContent: string | null;
  diskHash: string | null;
}): UpgradePlanBucket {
  const { live, current, diskContent, diskHash } = args;

  if (live && !current) return 'obsolete';
  if (!live && current) return 'new_artifact';
  if (!live || !current) throw new Error('classifyEntry: both live and current null');

  if (diskContent === null) return 'user_deleted';

  const templateUnchanged = live.templateContentHash === current.templateContentHash;
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
    const renderCtx = await resolveRenderContext(ctx, repositoryId, liveRows);
    if (!renderCtx) {
      throw new Error(
        'upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
      );
    }

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

    for (const diskPath of allPaths) {
      const current = byPath.get(diskPath) ?? null;
      const live = liveByPath.get(diskPath) ?? null;
      const { content: diskContent, hash: diskHash } = await readDiskContent(
        ctx.repoPath,
        diskPath,
      );

      const bucket = classifyEntry({ live, current, diskContent, diskHash });
      const newContent = current?.content ?? null;
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

    return {
      repositoryId,
      ranBackfill,
      entries,
      counts,
      installedTemplateSetHash,
      currentTemplateSetHash: manifest.setHash,
      renderCtxSnapshot: renderCtx as unknown as Record<string, unknown>,
    };
  },

  async apply(ctx, args): Promise<UpgradePlanOutput> {
    const detected = args.detected;
    let backfilledRows = 0;

    if (detected.ranBackfill) {
      const liveRows = await loadLiveArtifacts(ctx, detected.repositoryId);
      const renderCtx = await resolveRenderContext(ctx, detected.repositoryId, liveRows);
      if (!renderCtx) {
        throw new Error('upgrade-plan apply: render context unexpectedly missing during backfill');
      }
      const expanded = await unionExpandedFor(ctx, renderCtx, detected.repositoryId);

      const rowsToInsert: (typeof schema.onboardingArtifacts.$inferInsert)[] = [];
      const haiveVersion = getHaiveVersion();
      for (const r of expanded) {
        const { content: diskContent, hash: diskHash } = await readDiskContent(
          ctx.repoPath,
          r.diskPath,
        );
        rowsToInsert.push({
          userId: ctx.userId,
          repositoryId: detected.repositoryId,
          taskId: ctx.taskId,
          diskPath: r.diskPath,
          templateId: r.templateId,
          templateKind: r.templateKind,
          templateSchemaVersion: r.templateSchemaVersion,
          templateContentHash: r.templateContentHash,
          writtenHash: diskHash ?? r.writtenHash,
          // Backfill stamps whatever bytes are on disk right now, even if the
          // user has edited them. That captures the truth of the baseline at
          // backfill time so a later rollback restores what the user had.
          writtenContent: diskContent ?? r.content,
          lastObservedDiskHash: diskHash,
          userModified: diskHash !== null && diskHash !== r.writtenHash,
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
  const skillTargets = await resolveSkillTargets(ctx.db, ctx.userId);
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

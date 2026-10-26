import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import {
  buildCliRulesBlockFromProviders,
  CLI_RULES_DISK_PATH,
  CLI_RULES_SCHEMA_VERSION,
  CLI_RULES_TEMPLATE_ID,
  CLI_RULES_TEMPLATE_KIND,
  getCliProviderMetadata,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import {
  deriveRenderTargets,
  hasLegacyAgentFallback,
  recordedCliTargets,
  skillTargetDirs,
  historyOrigin,
  isRenderContextSnapshot,
  originAgentTargets,
  pickSnapshotRow,
  readRenderContextColumn,
  renderContextOrigin,
} from '@haive/shared/project-state';
import {
  expandCustomBundlesFor,
  expandManifestFor,
  getTemplateManifest,
  type ExpandedRendering,
  type TemplateRenderContext,
} from './template-manifest.js';
import {
  loadBundlesForExpansion,
  type BundleWithMeta,
  type LoaderLogger,
} from './_custom-bundle-loader.js';
import { renderContextFromColumn } from './_render-targets.js';
import { resolveSkillTargetDirs } from './steps/onboarding/_helpers.js';
import type { GenerateFilesDetect } from './steps/onboarding/07-generate-files.js';
import { buildBlankRenderContext } from '../repo/blank-scaffold.js';

// 01's plan and the project-state sync derive the applicable template ids through these, so the
// two cannot disagree about what a render context renders.

export interface LiveArtifactRow {
  id: string;
  diskPath: string;
  templateId: string;
  templateKind: string;
  templateContentHash: string;
  templateSchemaVersion: number;
  writtenHash: string;
  formValuesSnapshot: Record<string, unknown> | null;
  source: string;
  sourceStepId: string;
  haiveVersion: string | null;
  bundleItemId: string | null;
  generatedAt: Date | null;
}

export async function loadLiveArtifacts(
  db: Database | DbTx,
  repositoryId: string,
): Promise<LiveArtifactRow[]> {
  const rows = await db
    .select({
      id: schema.onboardingArtifacts.id,
      diskPath: schema.onboardingArtifacts.diskPath,
      templateId: schema.onboardingArtifacts.templateId,
      templateKind: schema.onboardingArtifacts.templateKind,
      templateContentHash: schema.onboardingArtifacts.templateContentHash,
      templateSchemaVersion: schema.onboardingArtifacts.templateSchemaVersion,
      writtenHash: schema.onboardingArtifacts.writtenHash,
      formValuesSnapshot: schema.onboardingArtifacts.formValuesSnapshot,
      source: schema.onboardingArtifacts.source,
      sourceStepId: schema.onboardingArtifacts.sourceStepId,
      haiveVersion: schema.onboardingArtifacts.haiveVersion,
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
    source: r.source,
    sourceStepId: r.sourceStepId,
    haiveVersion: r.haiveVersion,
    bundleItemId: r.bundleItemId,
    generatedAt: r.generatedAt ?? null,
  }));
}

/** The live snapshot to render from: the newest that recorded an RTK choice, since a snapshot from
 *  before RTK would keep the repository's RTK switch from reaching the upgrade, and the upgrade
 *  banner reads the same one. Once a person switched RTK, the newest of all. */
export function pickRenderSnapshot(
  liveRows: ReadonlyArray<Pick<LiveArtifactRow, 'id' | 'generatedAt' | 'formValuesSnapshot'>>,
  rtkChoiceMadeAt?: Date | null,
): Record<string, unknown> | null {
  return pickSnapshotRow(liveRows.map(snapshotFacts), rtkChoiceMadeAt)?.formValuesSnapshot ?? null;
}

function snapshotFacts(r: Pick<LiveArtifactRow, 'id' | 'generatedAt' | 'formValuesSnapshot'>) {
  const decodes = isRenderContextSnapshot(r.formValuesSnapshot);
  return {
    id: r.id,
    generatedAt: r.generatedAt,
    hasSnapshot: decodes,
    rtkRecorded: decodes && typeof r.formValuesSnapshot?.rtkEnabled === 'boolean',
    formValuesSnapshot: r.formValuesSnapshot,
  };
}

/** Load the render context for this repository. Tries its render context column
 *  first, then a live artifact's snapshot, then falls back to the most recent
 *  completed onboarding task's step 07 detect output (used for lazy backfill). */
export async function resolveRenderContext(
  db: Database | DbTx,
  args: {
    repositoryId: string;
    userId: string;
    liveRows: LiveArtifactRow[];
    logger: LoaderLogger;
  },
): Promise<ResolvedRenderContext | null> {
  const [repo] = await db
    .select({
      renderContext: schema.repositories.renderContext,
      rtkEnabled: schema.repositories.rtkEnabled,
      rtkChoiceMadeAt: schema.repositories.rtkChoiceMadeAt,
      source: schema.repositories.source,
      name: schema.repositories.name,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, args.repositoryId))
    .limit(1);
  const resolved = await resolveFromRepository(db, args, repo);
  return resolved && { ...resolved, column: repo?.renderContext ?? null };
}

async function resolveFromRepository(
  db: Database | DbTx,
  args: {
    repositoryId: string;
    userId: string;
    liveRows: LiveArtifactRow[];
    logger: LoaderLogger;
  },
  repo:
    | {
        renderContext: unknown;
        rtkEnabled: boolean;
        rtkChoiceMadeAt: Date | null;
        source: string;
        name: string | null;
      }
    | undefined,
): Promise<Omit<ResolvedRenderContext, 'column'> | null> {
  const { repositoryId, userId, liveRows, logger } = args;
  const column = readRenderContextColumn(repo?.renderContext);
  if (column.kind === 'refused') {
    logger.warn(
      { repositoryId, problems: column.problems },
      'upgrade-plan: render context column refused, reading it as NULL',
    );
  }
  const origin = renderContextOrigin({
    column,
    rows: liveRows.map(snapshotFacts),
    rtkChoiceMadeAt: repo?.rtkChoiceMadeAt,
  });
  const loadProviderRows = () =>
    db
      .select({ name: schema.cliProviders.name, enabled: schema.cliProviders.enabled })
      .from(schema.cliProviders)
      .where(eq(schema.cliProviders.userId, userId));
  if (origin.from === 'column') {
    return withLiveRtk(
      repo,
      renderContextFromColumn(origin.column, await loadProviderRows()),
      origin.rtkRecorded,
    );
  }
  if (origin.from === 'snapshot') {
    const snapshot = origin.row.formValuesSnapshot as unknown as TemplateRenderContext;
    const cliTargets = snapshot.cliTargets;
    if (cliTargets !== undefined)
      return withLiveRtk(
        repo,
        {
          ...snapshot,
          cliTargets,
          agentTargets: deriveRenderTargets(
            cliTargets,
            snapshot.lspLanguages,
            snapshot.agentTargets,
            snapshot.legacyAgentFallback,
          ).agentTargets,
          enabledCliProviders: deriveRenderTargets(
            cliTargets,
            snapshot.lspLanguages,
            snapshot.agentTargets,
            snapshot.legacyAgentFallback,
          ).enabledCliProviders,
        },
        origin.rtkRecorded,
      );
    const recorded = snapshot.agentTargets
      ? snapshot
      : {
          ...snapshot,
          agentTargets: originAgentTargets(
            { from: 'snapshot', lspLanguages: snapshot.lspLanguages ?? [] },
            await loadProviderRows(),
          ),
        };
    return withLiveRtk(repo, recorded, origin.rtkRecorded);
  }

  const priorOnboarding = await db
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
  let detect: Partial<GenerateFilesDetect> | null = null;
  if (priorTaskId) {
    const stepRow = await db
      .select({ detectOutput: schema.taskSteps.detectOutput })
      .from(schema.taskSteps)
      .where(
        and(
          eq(schema.taskSteps.taskId, priorTaskId),
          eq(schema.taskSteps.stepId, '07-generate-files'),
        ),
      )
      .limit(1);
    detect = (stepRow[0]?.detectOutput ?? null) as Partial<GenerateFilesDetect> | null;
  }
  const history = historyOrigin({
    onboarding: priorTaskId
      ? { detected: detect !== null, rtkRecorded: detect?.rtkEnabled !== undefined }
      : null,
    source: repo?.source ?? '',
    rtkChoiceMadeAt: repo?.rtkChoiceMadeAt,
  });
  if (history.kind === 'blank') {
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
    const renderCtx = await buildBlankRenderContext(db, {
      userId,
      repositoryId,
      repoName: repo?.name ?? null,
    });
    return { renderCtx, rtkLive: true };
  }
  if (history.kind === 'none' || !detect) return null;

  // Onboarding tasks completed before the manifest-versioning work stored
  // detectOutput without `agentTargets`. Fall back to a claude-agents default
  // so expandManifestFor doesn't trip on undefined fan-out arrays during the
  // lazy-backfill path. The resulting context reflects best-effort recovery;
  // conflicts get surfaced to the user via the plan UI.
  const lspLanguages = detect.lspLanguages ?? [];
  const hasCapableProvider = (detect.cliProviders ?? []).some(
    (provider) => getCliProviderMetadata(provider.name).supportsLsp,
  );
  const agentTargets = originAgentTargets(
    { from: 'onboarding', agentTargets: detect.agentTargets },
    [],
  ).map((target) => ({
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
    ...(hasLegacyAgentFallback(detect) ? { legacyAgentFallback: true } : {}),
    ...(recordedCliTargets(detect) !== undefined ? { cliTargets: recordedCliTargets(detect) } : {}),
  };
  return withLiveRtk(repo, recorded, history.rtkRecorded);
}

/** A render context, and whether its RTK choice is the repository's live one. */
export interface ResolvedRenderContext {
  renderCtx: TemplateRenderContext;
  rtkLive: boolean;
  /** The render context column exactly as the read that resolved this context found it. */
  column: unknown;
}

/** A context that recorded an RTK choice follows the repository's live one, so switching RTK off
 *  reaches the upgrade. One from before RTK recorded none and stays off, unless a person switched RTK
 *  on this install: the column defaults on. */
function withLiveRtk(
  repo: { rtkEnabled: boolean } | undefined,
  recorded: TemplateRenderContext,
  recordedChoice: boolean,
): Omit<ResolvedRenderContext, 'column'> {
  return recordedChoice && repo
    ? { renderCtx: { ...recorded, rtkEnabled: repo.rtkEnabled }, rtkLive: true }
    : { renderCtx: recorded, rtkLive: false };
}

/** Union the deterministic Haive-template expansion with the per-repo
 *  custom-bundle expansion, deduping on diskPath (Haive items take priority
 *  on collision — should not happen in practice). Wraps the two
 *  responsibilities so plan/backfill/applicable-set computations all see the
 *  same combined set without copy-pasting the merge loop. */
export async function unionExpandedFor(
  db: Database | DbTx,
  args: {
    repositoryId: string;
    userId: string;
    renderCtx: TemplateRenderContext;
    logger: LoaderLogger;
  },
): Promise<ExpandedRendering[]> {
  const { repositoryId, userId, renderCtx, logger } = args;
  const manifest = getTemplateManifest();
  const haiveExpanded = expandManifestFor(renderCtx, manifest);

  const bundles: BundleWithMeta[] = await loadBundlesForExpansion(db, repositoryId, logger);
  const skillTargets =
    renderCtx.cliTargets !== undefined
      ? skillTargetDirs(renderCtx.cliTargets)
      : await resolveSkillTargetDirs(db, userId, [], repositoryId);
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
      logger.warn(
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
  const ruleRows = await db
    .select({
      name: schema.cliProviders.name,
      rulesContent: schema.cliProviders.rulesContent,
      enabled: schema.cliProviders.enabled,
    })
    .from(schema.cliProviders)
    .where(eq(schema.cliProviders.userId, userId));
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

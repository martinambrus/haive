import {
  sameValue,
  readRenderContextColumn,
  recoverCliMembership,
  namesGitData,
} from '@haive/shared/project-state';
import { skillTargetDirs } from '@haive/shared/project-state';
import { isRtkChoiceRecorded } from '@haive/shared/project-state';
import { redactGitUrl } from '@haive/shared/schemas';
import { lstatNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { lockRepositoryTasksKey, schema } from '@haive/database';
import type {
  FormField,
  FormSchema,
  OnboardingEnvironmentMirror,
  OnboardingExclusionsMirror,
  OnboardingToolingMirror,
} from '@haive/shared';
import { HAIVE_DATA_DIR, RTK_SETTINGS_PATHS } from '@haive/shared';
import { safeErrorMessage } from '@haive/shared/logger';
import {
  buildRepoCliRulesBlock,
  CLI_RULES_DISK_PATH,
  CLI_RULES_SCHEMA_VERSION,
  CLI_RULES_TEMPLATE_ID,
  CLI_RULES_TEMPLATE_KIND,
  getHaiveVersion,
  HAIVE_DATA_FILES,
  ONBOARDING_EXCLUSIONS_SCHEMA_VERSION,
} from '@haive/shared';
import { toolingUnitOf, withoutMachineLocalTooling } from '@haive/shared/project-state';
import type { StepDefinition, StepContext } from '../../step-definition.js';
import { resolveGitEnv } from '../../../secrets/user-git-identity.js';
import { getOriginUrl, GIT_MAX_BUFFER } from '../../../repo/git-push.js';
import { initGitWorkspace } from '../../../repo/git-init.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import {
  failIfColumnStale,
  ProjectStateWriteError,
  renderContextColumnFor,
  writeProjectStateRecord,
  lockProjectState,
  completeWriterCliMembership,
  inheritCliMembership,
} from '../../../project-state/write.js';
import { gitWorkspaceStatus, requireUsableGit } from '../../../repo/git-workspace.js';
import { loadPreviousStepOutput } from './_helpers.js';
import {
  collectOnboardingStagePaths,
  commitRecorded,
  stageNamed,
  stagedChanges,
} from './_stage-paths.js';
import {
  cliRulesRegionRecord,
  dropIgnoredRulesFiles,
  loadCliRulesRenderHashes,
  readAgentsRulesRegion,
} from './_rules-files.js';
import {
  expandCustomBundlesFor,
  expandManifestFor,
  getTemplateManifest,
  updateApplicableTemplateIds,
  type ExpandedRendering,
  type TemplateRenderContext,
} from '../../template-manifest.js';
import { extractBundleItemId, loadBundlesForExpansion } from '../../_custom-bundle-loader.js';
import {
  INSTALL_MANIFEST_PATH,
  retireInstallManifest,
  retireLegacyMirrors,
  toolingOutsideRecord,
} from '../../_retire-install-manifest.js';
import type { GenerateFilesApply, GenerateFilesDetect } from './07-generate-files.js';
import { gitExec } from '../../../repo/git-exec.js';

const DEFAULT_COMMIT_MESSAGE = [
  'add: agentic workflow setup',
  '',
  'Generated .claude/ (agents, skills), the rules files, and',
  `${HAIVE_DATA_DIR}/ (knowledge base, learnings, onboarding metadata).`,
].join('\n');

/** Default for the no-git case, where the commit is also the repository's first and
 *  therefore holds the pre-existing project files as well as the generated ones. */
const INIT_COMMIT_MESSAGE = [
  'add: initial commit with agentic workflow setup',
  '',
  'Initializes the repository with the existing project files plus the generated',
  '.claude/ (agents, skills), the rules files, and',
  `${HAIVE_DATA_DIR}/ (knowledge base, learnings, onboarding metadata).`,
].join('\n');

// Fixed names an earlier step (04, 12 itself) writes, staged whenever they exist.
// Everything else comes from the step outputs.
const FIXED_STAGE_PATHS = ['.claude/mcp_settings.json'];

// Rules files onboarding writes that are NOT tracked as onboarding_artifacts, so
// the artifact union below would miss them: the import stubs (CLAUDE.md/GEMINI.md).
// AGENTS.md is listed too as a fallback for the no-provider-rules case, where it
// holds only the project-info block and is untracked.
const EXTRA_RULES_STAGE_PATHS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

/** The paths this commit may touch: what the task's own step outputs and artifact rows record,
 *  plus `ownFiles`, the files this step wrote. Never a directory. */
async function resolveStagePlan(
  ctx: StepContext,
  repositoryId: string | null,
  ownFiles: readonly string[],
  ownRemoved: readonly string[],
): Promise<{ add: string[]; remove: string[] }> {
  const recorded = await collectOnboardingStagePaths(ctx.repoPath, ctx.db, ctx.taskId);
  const add = new Set<string>([
    ...FIXED_STAGE_PATHS,
    ...EXTRA_RULES_STAGE_PATHS,
    ...ownFiles,
    ...recorded.add,
  ]);
  // Stage every tracked onboarding artifact for this repo so the AGENTS.md
  // cli-rules region, RTK settings, workflow-config, commands, Drupal LSP, and any
  // future tracked template are committed without having to re-list them here.
  if (repositoryId) {
    const artifactRows = await ctx.db
      .select({ diskPath: schema.onboardingArtifacts.diskPath })
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, repositoryId),
          isNull(schema.onboardingArtifacts.supersededAt),
        ),
      );
    for (const r of artifactRows) add.add(r.diskPath);
  }
  return { add: [...add], remove: [...recorded.remove, ...ownRemoved] };
}

/** Used only when neither the repo's bound credential nor the user carries an identity,
 *  preserving the bot attribution these commits have always had. */
const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive Worker',
  GIT_AUTHOR_EMAIL: 'haive@local',
  GIT_COMMITTER_NAME: 'Haive Worker',
  GIT_COMMITTER_EMAIL: 'haive@local',
};

interface PostOnboardingDetect {
  /** False for an uploaded / in-place repo that carries no git history. The commit
   *  path then runs `git init` first — without it `git add` fails with
   *  "fatal: not a git repository" and the whole step dies. */
  hasGit: boolean;
  /** Whether the repo has a pushable origin remote (gates the push fields). */
  hasOrigin: boolean;
  originUrl: string | null;
  /** Why the origin could not be read, so the push is not offered. Optional: a parked step replays a payload without it. */
  originError?: string | null;
  /** Credential bound to the repo — the default selection for the push. */
  boundCredentialId: string | null;
  /** The user's stored git credentials, for the push credential picker. */
  credentials: { id: string; label: string; host: string }[];
}

interface PostOnboardingOutput {
  commitPerformed: boolean;
  commitSha: string | null;
  stagedPaths: string[];
  warnings: string[];
  artifactRowsWritten: number;
  /** Push handoff to 13-onboarding-push: pushRequested is true only after a
   *  successful commit in THIS run; the rest carry the user's push choices. */
  pushRequested: boolean;
  pushCredentialId: string | null;
  pushSetUpstream: boolean;
  /** What the project state record write did; 'failed' when it or the retire after it threw.
   *  Optional because it is read back from a persisted output that may predate it. */
  recordWrite?: 'written' | 'failed' | 'skipped';
}

/** Build the deterministic render context from step 07's detect output. Used
 *  to expand the template manifest against the real per-repo inputs so the
 *  artifact rows reflect what was actually rendered. */
function buildRenderContext(detect: GenerateFilesDetect): TemplateRenderContext {
  return {
    projectInfo: detect.projectInfo,
    framework: detect.framework,
    acceptedAgentIds: detect.acceptedAgentIds,
    customAgentSpecs: detect.customAgentSpecs,
    ...(detect.cliTargets !== undefined ? { cliTargets: detect.cliTargets } : {}),
    ...(detect.legacyAgentFallback !== undefined
      ? { legacyAgentFallback: detect.legacyAgentFallback }
      : {}),
    agentTargets: detect.agentTargets,
    lspLanguages: detect.lspLanguages,
    rtkEnabled: detect.rtkEnabled ?? false,
    enabledCliProviders: detect.enabledCliProviders ?? [],
  };
}

/** A saved pre-feature07 omitted its membership decision. Complete its metadata before publishing
 * newer snapshots, using the writer's recorded-current/history/caller precedence. Its actual
 * rendered file scope and original column admission remain separate and unchanged. */
class OnboardingMembershipReplanError extends Error {
  constructor() {
    super('Repository context changed after onboarding files were planned. Retry generation.');
  }
}

async function completeLegacyOnboardingContext(
  ctx: StepContext,
  context: TemplateRenderContext,
  chosen: boolean,
  originalColumn: unknown,
): Promise<TemplateRenderContext> {
  if (context.cliTargets !== undefined) return context;
  const [task] = await ctx.db
    .select({ repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, ctx.taskId));
  if (!task?.repositoryId) return context;
  const [repo] = await ctx.db
    .select({ renderContext: schema.repositories.renderContext })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, task.repositoryId));
  const current = readRenderContextColumn(repo?.renderContext);
  const rows =
    current.kind === 'column' && current.column.cliTargets !== undefined
      ? []
      : await ctx.db
          .select({
            id: schema.onboardingArtifacts.id,
            generatedAt: schema.onboardingArtifacts.generatedAt,
            formValuesSnapshot: schema.onboardingArtifacts.formValuesSnapshot,
          })
          .from(schema.onboardingArtifacts)
          .where(
            and(
              eq(schema.onboardingArtifacts.repositoryId, task.repositoryId),
              isNull(schema.onboardingArtifacts.supersededAt),
            ),
          );
  const caller = renderContextColumnFor(context, chosen);
  const completed = completeWriterCliMembership(
    caller,
    current.kind === 'column' ? current.column : caller,
    recoverCliMembership(rows),
  );
  const { rtkChoiceRecorded: _choice, ...result } = inheritCliMembership(caller, completed);
  if (
    originalColumn !== undefined &&
    !sameValue(
      renderContextColumnFor(context, chosen, originalColumn),
      renderContextColumnFor(result as unknown as TemplateRenderContext, chosen, originalColumn),
    )
  )
    throw new OnboardingMembershipReplanError();
  return result as unknown as TemplateRenderContext;
}

/** Record onboarding_artifacts rows. Runs
 *  always (not gated by the commit checkbox) so versioning is in place even
 *  when the user defers committing. Idempotent on re-runs: upstream step
 *  machine guarantees 12-post-onboarding.apply runs once per task. `renderCtx` is
 *  built from `detect`, step 07's output; both are null where 07 left none.
 *  `agentRulesOverride` is the override 07 wrote the AGENTS.md region from (its
 *  apply output; absent reads as the default rules). */
async function recordOnboardingArtifacts(
  ctx: StepContext,
  detect: GenerateFilesDetect | null,
  renderCtx: TemplateRenderContext | null,
  renderedCtx: TemplateRenderContext | null = renderCtx,
  agentRulesOverride?: string | null,
): Promise<{
  rowsWritten: number;
  warnings: string[];
}> {
  const warnings: string[] = [];

  if (!detect || !renderCtx || !renderedCtx) {
    warnings.push('onboarding-artifacts: 07-generate-files detect output missing, skipping');
    ctx.logger.warn('onboarding-artifacts: cannot record — step 07 detect output missing');
    return { rowsWritten: 0, warnings };
  }

  const taskRows = await ctx.db
    .select({ repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, ctx.taskId))
    .limit(1);
  const repositoryId = taskRows[0]?.repositoryId ?? null;
  if (!repositoryId) {
    warnings.push('onboarding-artifacts: task has no repository_id, skipping');
    ctx.logger.warn('onboarding-artifacts: cannot record — task has no repository_id');
    return { rowsWritten: 0, warnings };
  }

  const manifest = getTemplateManifest();
  const recordable = (r: ExpandedRendering): boolean => {
    if (!namesGitData(r.diskPath)) return true;
    warnings.push(`onboarding-artifacts: did not record ${r.diskPath}: it names git data`);
    return false;
  };
  const haiveExpanded = expandManifestFor(renderedCtx, manifest).filter(recordable);

  // Custom-bundle expansion runs in parallel with manifest expansion; the two
  // are concatenated and de-duped on diskPath (Haive items win on collision —
  // this should not happen in practice since Haive paths and bundle paths
  // never overlap by convention, but we log+drop just in case).
  const bundlesForInstall = await loadBundlesForExpansion(ctx.db, repositoryId, ctx.logger);
  // Claims describe this task's generation, just as staging uses its saved written/mirroredDirs.
  // Membership can have changed since 09_5 ran. Match that writer's missing-field compatibility
  // default and preserve an explicit [] rather than expanding into today's maintained targets.
  const generatedSkills = await loadPreviousStepOutput(ctx.db, ctx.taskId, '09_5-skill-generation');
  const skillTargets = (generatedSkills?.detect as { skillTargetDirs?: string[] } | null)
    ?.skillTargetDirs ?? ['.claude/skills'];
  const customExpanded = expandCustomBundlesFor(
    bundlesForInstall,
    detect.agentTargets,
    skillTargets,
  ).filter(recordable);
  const expanded: ExpandedRendering[] = [];
  const seenDiskPaths = new Set<string>();
  for (const r of haiveExpanded) {
    if (seenDiskPaths.has(r.diskPath)) continue;
    seenDiskPaths.add(r.diskPath);
    expanded.push(r);
  }
  for (const r of customExpanded) {
    if (seenDiskPaths.has(r.diskPath)) {
      ctx.logger.warn(
        { diskPath: r.diskPath, templateId: r.templateId },
        'onboarding-artifacts: bundle rendering collides with Haive template, dropping bundle row',
      );
      continue;
    }
    seenDiskPaths.add(r.diskPath);
    expanded.push(r);
  }

  // The AGENTS.md cli-rules region is per-repo (the repository's rules override, else the
  // default rules), so it is tracked as a region-scoped artifact rather than a manifest
  // template. It renders from the override 07 wrote it from (its apply output), never from the
  // live column: the row records what 07 put on disk, and a later change of the override is
  // offered by the next upgrade as a clean update. Nothing here compares the two or refuses,
  // since the caller swallows an error from this transaction together with every other
  // artifact row. diskPath 'AGENTS.md' carries no other live artifact row, so the
  // (repository_id, disk_path) unique index stays satisfied. The row records the
  // region on disk, which 07 leaves alone when it exists and overwrite is off.
  const cliRulesBlock = buildRepoCliRulesBlock(agentRulesOverride);
  let retireCliRulesRow = false;
  if (cliRulesBlock) {
    const read = await readAgentsRulesRegion(ctx.repoPath);
    if ('unreadable' in read) {
      warnings.push(
        `AGENTS.md could not be read (${read.unreadable}), so its rules block is not recorded`,
      );
    } else if (read.region === null) {
      // 07 writes a missing region, so none here means something removed it since. A row would
      // read as the person's deletion; without one the next upgrade offers the region again.
      retireCliRulesRow = true;
    } else {
      const record = cliRulesRegionRecord(
        read.region,
        cliRulesBlock,
        await loadCliRulesRenderHashes(ctx.db, repositoryId),
      );
      expanded.push({
        templateId: CLI_RULES_TEMPLATE_ID,
        templateKind: CLI_RULES_TEMPLATE_KIND,
        templateSchemaVersion: CLI_RULES_SCHEMA_VERSION,
        templateContentHash: record.templateContentHash,
        diskPath: CLI_RULES_DISK_PATH,
        content: record.content,
        writtenHash: record.writtenHash,
      });
    }
  }

  if (expanded.length === 0) {
    ctx.logger.info('onboarding-artifacts: manifest produced no renderings for this context');
    return { rowsWritten: 0, warnings };
  }

  // Snapshot the render context so rollback/upgrade can reconstruct what was
  // originally fed into the template generators without loading the owning
  // task's full step history.
  const renderCtxSnapshot = renderCtx as unknown as Record<string, unknown>;
  const haiveVersion = getHaiveVersion();
  const rows = expanded.map((r) => ({
    userId: ctx.userId,
    repositoryId,
    taskId: ctx.taskId,
    diskPath: r.diskPath,
    templateId: r.templateId,
    templateKind: r.templateKind,
    templateSchemaVersion: r.templateSchemaVersion,
    templateContentHash: r.templateContentHash,
    writtenHash: r.writtenHash,
    writtenContent: r.content,
    formValuesSnapshot: renderCtxSnapshot,
    sourceStepId: r.templateId.startsWith('custom.') ? '06_3-custom-bundles' : '07-generate-files',
    source: 'onboarding' as const,
    haiveVersion,
    bundleItemId: extractBundleItemId(r.templateId),
  }));

  // Defensive supersede + insert, the same shape and for the same reason as `02-upgrade-apply`:
  // a live row already standing at one of these paths collides on the
  // `(repository_id, disk_path) WHERE superseded_at IS NULL` unique index and fails the step.
  //
  // A reset is now one way to arrive here with live rows still standing. It supersedes rows for
  // what it REMOVED and deliberately leaves the rest — a file it could not read is still on disk,
  // and dropping its `written_hash` would make the next reset unable to claim it at all. Those
  // survivors are exactly the paths a re-onboarding writes again.
  // ONE transaction, as `02-upgrade-apply` also does and for the reason it states: a half-applied
  // state is impossible. The caller catches and only WARNS, so a supersede that committed before
  // a failing insert would leave onboarding running with every prior row for these files retired
  // and no replacement — destroying the hashes that distinguish Haive's output from the user's
  // edits, silently, on a path that reports success.
  const supersedePaths = Array.from(
    new Set([...rows.map((r) => r.diskPath), ...(retireCliRulesRow ? [CLI_RULES_DISK_PATH] : [])]),
  );
  await ctx.db.transaction(async (tx) => {
    await lockRepositoryTasksKey(tx, repositoryId);
    await lockProjectState(tx, repositoryId);
    const [live] = await tx
      .select({
        renderContext: schema.repositories.renderContext,
        rtkEnabled: schema.repositories.rtkEnabled,
        rtkChoiceMadeAt: schema.repositories.rtkChoiceMadeAt,
      })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repositoryId))
      .for('update');
    if (
      detect.renderContextColumn !== undefined &&
      !sameValue(live?.renderContext ?? null, detect.renderContextColumn) &&
      !sameValue(
        live?.renderContext ?? null,
        renderContextColumnFor(
          renderedCtx,
          detect.rtkEnabled !== undefined,
          detect.renderContextColumn,
        ),
      )
    )
      throw new Error(
        'Repository context changed after onboarding files were planned. Retry generation.',
      );
    if (supersedePaths.length > 0) {
      await tx
        .update(schema.onboardingArtifacts)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, repositoryId),
            isNull(schema.onboardingArtifacts.supersededAt),
            inArray(schema.onboardingArtifacts.diskPath, supersedePaths),
          ),
        );
    }
    await tx.insert(schema.onboardingArtifacts).values(rows);
    // 07's rows describe what it rendered then. The applicable set describes what renders now:
    // a person's intervening RTK choice takes precedence at this actual, row-locked write.
    const current =
      live && isRtkChoiceRecorded(detect.rtkEnabled !== undefined, live.rtkChoiceMadeAt)
        ? { ...renderCtx, rtkEnabled: live.rtkEnabled }
        : renderCtx;
    const currentExpanded =
      renderCtx === renderedCtx
        ? expanded
        : [
            ...expandManifestFor(current, manifest),
            ...expandCustomBundlesFor(
              bundlesForInstall,
              current.agentTargets,
              current.cliTargets !== undefined ? skillTargetDirs(current.cliTargets) : skillTargets,
            ),
            ...expanded.filter((r) => r.templateKind === CLI_RULES_TEMPLATE_KIND),
          ];
    const applicable = [
      ...currentExpanded.filter((r) => r.templateKind !== 'rtk-config'),
      ...expandManifestFor(current, manifest).filter((r) => r.templateKind === 'rtk-config'),
    ];
    await updateApplicableTemplateIds(tx, repositoryId, applicable);
  });

  ctx.logger.info(
    { rowsWritten: rows.length, templateSetHash: manifest.setHash },
    'onboarding-artifacts recorded',
  );

  return { rowsWritten: rows.length, warnings };
}

/** Write the committed `.haive-data/` onboarding mirror from the repo's
 *  onboarding_* columns (already populated by steps 02/04/06_7). A fresh clone
 *  on another machine restores its onboarding-derived DB state from these files
 *  via persistDetection, since the onboarding task's rows never travel. Runs
 *  always (independent of the commit checkbox); the files it lists in `filesWritten`,
 *  which survives a throw, are staged when the user opts into a commit. The
 *  tooling file drops the machine-specific infra keys (ollamaUrl,
 *  ragConnectionString) — those do not move between machines. The environment, scope
 *  exclusion and tooling files are written only when `legacyMirrors` is set: a successful project
 *  state record write carries them and retires those files. Tooling the record cannot carry (no
 *  unit is written for it) is still written here, so the value always lives in a committed file. */
async function writeHaiveDataMirror(
  ctx: StepContext,
  repositoryId: string,
  filesWritten: string[],
  filesRemoved: string[],
  legacyMirrors: boolean,
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];

  const [repo] = await ctx.db
    .select({
      onboardingEnvironment: schema.repositories.onboardingEnvironment,
      onboardingTooling: schema.repositories.onboardingTooling,
      scopeExcludeGlobs: schema.repositories.scopeExcludeGlobs,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  if (!repo) {
    warnings.push('haive-data mirror: repository row not found, skipping');
    return { warnings };
  }

  const writeJson = async (rel: string, value: unknown): Promise<void> => {
    await writeFileNoFollow(ctx.repoPath, rel, `${JSON.stringify(value, null, 2)}\n`, {
      createParents: true,
    });
    filesWritten.push(rel);
  };

  const env = repo.onboardingEnvironment as OnboardingEnvironmentMirror | null;
  if (env && legacyMirrors) await writeJson(HAIVE_DATA_FILES.environment, env);

  const tooling = repo.onboardingTooling as OnboardingToolingMirror | null;
  if (tooling?.tooling && (legacyMirrors || toolingUnitOf(tooling) === null)) {
    const mirror: OnboardingToolingMirror = {
      schemaVersion: tooling.schemaVersion,
      tooling: withoutMachineLocalTooling(tooling.tooling),
    };
    await writeJson(HAIVE_DATA_FILES.tooling, mirror);
  }

  const globs = repo.scopeExcludeGlobs as string[] | null;
  if (globs && legacyMirrors) {
    const mirror: OnboardingExclusionsMirror = {
      schemaVersion: ONBOARDING_EXCLUSIONS_SCHEMA_VERSION,
      scopeExcludeGlobs: globs,
    };
    await writeJson(HAIVE_DATA_FILES.exclusions, mirror);
  }

  // The plan canvas mirrors into the same dir. Best-effort and independent of the
  // onboarding columns above: a repo with no plan simply writes nothing, and a
  // plan-mirror failure must not cost the user their onboarding commit.
  const changes = { written: [] as string[], removed: [] as string[] };
  try {
    await writePlanMirror(ctx.db, repositoryId, ctx.repoPath, changes);
  } catch (err) {
    warnings.push(`haive-data mirror: plan mirror failed (${safeErrorMessage(err)})`);
  } finally {
    filesWritten.push(...changes.written);
    filesRemoved.push(...changes.removed);
  }

  if (filesWritten.length > 0) {
    ctx.logger.info({ filesWritten }, 'haive-data onboarding mirror written');
  }
  return { warnings };
}

export const postOnboardingStep: StepDefinition<PostOnboardingDetect, PostOnboardingOutput> = {
  metadata: {
    id: '12-post-onboarding',
    workflowType: 'onboarding',
    index: 16,
    title: 'Post-onboarding commit',
    description: 'Optionally commits the generated workflow files and pushes them to origin.',
    requiresCli: false,
  },

  async detect(ctx): Promise<PostOnboardingDetect> {
    const empty: PostOnboardingDetect = {
      hasGit: false,
      hasOrigin: false,
      originUrl: null,
      boundCredentialId: null,
      credentials: [],
    };
    // Classify rather than requireUsableGit: a corrupt `.git` must not fail this step
    // for a user who never asked for a commit — the artifact rows and the .haive-data
    // mirror below still have to be written. The commit path re-checks and throws.
    const hasGit = (await gitWorkspaceStatus(ctx.repoPath)) === 'ok';
    let hasOrigin = false;
    let originUrl: string | null = null;
    let originError: string | null = null;
    if (hasGit) {
      try {
        originUrl = await getOriginUrl(ctx.repoPath);
        hasOrigin = originUrl !== null;
      } catch (err) {
        originError = err instanceof Error ? err.message : String(err);
      }
    }

    const taskRow = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    const repositoryId = taskRow[0]?.repositoryId ?? null;
    const repo = repositoryId
      ? await ctx.db.query.repositories.findFirst({
          where: eq(schema.repositories.id, repositoryId),
          columns: { credentialsSecretId: true },
        })
      : null;
    const rows = await ctx.db.query.repoCredentials.findMany({
      where: eq(schema.repoCredentials.userId, ctx.userId),
      columns: { id: true, label: true, host: true },
      orderBy: [desc(schema.repoCredentials.createdAt)],
    });
    return {
      ...empty,
      hasGit,
      hasOrigin,
      originUrl,
      originError,
      boundCredentialId: repo?.credentialsSecretId ?? null,
      credentials: rows.map((r) => ({ id: r.id, label: r.label, host: r.host })),
    };
  },

  form(_ctx, detected): FormSchema {
    const fields: FormField[] = [];

    // No git history (uploaded archive, in-place dir): committing has to create the
    // repository first. The initial commit deliberately holds the WHOLE working tree,
    // not only the generated files — `git worktree add` checks out tracked files only,
    // so a first commit carrying just `.claude/` would hand every later workflow task
    // an empty project.
    if (!detected.hasGit) {
      fields.push(
        {
          type: 'note',
          id: 'noGitNote',
          label: 'No git repository',
          body:
            'This repository has no git history. Committing will run `git init` in the ' +
            'repository root and create an initial commit containing every current file ' +
            '(honouring .gitignore), not only the generated ones. Use the Terminal tab if ' +
            'you need a different setup (existing remote, custom .gitignore) and Retry afterwards.',
          variant: 'warning',
        },
        {
          type: 'checkbox',
          id: 'commit',
          label: 'Initialize git, then stage and commit',
          default: false,
        },
        {
          type: 'text',
          id: 'initBranch',
          label: 'Initial branch name',
          default: 'main',
          description: 'The branch `git init` creates.',
          visibleWhen: { field: 'commit', equals: true },
        },
      );
    } else {
      fields.push({
        type: 'checkbox',
        id: 'commit',
        label: 'Stage and commit generated workflow files',
        default: false,
      });
    }

    fields.push({
      type: 'textarea',
      id: 'commitMessage',
      label: 'Commit message',
      default: detected.hasGit ? DEFAULT_COMMIT_MESSAGE : INIT_COMMIT_MESSAGE,
      rows: 6,
    });

    // Push-to-origin sub-option — only when the repo has a pushable origin. The push
    // fields are nested under the commit checkbox (visibleWhen commit=true); the
    // credential/upstream fields nest one deeper under pushToOrigin. The actual push
    // (fetch → merge origin → resolve conflicts → push) runs in 13-onboarding-push,
    // which reads the choices recorded on this step's output.
    if (detected.hasOrigin) {
      const credentialOptions = [
        ...detected.credentials.map((c) => ({ value: c.id, label: `${c.label} (${c.host})` })),
        { value: '', label: 'Authenticate manually (no stored credential)' },
      ];
      const defaultCredential =
        detected.boundCredentialId &&
        detected.credentials.some((c) => c.id === detected.boundCredentialId)
          ? detected.boundCredentialId
          : '';
      fields.push(
        {
          type: 'checkbox',
          id: 'pushToOrigin',
          label: `Push to origin (${detected.originUrl ? redactGitUrl(detected.originUrl) : 'origin'}) after committing`,
          default: false,
          visibleWhen: { field: 'commit', equals: true },
        },
        {
          type: 'select',
          id: 'credentialId',
          label: 'Credential to push with',
          description:
            'Used only for this push; the token is never written to git config. Choose "manually" for SSH or public remotes.',
          options: credentialOptions,
          default: defaultCredential,
          visibleWhen: { field: 'pushToOrigin', equals: true },
        },
        {
          type: 'checkbox',
          id: 'setUpstream',
          label: 'Set upstream (-u) so future pushes default to origin',
          default: true,
          visibleWhen: { field: 'pushToOrigin', equals: true },
        },
      );
    }
    if (detected.originError) {
      fields.push({
        type: 'note',
        id: 'originUnreadable',
        label: 'Origin remote not read',
        body: `Pushing is not offered: ${detected.originError}. Fix the git configuration and Retry this step to see it.`,
        variant: 'warning',
      });
    }

    return {
      title: 'Post-onboarding actions',
      description: 'You can commit the generated workflow files now or skip and commit later.',
      fields,
      submitLabel: 'Finish onboarding',
    };
  },

  async apply(ctx, args): Promise<PostOnboardingOutput> {
    const values = args.formValues;
    const warnings: string[] = [];
    let commitPerformed = false;
    let commitSha: string | null = null;
    const stagedPaths: string[] = [];
    let pushRequested = false;
    let pushCredentialId: string | null = null;
    let pushSetUpstream = true;

    // Always record artifacts, independent of the commit
    // checkbox — versioning metadata must be in place whether or not the user
    // opts into an immediate commit here.
    let artifactRowsWritten = 0;
    let renderContext: TemplateRenderContext | null = null;
    let rtkChoiceRecorded = false;
    let expectedColumns: unknown[] | undefined;
    try {
      const genPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '07-generate-files');
      const detect = genPrev?.detect ? (genPrev.detect as GenerateFilesDetect) : null;
      const generatedOverride = (genPrev?.output as GenerateFilesApply | null)?.agentRulesOverride;
      // Derived ahead of the recording, which the project state record below must not depend on.
      renderContext = detect ? buildRenderContext(detect) : null;
      const renderedContext = renderContext;
      expectedColumns =
        detect?.renderContextColumn !== undefined && renderContext
          ? [
              detect.renderContextColumn,
              renderContextColumnFor(
                renderContext,
                detect.rtkEnabled !== undefined,
                detect.renderContextColumn,
              ),
            ]
          : undefined;
      // A 07 output from before RTK shipped made no choice; buildRenderContext defaults it off.
      rtkChoiceRecorded = detect?.rtkEnabled !== undefined;
      if (renderContext)
        renderContext = await completeLegacyOnboardingContext(
          ctx,
          renderContext,
          rtkChoiceRecorded,
          detect?.renderContextColumn,
        );
      const res = await recordOnboardingArtifacts(
        ctx,
        detect,
        renderContext,
        renderedContext,
        generatedOverride,
      );
      artifactRowsWritten = res.rowsWritten;
      warnings.push(...res.warnings);
    } catch (err) {
      if (err instanceof OnboardingMembershipReplanError) throw err;
      const message = safeErrorMessage(err);
      warnings.push(`onboarding-artifacts recording failed: ${message}`);
      ctx.logger.warn({ err }, 'onboarding-artifacts recording failed');
    }

    // The files this step writes itself, which it stages by name below.
    const ownFiles: string[] = [];
    const ownRemoved: string[] = [];
    let recordWrite: PostOnboardingOutput['recordWrite'] = 'skipped';

    const result = (): PostOnboardingOutput => ({
      commitPerformed,
      commitSha,
      stagedPaths,
      warnings,
      artifactRowsWritten,
      pushRequested,
      pushCredentialId,
      pushSetUpstream,
      recordWrite,
    });

    // Write the committed .haive-data/ mirror from the onboarding_* columns so a
    // fresh clone restores its onboarding-derived DB state. Always runs (like the
    // artifact recording above); staged by name when committing.
    const mirrorTaskRow = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    const mirrorRepositoryId = mirrorTaskRow[0]?.repositoryId ?? null;
    if (mirrorRepositoryId) {
      let recorded = false;
      if (renderContext) {
        try {
          const state = await writeProjectStateRecord(ctx.db, {
            repositoryId: mirrorRepositoryId,
            repoPath: ctx.repoPath,
            context: renderContext,
            rtkChoiceRecorded,
            expectedColumns,
            holdingTaskId: ctx.taskId,
          });
          recorded = true;
          recordWrite = 'written';
          ownFiles.push(...state.written);
          ownRemoved.push(...state.removed);
          if ((await retireInstallManifest(ctx, warnings)) !== 'kept') {
            ownRemoved.push(INSTALL_MANIFEST_PATH);
          }
          const keep = (await toolingOutsideRecord(ctx.db, mirrorRepositoryId))
            ? [HAIVE_DATA_FILES.tooling]
            : [];
          for (const { path, outcome } of await retireLegacyMirrors(ctx, warnings, keep)) {
            if (outcome !== 'kept') ownRemoved.push(path);
          }
        } catch (err) {
          failIfColumnStale(err);
          recordWrite = 'failed';
          if (err instanceof ProjectStateWriteError) {
            ownFiles.push(...err.written);
            ownRemoved.push(...err.removed);
          }
          const message = safeErrorMessage(err);
          warnings.push(`project state record write failed: ${message}`);
          ctx.logger.warn({ err }, 'project state record write failed');
          if (!recorded) {
            try {
              // Nothing is retired now, but an earlier attempt may have: list it only if proven gone.
              if (
                (await lstatNoFollow(ctx.repoPath, INSTALL_MANIFEST_PATH, { strict: true })) ===
                null
              ) {
                ownRemoved.push(INSTALL_MANIFEST_PATH);
              }
            } catch (lookupErr) {
              const cause = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
              warnings.push(
                `${INSTALL_MANIFEST_PATH} was not listed as removed: it could not be checked: ${cause}`,
              );
            }
          }
        }
      }
      try {
        const res = await writeHaiveDataMirror(
          ctx,
          mirrorRepositoryId,
          ownFiles,
          ownRemoved,
          !recorded,
        );
        warnings.push(...res.warnings);
      } catch (err) {
        const message = safeErrorMessage(err);
        warnings.push(`haive-data mirror write failed: ${message}`);
        ctx.logger.warn({ err }, 'haive-data mirror write failed');
      }
    }

    if (values.commit !== true) {
      return result();
    }

    const taskRow = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    // A person's own file 07 left untouched is theirs to commit, however a template names it.
    const generated = await loadPreviousStepOutput(ctx.db, ctx.taskId, '07-generate-files');
    const leftAsIs = new Set((generated?.output as GenerateFilesApply | null)?.leftAsIs ?? []);
    const plan = await resolveStagePlan(
      ctx,
      taskRow[0]?.repositoryId ?? null,
      ownFiles,
      ownRemoved,
    );
    const existingPaths: string[] = [];
    for (const rel of plan.add) {
      if (leftAsIs.has(rel)) continue;
      if ((await lstatNoFollow(ctx.repoPath, rel)) !== null) existingPaths.push(rel);
    }
    // A removal has nothing on disk to name, and only while the path is still absent.
    const removedPaths: string[] = [];
    for (const rel of plan.remove) {
      if (leftAsIs.has(rel)) continue;
      if ((await lstatNoFollow(ctx.repoPath, rel)) === null) removedPaths.push(rel);
    }

    if (existingPaths.length === 0 && removedPaths.length === 0) {
      warnings.push('no generated files found to stage');
      ctx.logger.warn('post-onboarding: no existing paths to stage');
      return result();
    }

    try {
      // Uploaded / in-place repos carry no git history, so `git add` dies with
      // "fatal: not a git repository". Create the repo first, then stage the WHOLE
      // working tree: `git worktree add` checks out tracked files only, so a first
      // commit holding just the generated files would hand every later workflow task
      // an empty project. A .gitignore already on disk is honoured by `add -A`.
      // requireUsableGit rather than detect.hasGit: it throws on a `.git` git refuses
      // (corruption gets reported, never initialized over) and it re-reads state detect
      // may have missed, e.g. a Terminal-tab `git init`.
      let didInit = false;
      if (!(await requireUsableGit(ctx.repoPath))) {
        const initBranch =
          (typeof values.initBranch === 'string' ? values.initBranch : '').trim() || 'main';
        await initGitWorkspace(ctx.repoPath, initBranch);
        didInit = true;
        await gitExec(['add', '-A'], { cwd: ctx.repoPath, maxBuffer: GIT_MAX_BUFFER });
        ctx.logger.info({ initBranch }, 'post-onboarding: initialized git repository');
      }
      // After any init, so a repository that had no git yet is checked against its .gitignore too.
      const { keep, warnings: ignored } = await dropIgnoredRulesFiles(
        ctx.repoPath,
        existingPaths,
        new Set([...EXTRA_RULES_STAGE_PATHS, ...RTK_SETTINGS_PATHS]),
      );
      warnings.push(...ignored);
      const message =
        typeof values.commitMessage === 'string' && values.commitMessage.trim().length > 0
          ? values.commitMessage
          : didInit
            ? INIT_COMMIT_MESSAGE
            : DEFAULT_COMMIT_MESSAGE;
      const resolved = await resolveGitEnv(ctx.db, { userId: ctx.userId, taskId: ctx.taskId });
      const identity = Object.keys(resolved).length > 0 ? resolved : FALLBACK_GIT_IDENTITY;
      const commitEnv = { ...process.env, ...identity };
      let staged: string[];
      if (didInit) {
        // The first commit of a new repository holds the whole index on purpose.
        await stageNamed(ctx.repoPath, keep, removedPaths);
        staged = await stagedChanges(ctx.repoPath);
        if (staged.length > 0) {
          await gitExec(['commit', '-m', message], {
            cwd: ctx.repoPath,
            env: commitEnv,
            maxBuffer: GIT_MAX_BUFFER,
          });
        }
      } else {
        // Any other commit is built in a private index, so what the person staged stays theirs.
        const plan = { add: keep, remove: removedPaths };
        staged = await commitRecorded(ctx.repoPath, plan, message, commitEnv, warnings);
      }
      stagedPaths.push(...staged);

      if (staged.length === 0) {
        warnings.push('no changes to commit (files already committed or identical)');
        ctx.logger.info('post-onboarding: nothing staged after git add');
        return result();
      }

      const { stdout } = await gitExec(['rev-parse', 'HEAD'], { cwd: ctx.repoPath });
      commitSha = stdout.trim();
      commitPerformed = true;
      // Hand the push choices to 13-onboarding-push, only now that the commit landed.
      // pushToOrigin is offered on the form only when detect saw a pushable origin.
      if (values.pushToOrigin === true) {
        pushRequested = true;
        pushCredentialId =
          typeof values.credentialId === 'string' && values.credentialId.length > 0
            ? values.credentialId
            : null;
        pushSetUpstream = values.setUpstream !== false;
      }
    } catch (err) {
      const message = safeErrorMessage(err);
      ctx.logger.warn({ err }, 'post-onboarding commit failed');
      // The user explicitly asked to commit; a git failure must be loud, not a silent
      // `done` with a buried warning. The artifacts, the .haive-data mirror, and the
      // artifact rows are already written, so a Retry re-attempts safely.
      // Keep the cause so the runner and queue boundary still recognize bound queries.
      throw new Error(`Staging or committing the generated files failed: ${message}`, {
        cause: err,
      });
    }

    ctx.logger.info(
      {
        commitPerformed,
        commitSha,
        staged: stagedPaths.length,
        pushRequested,
        warnings,
        artifactRowsWritten,
      },
      'post-onboarding apply complete',
    );
    return result();
  },
};

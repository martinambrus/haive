import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import type {
  CliProviderName,
  FormSchema,
  OnboardingEnvironmentMirror,
  OnboardingExclusionsMirror,
  OnboardingToolingMirror,
} from '@haive/shared';
import {
  buildCliRulesBlock,
  CLI_RULES_DISK_PATH,
  CLI_RULES_SCHEMA_VERSION,
  CLI_RULES_TEMPLATE_ID,
  CLI_RULES_TEMPLATE_KIND,
  getCliProviderMetadata,
  getHaiveVersion,
  HAIVE_DATA_FILES,
  normalizeContent,
  ONBOARDING_EXCLUSIONS_SCHEMA_VERSION,
  ONBOARDING_TOOLING_INFRA_KEYS,
  sha256Hex,
} from '@haive/shared';
import type { Database } from '@haive/database';
import type { StepDefinition, StepContext } from '../../step-definition.js';
import { resolveGitEnv } from '../../../secrets/user-git-identity.js';
import { loadPreviousStepOutput, pathExists, resolveSkillTargetDirs } from './_helpers.js';
import {
  expandCustomBundlesFor,
  expandManifestFor,
  getTemplateManifest,
  updateApplicableTemplateIds,
  type ExpandedRendering,
  type TemplateRenderContext,
} from '../../template-manifest.js';
import { extractBundleItemId, loadBundlesForExpansion } from '../../_custom-bundle-loader.js';
import { writeInstallManifestFromLiveRows } from '../../_install-manifest.js';
import type { GenerateFilesDetect } from './07-generate-files.js';

const exec = promisify(execFile);

const DEFAULT_COMMIT_MESSAGE = [
  'add: agentic workflow setup',
  '',
  'Generated .claude/ (agents, skills, knowledge base) and the updated .gitignore.',
].join('\n');

const BASE_STAGE_PATHS = [
  '.gitignore',
  '.claude/agents/',
  '.claude/skills/',
  '.claude/knowledge_base/',
  '.claude/workflow/',
  '.claude/mcp_settings.json',
  '.claude/workflow-checkpoint.json',
  '.claude/project-config.yaml',
  '.haive/install.json',
  // Committed onboarding mirror (environment/tooling/exclusions), so a fresh
  // clone restores its onboarding-derived DB state. A distinct dir from `.haive/`
  // (which workflow tasks add to `.git/info/exclude`), so it is never excluded.
  '.haive-data/',
];

// Rules files onboarding writes that are NOT tracked as onboarding_artifacts, so
// the artifact union below would miss them: the import stubs (CLAUDE.md/GEMINI.md)
// and the gemini RTK settings. AGENTS.md is listed too as a fallback for the
// no-provider-rules case, where it holds only the project-info block and is untracked.
const EXTRA_RULES_STAGE_PATHS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.gemini/settings.json'];

async function resolveStagePaths(
  db: Database,
  userId: string,
  repositoryId: string | null,
): Promise<string[]> {
  const providerRows = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.userId, userId),
    columns: { name: true, enabled: true },
  });
  const paths = new Set<string>([...BASE_STAGE_PATHS, ...EXTRA_RULES_STAGE_PATHS]);
  for (const row of providerRows) {
    if (!row.enabled) continue;
    const meta = getCliProviderMetadata(row.name as CliProviderName);
    if (meta.projectAgentsDir) paths.add(`${meta.projectAgentsDir}/`);
    if (meta.projectSkillsDir) paths.add(`${meta.projectSkillsDir}/`);
  }
  // Stage every tracked onboarding artifact for this repo so the AGENTS.md
  // cli-rules region, RTK settings, workflow-config, commands, Drupal LSP, and any
  // future tracked template are committed without having to re-list them here.
  if (repositoryId) {
    const artifactRows = await db
      .select({ diskPath: schema.onboardingArtifacts.diskPath })
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, repositoryId),
          isNull(schema.onboardingArtifacts.supersededAt),
        ),
      );
    for (const r of artifactRows) paths.add(r.diskPath);
  }
  return [...paths];
}

/** Used only when neither the repo's bound credential nor the user carries an identity,
 *  preserving the bot attribution these commits have always had. */
const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive Worker',
  GIT_AUTHOR_EMAIL: 'haive@local',
  GIT_COMMITTER_NAME: 'Haive Worker',
  GIT_COMMITTER_EMAIL: 'haive@local',
};

interface PostOnboardingOutput {
  commitPerformed: boolean;
  commitSha: string | null;
  stagedPaths: string[];
  warnings: string[];
  artifactRowsWritten: number;
  installManifestWritten: boolean;
}

/** Build the deterministic render context from step 07's detect output. Used
 *  to expand the template manifest against the real per-repo inputs so the
 *  artifact rows and install.json reflect what was actually rendered. */
function buildRenderContext(detect: GenerateFilesDetect): TemplateRenderContext {
  return {
    projectInfo: detect.projectInfo,
    framework: detect.framework,
    acceptedAgentIds: detect.acceptedAgentIds,
    customAgentSpecs: detect.customAgentSpecs,
    agentTargets: detect.agentTargets,
    lspLanguages: detect.lspLanguages,
    rtkEnabled: detect.rtkEnabled ?? false,
    enabledCliProviders: detect.enabledCliProviders ?? [],
  };
}

/** Record onboarding_artifacts rows and write `.haive/install.json`. Runs
 *  always (not gated by the commit checkbox) so versioning is in place even
 *  when the user defers committing. Idempotent on re-runs: upstream step
 *  machine guarantees 12-post-onboarding.apply runs once per task. */
async function recordOnboardingArtifacts(
  ctx: StepContext,
): Promise<{ rowsWritten: number; installManifestWritten: boolean; warnings: string[] }> {
  const warnings: string[] = [];

  const genPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '07-generate-files');
  if (!genPrev || !genPrev.detect) {
    warnings.push('onboarding-artifacts: 07-generate-files detect output missing, skipping');
    ctx.logger.warn('onboarding-artifacts: cannot record — step 07 detect output missing');
    return { rowsWritten: 0, installManifestWritten: false, warnings };
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
    return { rowsWritten: 0, installManifestWritten: false, warnings };
  }

  const detect = genPrev.detect as GenerateFilesDetect;
  const renderCtx = buildRenderContext(detect);
  const manifest = getTemplateManifest();
  const haiveExpanded = expandManifestFor(renderCtx, manifest);

  // Custom-bundle expansion runs in parallel with manifest expansion; the two
  // are concatenated and de-duped on diskPath (Haive items win on collision —
  // this should not happen in practice since Haive paths and bundle paths
  // never overlap by convention, but we log+drop just in case).
  const bundlesForInstall = await loadBundlesForExpansion(ctx.db, repositoryId, ctx.logger);
  const skillTargets = await resolveSkillTargetDirs(ctx.db, ctx.userId);
  const customExpanded = expandCustomBundlesFor(
    bundlesForInstall,
    detect.agentTargets,
    skillTargets,
  );
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

  // The AGENTS.md cli-rules region is per-repo (depends on the user's enabled
  // providers' rules), so it is tracked as a region-scoped artifact rather than
  // a manifest template. detect.cliProviders is already enabled+non-empty and
  // sorted by name, so the block and its hash are deterministic and match the
  // API's drift recompute. diskPath 'AGENTS.md' carries no other live artifact
  // row, so the (repository_id, disk_path) unique index stays satisfied.
  const cliRulesBlock = buildCliRulesBlock(detect.cliProviders.map((p) => p.rulesContent));
  if (cliRulesBlock) {
    const writtenHash = sha256Hex(normalizeContent(cliRulesBlock));
    expanded.push({
      templateId: CLI_RULES_TEMPLATE_ID,
      templateKind: CLI_RULES_TEMPLATE_KIND,
      templateSchemaVersion: CLI_RULES_SCHEMA_VERSION,
      templateContentHash: writtenHash,
      diskPath: CLI_RULES_DISK_PATH,
      content: cliRulesBlock,
      writtenHash,
    });
  }

  if (expanded.length === 0) {
    ctx.logger.info('onboarding-artifacts: manifest produced no renderings for this context');
    return { rowsWritten: 0, installManifestWritten: false, warnings };
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

  await ctx.db.insert(schema.onboardingArtifacts).values(rows);
  await updateApplicableTemplateIds(ctx.db, repositoryId, expanded);

  const installManifestWritten = await writeInstallManifestFromLiveRows(
    ctx,
    repositoryId,
    manifest.setHash,
  );

  ctx.logger.info(
    {
      rowsWritten: rows.length,
      templateSetHash: manifest.setHash,
      installPath: '.haive/install.json',
    },
    'onboarding-artifacts recorded',
  );

  return { rowsWritten: rows.length, installManifestWritten, warnings };
}

/** Write the committed `.haive-data/` onboarding mirror from the repo's
 *  onboarding_* columns (already populated by steps 02/04/06_7). A fresh clone
 *  on another machine restores its onboarding-derived DB state from these files
 *  via persistDetection, since the onboarding task's rows never travel. Runs
 *  always (independent of the commit checkbox); the files are staged by
 *  resolveStagePaths (BASE_STAGE_PATHS) when the user opts into a commit. The
 *  tooling file drops the machine-specific infra keys (ollamaUrl,
 *  ragConnectionString) — those do not move between machines. */
async function writeHaiveDataMirror(
  ctx: StepContext,
  repositoryId: string,
): Promise<{ filesWritten: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const filesWritten: string[] = [];

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
    return { filesWritten, warnings };
  }

  const writeJson = async (rel: string, value: unknown): Promise<void> => {
    const abs = path.join(ctx.repoPath, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    filesWritten.push(rel);
  };

  const env = repo.onboardingEnvironment as OnboardingEnvironmentMirror | null;
  if (env) await writeJson(HAIVE_DATA_FILES.environment, env);

  const tooling = repo.onboardingTooling as OnboardingToolingMirror | null;
  if (tooling?.tooling) {
    const stripped: Record<string, unknown> = { ...tooling.tooling };
    for (const k of ONBOARDING_TOOLING_INFRA_KEYS) delete stripped[k];
    const mirror: OnboardingToolingMirror = {
      schemaVersion: tooling.schemaVersion,
      tooling: stripped,
    };
    await writeJson(HAIVE_DATA_FILES.tooling, mirror);
  }

  const globs = repo.scopeExcludeGlobs as string[] | null;
  if (globs) {
    const mirror: OnboardingExclusionsMirror = {
      schemaVersion: ONBOARDING_EXCLUSIONS_SCHEMA_VERSION,
      scopeExcludeGlobs: globs,
    };
    await writeJson(HAIVE_DATA_FILES.exclusions, mirror);
  }

  if (filesWritten.length > 0) {
    ctx.logger.info({ filesWritten }, 'haive-data onboarding mirror written');
  }
  return { filesWritten, warnings };
}

export const postOnboardingStep: StepDefinition<Record<string, never>, PostOnboardingOutput> = {
  metadata: {
    id: '12-post-onboarding',
    workflowType: 'onboarding',
    index: 16,
    title: 'Post-onboarding commit',
    description: 'Optionally commits the generated workflow files.',
    requiresCli: false,
  },

  async detect(): Promise<Record<string, never>> {
    return {};
  },

  form(): FormSchema {
    return {
      title: 'Post-onboarding actions',
      description: 'You can commit the generated workflow files now or skip and commit later.',
      fields: [
        {
          type: 'checkbox',
          id: 'commit',
          label: 'Stage and commit generated workflow files',
          default: false,
        },
        {
          type: 'textarea',
          id: 'commitMessage',
          label: 'Commit message',
          default: DEFAULT_COMMIT_MESSAGE,
          rows: 6,
        },
      ],
      submitLabel: 'Finish onboarding',
    };
  },

  async apply(ctx, args): Promise<PostOnboardingOutput> {
    const values = args.formValues;
    const warnings: string[] = [];
    let commitPerformed = false;
    let commitSha: string | null = null;
    const stagedPaths: string[] = [];

    // Always record artifacts + write install.json, independent of the commit
    // checkbox — versioning metadata must be in place whether or not the user
    // opts into an immediate commit here.
    let artifactRowsWritten = 0;
    let installManifestWritten = false;
    try {
      const res = await recordOnboardingArtifacts(ctx);
      artifactRowsWritten = res.rowsWritten;
      installManifestWritten = res.installManifestWritten;
      warnings.push(...res.warnings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`onboarding-artifacts recording failed: ${message}`);
      ctx.logger.warn({ err }, 'onboarding-artifacts recording failed');
    }

    // Write the committed .haive-data/ mirror from the onboarding_* columns so a
    // fresh clone restores its onboarding-derived DB state. Always runs (like the
    // artifact recording above); staged by resolveStagePaths when committing.
    const mirrorTaskRow = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    const mirrorRepositoryId = mirrorTaskRow[0]?.repositoryId ?? null;
    if (mirrorRepositoryId) {
      try {
        const res = await writeHaiveDataMirror(ctx, mirrorRepositoryId);
        warnings.push(...res.warnings);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`haive-data mirror write failed: ${message}`);
        ctx.logger.warn({ err }, 'haive-data mirror write failed');
      }
    }

    if (values.commit !== true) {
      return {
        commitPerformed,
        commitSha,
        stagedPaths,
        warnings,
        artifactRowsWritten,
        installManifestWritten,
      };
    }

    const taskRow = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    const stagePaths = await resolveStagePaths(
      ctx.db,
      ctx.userId,
      taskRow[0]?.repositoryId ?? null,
    );
    const existingPaths: string[] = [];
    for (const rel of stagePaths) {
      if (await pathExists(path.join(ctx.repoPath, rel))) existingPaths.push(rel);
    }

    if (existingPaths.length === 0) {
      warnings.push('no generated files found to stage');
      ctx.logger.warn('post-onboarding: no existing paths to stage');
      return {
        commitPerformed,
        commitSha,
        stagedPaths,
        warnings,
        artifactRowsWritten,
        installManifestWritten,
      };
    }

    try {
      await exec('git', ['add', '--', ...existingPaths], { cwd: ctx.repoPath });
      const { stdout: stagedOut } = await exec('git', ['diff', '--cached', '--name-only'], {
        cwd: ctx.repoPath,
      });
      const staged = stagedOut
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      stagedPaths.push(...staged);

      if (staged.length === 0) {
        warnings.push('no changes to commit (files already committed or identical)');
        ctx.logger.info('post-onboarding: nothing staged after git add');
        return {
          commitPerformed,
          commitSha,
          stagedPaths,
          warnings,
          artifactRowsWritten,
          installManifestWritten,
        };
      }

      const message =
        typeof values.commitMessage === 'string' && values.commitMessage.trim().length > 0
          ? values.commitMessage
          : DEFAULT_COMMIT_MESSAGE;
      const resolved = await resolveGitEnv(ctx.db, { userId: ctx.userId, taskId: ctx.taskId });
      const identity = Object.keys(resolved).length > 0 ? resolved : FALLBACK_GIT_IDENTITY;
      await exec('git', ['commit', '-m', message], {
        cwd: ctx.repoPath,
        env: { ...process.env, ...identity },
      });
      const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: ctx.repoPath });
      commitSha = stdout.trim();
      commitPerformed = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`commit failed: ${message}`);
      ctx.logger.warn({ err }, 'post-onboarding commit failed');
    }

    ctx.logger.info(
      {
        commitPerformed,
        commitSha,
        staged: stagedPaths.length,
        warnings,
        artifactRowsWritten,
        installManifestWritten,
      },
      'post-onboarding apply complete',
    );
    return {
      commitPerformed,
      commitSha,
      stagedPaths,
      warnings,
      artifactRowsWritten,
      installManifestWritten,
    };
  },
};

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { CliProviderName, FormSchema } from '@haive/shared';
import { getCliProviderMetadata, getHaiveVersion } from '@haive/shared';
import type { Database } from '@haive/database';
import type { StepDefinition, StepContext } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from './_helpers.js';
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
];

async function resolveStagePaths(db: Database, userId: string): Promise<string[]> {
  const providerRows = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.userId, userId),
    columns: { name: true, enabled: true },
  });
  const extra = new Set<string>();
  for (const row of providerRows) {
    if (!row.enabled) continue;
    const meta = getCliProviderMetadata(row.name as CliProviderName);
    if (meta.projectAgentsDir) extra.add(`${meta.projectAgentsDir}/`);
    if (meta.projectSkillsDir) extra.add(`${meta.projectSkillsDir}/`);
  }
  return [...BASE_STAGE_PATHS, ...Array.from(extra)];
}

const GIT_IDENTITY = ['-c', 'user.email=haive@local', '-c', 'user.name=Haive Worker'];

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
    prefs: detect.prefs,
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
  const skillTargets = await resolveSkillTargets(ctx.db, ctx.userId);
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

    const stagePaths = await resolveStagePaths(ctx.db, ctx.userId);
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
      await exec('git', [...GIT_IDENTITY, 'commit', '-m', message], { cwd: ctx.repoPath });
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

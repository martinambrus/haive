import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { CliProviderName, FormSchema, InstallManifest } from '@haive/shared';
import { getCliProviderMetadata, getHaiveVersion, normalizeContent } from '@haive/shared';
import type { Database } from '@haive/database';
import type { StepDefinition, StepContext } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from './_helpers.js';
import {
  expandManifestFor,
  getTemplateManifest,
  updateApplicableTemplateIds,
  type TemplateRenderContext,
} from '../../template-manifest.js';
import type { GenerateFilesDetect } from './07-generate-files.js';

const exec = promisify(execFile);

const DEFAULT_COMMIT_MESSAGE = [
  'add: agentic workflow setup',
  '',
  'Generated .claude/ (agents, skills, knowledge base, commands, workflow',
  'steps, RAG scripts) and the updated .gitignore.',
].join('\n');

const BASE_STAGE_PATHS = [
  '.gitignore',
  '.claude/commands/',
  '.claude/agents/',
  '.claude/skills/',
  '.claude/knowledge_base/',
  '.claude/workflow/',
  '.claude/rag/',
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
  const expanded = expandManifestFor(renderCtx, manifest);

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
    sourceStepId: '07-generate-files',
    source: 'onboarding' as const,
    haiveVersion,
  }));

  await ctx.db.insert(schema.onboardingArtifacts).values(rows);
  await updateApplicableTemplateIds(ctx.db, repositoryId, expanded);

  const byTemplate = new Map<
    string,
    { id: string; schemaVersion: number; contentHash: string; diskPaths: string[] }
  >();
  for (const r of expanded) {
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
    haiveVersion,
    appliedAt: new Date().toISOString(),
    lastTaskId: ctx.taskId,
    templateSetHash: manifest.setHash,
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
    {
      rowsWritten: rows.length,
      templateSetHash: manifest.setHash,
      installPath: '.haive/install.json',
    },
    'onboarding-artifacts recorded',
  );

  return { rowsWritten: rows.length, installManifestWritten: true, warnings };
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

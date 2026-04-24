import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { CliProviderName, FormSchema } from '@haive/shared';
import { getCliProviderMetadata } from '@haive/shared';
import type { Database } from '@haive/database';
import type { StepDefinition } from '../../step-definition.js';
import { pathExists } from './_helpers.js';

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

    if (values.commit !== true) {
      return { commitPerformed, commitSha, stagedPaths, warnings };
    }

    const stagePaths = await resolveStagePaths(ctx.db, ctx.userId);
    const existingPaths: string[] = [];
    for (const rel of stagePaths) {
      if (await pathExists(path.join(ctx.repoPath, rel))) existingPaths.push(rel);
    }

    if (existingPaths.length === 0) {
      warnings.push('no generated files found to stage');
      ctx.logger.warn('post-onboarding: no existing paths to stage');
      return { commitPerformed, commitSha, stagedPaths, warnings };
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
        return { commitPerformed, commitSha, stagedPaths, warnings };
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
      { commitPerformed, commitSha, staged: stagedPaths.length, warnings },
      'post-onboarding apply complete',
    );
    return { commitPerformed, commitSha, stagedPaths, warnings };
  },
};

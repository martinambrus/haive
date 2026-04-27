import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { CliProviderName, FormSchema } from '@haive/shared';
import { getCliProviderMetadata } from '@haive/shared';
import type { Database } from '@haive/database';
import type { StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';

const execFileAsync = promisify(execFile);

const DEFAULT_COMMIT_MESSAGE = [
  'chore: apply Haive onboarding upgrade',
  '',
  'Applies selected template updates from the onboarding-upgrade workflow.',
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

interface UpgradeCommitOutput {
  commitPerformed: boolean;
  commitSha: string | null;
  stagedPaths: string[];
  warnings: string[];
}

export const upgradeCommitStep: StepDefinition<Record<string, never>, UpgradeCommitOutput> = {
  metadata: {
    id: '03-upgrade-commit',
    workflowType: 'onboarding_upgrade',
    index: 3,
    title: 'Commit upgrade',
    description: 'Optionally stage and commit the applied upgrade changes.',
    requiresCli: false,
  },

  async shouldRun(ctx) {
    const { shouldRunUpgrade } = await import('./04-upgrade-rollback.js');
    return shouldRunUpgrade(ctx);
  },

  async detect(): Promise<Record<string, never>> {
    return {};
  },

  form(): FormSchema {
    return {
      title: 'Commit upgrade changes',
      description: 'Stage and commit the files the upgrade wrote, or skip and commit later.',
      fields: [
        {
          type: 'checkbox',
          id: 'commit',
          label: 'Stage and commit upgrade changes',
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
      submitLabel: 'Finish upgrade',
    };
  },

  async apply(ctx, args): Promise<UpgradeCommitOutput> {
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
      warnings.push('no upgrade files found to stage');
      return { commitPerformed, commitSha, stagedPaths, warnings };
    }

    try {
      await execFileAsync('git', ['add', '--', ...existingPaths], { cwd: ctx.repoPath });
      const { stdout: stagedOut } = await execFileAsync(
        'git',
        ['diff', '--cached', '--name-only'],
        { cwd: ctx.repoPath },
      );
      const staged = stagedOut
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      stagedPaths.push(...staged);

      if (staged.length === 0) {
        warnings.push('no changes to commit (files already committed or identical)');
        return { commitPerformed, commitSha, stagedPaths, warnings };
      }

      const message =
        typeof values.commitMessage === 'string' && values.commitMessage.trim().length > 0
          ? values.commitMessage
          : DEFAULT_COMMIT_MESSAGE;
      await execFileAsync('git', [...GIT_IDENTITY, 'commit', '-m', message], { cwd: ctx.repoPath });
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ctx.repoPath });
      commitSha = stdout.trim();
      commitPerformed = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`commit failed: ${message}`);
      ctx.logger.warn({ err }, 'upgrade-commit failed');
    }

    return { commitPerformed, commitSha, stagedPaths, warnings };
  },
};

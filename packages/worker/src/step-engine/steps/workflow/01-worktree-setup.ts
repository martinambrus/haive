import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';

const exec = promisify(execFile);

interface WorktreeDetect {
  hasGit: boolean;
  currentBranch: string | null;
  isClean: boolean;
}

interface WorktreeApply {
  mode: 'no-git' | 'inplace' | 'worktree';
  worktreePath: string;
  branchName: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function gitRun(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec('git', args, { cwd });
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export const worktreeSetupStep: StepDefinition<WorktreeDetect, WorktreeApply> = {
  metadata: {
    id: '01-worktree-setup',
    workflowType: 'workflow',
    index: 1,
    title: 'Worktree setup',
    description:
      'Prepares the workspace for the autonomous workflow. Optionally creates a git worktree on a feature branch so work is isolated from the main checkout.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<WorktreeDetect> {
    const gitDir = path.join(ctx.repoPath, '.git');
    const hasGit = await pathExists(gitDir);
    if (!hasGit) {
      return { hasGit: false, currentBranch: null, isClean: true };
    }
    const branch = await gitRun(ctx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = await gitRun(ctx.repoPath, ['status', '--porcelain']);
    return {
      hasGit: true,
      currentBranch: branch.code === 0 ? branch.stdout.trim() : null,
      isClean: status.code === 0 && status.stdout.trim().length === 0,
    };
  },

  form(_ctx, detected): FormSchema {
    const description = detected.hasGit
      ? `Current branch: ${detected.currentBranch ?? 'unknown'}. Working tree ${detected.isClean ? 'clean' : 'dirty'}.`
      : 'No git repository detected. Worktree creation will be skipped.';
    return {
      title: 'Worktree setup',
      description,
      fields: [
        {
          type: 'text',
          id: 'branchName',
          label: 'Feature branch name',
          placeholder: 'feature/my-change',
          required: true,
        },
        {
          type: 'checkbox',
          id: 'useWorktree',
          label: 'Create a separate git worktree for this task',
          default: detected.hasGit,
        },
        {
          type: 'text',
          id: 'baseBranch',
          label: 'Base branch',
          default: detected.currentBranch ?? 'main',
        },
      ],
      submitLabel: 'Prepare workspace',
    };
  },

  async apply(ctx, args): Promise<WorktreeApply> {
    const values = args.formValues as {
      branchName?: string;
      useWorktree?: boolean;
      baseBranch?: string;
    };
    const branchName = slugify(values.branchName ?? 'feature-task');
    if (!args.detected.hasGit) {
      ctx.logger.warn('no git repo; skipping worktree setup');
      return { mode: 'no-git', worktreePath: ctx.workspacePath, branchName };
    }
    if (!values.useWorktree) {
      ctx.logger.info({ branchName }, 'worktree skipped; running in-place');
      return { mode: 'inplace', worktreePath: ctx.workspacePath, branchName };
    }
    const base = values.baseBranch ?? 'main';
    const worktreePath = path.join(
      path.dirname(ctx.repoPath),
      `${path.basename(ctx.repoPath)}-${branchName}`,
    );
    const result = await gitRun(ctx.repoPath, [
      'worktree',
      'add',
      '-b',
      branchName,
      worktreePath,
      base,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `git worktree add failed (exit ${result.code}): ${result.stderr || result.stdout}`,
      );
    }
    ctx.logger.info({ worktreePath, branchName, base }, 'worktree created');
    return { mode: 'worktree', worktreePath, branchName };
  },
};

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

const exec = promisify(execFile);

interface WorktreeCleanupDetect {
  mode: 'no-git' | 'inplace' | 'worktree' | 'unknown';
  worktreePath: string | null;
  branchName: string | null;
}

interface WorktreeCleanupApply {
  removed: boolean;
  mode: WorktreeCleanupDetect['mode'];
  message: string;
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

export const worktreeCleanupStep: StepDefinition<WorktreeCleanupDetect, WorktreeCleanupApply> = {
  metadata: {
    id: '12-worktree-cleanup',
    workflowType: 'workflow',
    index: 14,
    title: 'Worktree cleanup',
    description:
      'Optionally removes the worktree created at workflow start, once all gates are resolved and the change has been committed or discarded.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<WorktreeCleanupDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const output = prev?.output as {
      mode?: string;
      worktreePath?: string;
      branchName?: string;
    } | null;
    if (!output) {
      return { mode: 'unknown', worktreePath: null, branchName: null };
    }
    const mode =
      output.mode === 'worktree' || output.mode === 'inplace' || output.mode === 'no-git'
        ? (output.mode as WorktreeCleanupDetect['mode'])
        : 'unknown';
    return {
      mode,
      worktreePath: output.worktreePath ?? null,
      branchName: output.branchName ?? null,
    };
  },

  form(_ctx, detected): FormSchema {
    const description =
      detected.mode === 'worktree'
        ? `Worktree at ${detected.worktreePath} on branch ${detected.branchName}.`
        : detected.mode === 'inplace'
          ? 'Workflow ran in-place on the existing checkout. No worktree to clean up.'
          : detected.mode === 'no-git'
            ? 'No git repository; nothing to clean up.'
            : 'Worktree setup output unavailable; nothing to clean up.';
    return {
      title: 'Worktree cleanup',
      description,
      fields: [
        {
          type: 'checkbox',
          id: 'removeWorktree',
          label: 'Remove the git worktree now',
          default: detected.mode === 'worktree',
        },
      ],
      submitLabel: 'Finish',
    };
  },

  async apply(ctx, args): Promise<WorktreeCleanupApply> {
    const values = args.formValues as { removeWorktree?: boolean };
    if (!values.removeWorktree) {
      return {
        removed: false,
        mode: args.detected.mode,
        message: 'cleanup skipped by user',
      };
    }
    if (args.detected.mode !== 'worktree' || !args.detected.worktreePath) {
      return {
        removed: false,
        mode: args.detected.mode,
        message: 'no worktree to remove',
      };
    }
    const result = await gitRun(ctx.repoPath, [
      'worktree',
      'remove',
      args.detected.worktreePath,
      '--force',
    ]);
    if (result.code !== 0) {
      ctx.logger.error({ stderr: result.stderr }, 'git worktree remove failed');
      return {
        removed: false,
        mode: 'worktree',
        message: `git worktree remove failed: ${result.stderr || result.stdout}`,
      };
    }
    ctx.logger.info({ worktreePath: args.detected.worktreePath }, 'worktree removed');
    return {
      removed: true,
      mode: 'worktree',
      message: `removed ${args.detected.worktreePath}`,
    };
  },
};

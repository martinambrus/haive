import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';

const exec = promisify(execFile);

interface CommitGateDetect {
  hasGit: boolean;
  workspacePath: string;
  diffSummary: string;
  dirtyFiles: number;
}

interface CommitGateApply {
  committed: boolean;
  commitSha: string | null;
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

export const gate3CommitStep: StepDefinition<CommitGateDetect, CommitGateApply> = {
  metadata: {
    id: '10-gate-3-commit',
    workflowType: 'workflow',
    index: 10,
    title: 'Gate 3: Commit',
    description:
      'Presents the current diff and offers to stage and commit the implementation once the user confirms.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<CommitGateDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const worktreeOutput = prev?.output as { worktreePath?: string } | null;
    const workspacePath = worktreeOutput?.worktreePath ?? ctx.workspacePath;
    const hasGit = await pathExists(path.join(workspacePath, '.git'));
    if (!hasGit) {
      return { hasGit: false, workspacePath, diffSummary: '(no git)', dirtyFiles: 0 };
    }
    const status = await gitRun(workspacePath, ['status', '--porcelain']);
    const dirtyFiles = status.stdout.split('\n').filter((line) => line.trim().length > 0).length;
    const diffStat = await gitRun(workspacePath, ['diff', '--stat', 'HEAD']);
    const summary =
      diffStat.stdout.trim().length > 0
        ? diffStat.stdout.trim().slice(0, 3000)
        : 'No pending changes detected against HEAD.';
    return {
      hasGit: true,
      workspacePath,
      diffSummary: summary,
      dirtyFiles,
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Gate 3: Commit',
      description: [
        `Workspace: ${detected.workspacePath}`,
        `Dirty files: ${detected.dirtyFiles}`,
        '',
        'Diff summary:',
        detected.diffSummary,
      ].join('\n'),
      fields: [
        {
          type: 'checkbox',
          id: 'commit',
          label: 'Stage all changes and commit now',
          default: detected.hasGit && detected.dirtyFiles > 0,
        },
        {
          type: 'textarea',
          id: 'commitMessage',
          label: 'Commit message',
          rows: 4,
          default: 'feat: apply workflow changes',
        },
      ],
      submitLabel: 'Finalise',
    };
  },

  async apply(ctx, args): Promise<CommitGateApply> {
    const values = args.formValues as {
      commit?: boolean;
      commitMessage?: string;
    };
    if (!values.commit) {
      return { committed: false, commitSha: null, message: 'commit skipped' };
    }
    if (!args.detected.hasGit) {
      return { committed: false, commitSha: null, message: 'no git repo' };
    }
    const workspace = args.detected.workspacePath;
    const add = await gitRun(workspace, ['add', '-A']);
    if (add.code !== 0) {
      throw new Error(`git add failed: ${add.stderr || add.stdout}`);
    }
    const message =
      (values.commitMessage ?? 'feat: apply workflow changes').trim() ||
      'feat: apply workflow changes';
    const commit = await gitRun(workspace, ['commit', '-m', message]);
    if (commit.code !== 0) {
      const stderr = commit.stderr || commit.stdout;
      if (/nothing to commit/i.test(stderr)) {
        return {
          committed: false,
          commitSha: null,
          message: 'nothing to commit',
        };
      }
      throw new Error(`git commit failed: ${stderr}`);
    }
    const sha = await gitRun(workspace, ['rev-parse', 'HEAD']);
    const commitSha = sha.code === 0 ? sha.stdout.trim() : null;
    ctx.logger.info({ commitSha, message }, 'workflow commit finalised');
    return { committed: true, commitSha, message };
  },
};

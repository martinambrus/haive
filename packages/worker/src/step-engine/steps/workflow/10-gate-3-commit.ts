import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { resolveUserGitEnv } from '../../../secrets/user-git-identity.js';
import { buildCommitDiffArtifact } from './_commit-diff.js';

const exec = promisify(execFile);

const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};

interface CommitGateDetect {
  hasGit: boolean;
  workspacePath: string;
  diffSummary: string;
  dirtyFiles: number;
  // Absolute path to the worker-written commit-diff artifact, fetched lazily by
  // the web viewer via the existing /files/raw route. null when there is no git
  // repo, no pending changes, or the build failed (viewer is then hidden).
  diffArtifactPath: string | null;
  changedFileCount: number;
  diffArtifactTruncated: boolean;
}

interface CommitGateApply {
  committed: boolean;
  commitSha: string | null;
  message: string;
}

async function gitRun(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const opts = env ? { cwd, env: { ...process.env, ...env } } : { cwd };
    const { stdout, stderr } = await exec('git', args, opts);
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
    // Probe for the `.git` entry before asking git anything. Absent means a genuine
    // no-git workspace; it also stops git's upward discovery from silently reporting
    // the PARENT repo's status for a worktree nested under it.
    if (!(await pathExists(path.join(workspacePath, '.git')))) {
      return {
        hasGit: false,
        workspacePath,
        diffSummary: '(no git)',
        dirtyFiles: 0,
        diffArtifactPath: null,
        changedFileCount: 0,
        diffArtifactTruncated: false,
      };
    }
    // A `.git` that exists still proves nothing: a linked worktree's `.git` is a
    // gitfile whose gitdir can dangle. Present-but-unusable is corruption, not an
    // empty tree — reporting it as "0 dirty files" defaults the commit checkbox off
    // and silently drops the whole changeset.
    const inWorkTree = await gitRun(workspacePath, ['rev-parse', '--is-inside-work-tree']);
    if (inWorkTree.code !== 0 || inWorkTree.stdout.trim() !== 'true') {
      throw new Error(
        `${workspacePath} has a .git entry but git cannot use it: ${
          inWorkTree.stderr.trim() || inWorkTree.stdout.trim() || `exit ${inWorkTree.code}`
        }`,
      );
    }
    const status = await gitRun(workspacePath, ['status', '--porcelain']);
    if (status.code !== 0) {
      throw new Error(
        `git status failed in ${workspacePath}: ${status.stderr.trim() || status.stdout.trim()}`,
      );
    }
    const dirtyFiles = status.stdout.split('\n').filter((line) => line.trim().length > 0).length;
    const diffStat = await gitRun(workspacePath, ['diff', '--stat', 'HEAD']);
    const summary =
      diffStat.stdout.trim().length > 0
        ? diffStat.stdout.trim().slice(0, 3000)
        : 'No pending changes detected against HEAD.';

    // Build the interactive commit-diff artifact for the web viewer. Never fail
    // the gate on a diff-build error — the viewer is simply hidden.
    let diffArtifactPath: string | null = null;
    let changedFileCount = 0;
    let diffArtifactTruncated = false;
    if (dirtyFiles > 0) {
      try {
        const res = await buildCommitDiffArtifact(workspacePath, gitRun);
        diffArtifactPath = res.artifactPath;
        changedFileCount = res.changedFileCount;
        diffArtifactTruncated = res.truncated;
      } catch (err) {
        ctx.logger.warn({ err }, 'failed to build commit diff artifact');
      }
    }

    return {
      hasGit: true,
      workspacePath,
      diffSummary: summary,
      dirtyFiles,
      diffArtifactPath,
      changedFileCount,
      diffArtifactTruncated,
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
    const userEnv = await resolveUserGitEnv(ctx.db, ctx.userId);
    const commitEnv = Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY;
    const commit = await gitRun(workspace, ['commit', '-m', message], commitEnv);
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

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';

const exec = promisify(execFile);

const WORKTREE_SUBDIR = '.haive/worktrees';
const EXCLUDE_MARKER = '.haive/';

interface WorktreeDetect {
  hasGit: boolean;
  currentBranch: string | null;
  isClean: boolean;
}

interface WorktreeApply {
  mode: 'worktree';
  worktreePath: string;
  sandboxWorktreePath: string;
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

async function ensureExcludeEntry(repoPath: string): Promise<void> {
  const excludePath = path.join(repoPath, '.git', 'info', 'exclude');
  await mkdir(path.dirname(excludePath), { recursive: true });
  let content = '';
  try {
    content = await readFile(excludePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const lines = content.split('\n').map((line) => line.trim());
  if (lines.includes(EXCLUDE_MARKER)) return;
  const suffix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  await writeFile(excludePath, `${content}${suffix}${EXCLUDE_MARKER}\n`, 'utf8');
}

export const worktreeSetupStep: StepDefinition<WorktreeDetect, WorktreeApply> = {
  metadata: {
    id: '01-worktree-setup',
    workflowType: 'workflow',
    index: 1,
    title: 'Worktree setup',
    description:
      'Creates a mandatory git worktree inside the repo at .haive/worktrees/<branch>. All subsequent work runs in the worktree, never in the main checkout.',
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
    if (!detected.hasGit) {
      return {
        title: 'Worktree setup',
        description:
          'No git repository detected at the repo root. Worktrees are mandatory for this workflow — open the Terminal tab, run `git init` (and commit your starting state), then click Retry to re-run detection.',
        fields: [],
        submitLabel: 'Retry',
        submitAction: 'retry',
      };
    }
    return {
      title: 'Worktree setup',
      description: `Current branch: ${detected.currentBranch ?? 'unknown'}. Working tree ${detected.isClean ? 'clean' : 'dirty'}. A new worktree will be created inside the repo at .haive/worktrees/<branch>.`,
      fields: [
        {
          type: 'text',
          id: 'branchName',
          label: 'Feature branch name',
          placeholder: 'feature/my-change',
          required: true,
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
    if (!args.detected.hasGit) {
      throw new Error(`worktree setup requires a git repository; none detected at ${ctx.repoPath}`);
    }
    const values = args.formValues as {
      branchName?: string;
      baseBranch?: string;
    };
    const branchName = slugify(values.branchName ?? 'feature-task');
    const base = values.baseBranch ?? 'main';

    await ensureExcludeEntry(ctx.repoPath);

    const worktreePath = path.join(ctx.repoPath, WORKTREE_SUBDIR, branchName);
    const branchExists = await gitRun(ctx.repoPath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branchName}`,
    ]);

    const list = await gitRun(ctx.repoPath, ['worktree', 'list', '--porcelain']);
    const isRegistered =
      list.code === 0 && list.stdout.split('\n').some((l) => l === `worktree ${worktreePath}`);

    if (isRegistered) {
      ctx.logger.info({ worktreePath, branchName }, 'reusing existing worktree');
    } else {
      if (await pathExists(worktreePath)) {
        await gitRun(ctx.repoPath, ['worktree', 'prune']);
        await rm(worktreePath, { recursive: true, force: true });
        ctx.logger.warn({ worktreePath }, 'removed orphan worktree directory before re-add');
      }
      const addArgs =
        branchExists.code === 0
          ? ['worktree', 'add', worktreePath, branchName]
          : ['worktree', 'add', '-b', branchName, worktreePath, base];
      const result = await gitRun(ctx.repoPath, addArgs);
      if (result.code !== 0) {
        throw new Error(
          `git worktree add failed (exit ${result.code}): ${result.stderr || result.stdout}`,
        );
      }
      ctx.logger.info(
        { branchExists: branchExists.code === 0, branchName },
        'worktree branch resolved',
      );
    }

    const sandboxWorktreePath = `${ctx.sandboxWorkdir}/${WORKTREE_SUBDIR}/${branchName}`;
    ctx.logger.info({ worktreePath, sandboxWorktreePath, branchName, base }, 'worktree created');
    return {
      mode: 'worktree',
      worktreePath,
      sandboxWorktreePath,
      branchName,
    };
  },
};

import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormField, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { resolveGitEnv } from '../../../secrets/user-git-identity.js';
import { ensureSandboxWritableTree } from '../../../repo/worktree-permissions.js';
import { ensureGitExcludeEntry, initGitWorkspace } from '../../../repo/git-init.js';
import { findBranchClaimant } from '../../../repo/worktree-claims.js';
import {
  WORKTREE_SUBDIR,
  sandboxWorktreePath,
  worktreeDirName,
} from '../../../repo/worktree-paths.js';

const exec = promisify(execFile);

const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};

interface WorktreeDetect {
  hasGit: boolean;
  currentBranch: string | null;
  isClean: boolean;
  /** Pre-filled feature/fix branch name derived from the task title, bumped past any
   *  name already taken in this repo (`feature/x` -> `feature/x-2`). */
  proposedBranch: string;
  /** The un-bumped proposal when `proposedBranch` had to be suffixed, else null. Drives
   *  the form's collision note — a silently renamed default reads as a bug. */
  proposalBumpedFrom: string | null;
  /** Base branch chosen + freshened by 00a-sync-base. Null when that step skipped
   *  (no git, no origin) or for an older task created before the step existed; the
   *  apply falls back to the parent's current branch in that case. */
  syncedBase: string | null;
}

interface WorktreeApply {
  mode: 'worktree';
  worktreePath: string;
  sandboxWorktreePath: string;
  branchName: string;
  /** The branch the worktree was created FROM. Recorded so 12-worktree-cleanup can
   *  merge the worktree branch back into it (and the safety check can verify the
   *  parent repo is still on it). */
  baseBranch: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Slash-aware branch normalizer: slugifies each `/`-separated segment so a
 *  `feature/<title>` / `fix/<title>` name keeps its prefix slash (plain slugify
 *  flattens it). Caps total length and trims trailing separators. */
export function slugifyBranch(input: string): string {
  const segments = input
    .toLowerCase()
    .split('/')
    .map((s) => s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  const joined = segments
    .join('/')
    .slice(0, 60)
    .replace(/[-/]+$/g, '');
  return joined || 'feature-task';
}

/** A bug-fix task is flagged at creation (tasks.metadata.category='bugfix') or
 *  inferred from the title/description. Mirrors detectBugFix in 11-phase-8-learning. */
export function isBugBranch(
  title: string,
  description: string | null,
  category: string | null,
): boolean {
  if (category === 'bugfix') return true;
  return /\b(bug|fix|regression|hotfix|broken|crash)\b/i.test(`${title} ${description ?? ''}`);
}

/** Pre-filled branch name from the task title: `feature/<slug>` or `fix/<slug>`,
 *  kept concise (well under Git's ref-length limit). */
export function proposeBranchName(title: string, isBug: boolean): string {
  const slug = slugify(title).slice(0, 40).replace(/-+$/g, '') || 'task';
  return `${isBug ? 'fix' : 'feature'}/${slug}`;
}

/** First free name at or after `base`: `x`, `x-2`, `x-3`, … `taken` is asked about the
 *  branch AND its worktree directory by the caller, because `worktreeDirName` flattens
 *  slashes — `feature/x` and `feature-x` are distinct refs that land in one directory.
 *  Bounded so a pathological repo cannot spin; apply's claim guard catches the rest. */
export function nextFreeBranchName(
  base: string,
  taken: (name: string) => boolean,
  limit = 50,
): string {
  if (!taken(base)) return base;
  for (let n = 2; n <= limit; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${limit + 1}`;
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

/** Local branch names in the parent clone. An empty set on failure: a missing list must
 *  only weaken the uniqueness proposal, never block setup — the claim guard in apply is
 *  the check that has to be right. */
async function listLocalBranches(repoPath: string): Promise<Set<string>> {
  const res = await gitRun(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (res.code !== 0) return new Set();
  return new Set(
    res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

async function initGitRepo(
  ctx: StepContext,
  initBranch: string,
  commitMessage: string,
): Promise<void> {
  const userEnv = await resolveGitEnv(ctx.db, { userId: ctx.userId, taskId: ctx.taskId });
  const commitEnv = Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY;

  // CLI preflight may previously have written internal `.haive/` data. initGitWorkspace
  // excludes it BEFORE the initial `git add -A`; doing this after the commit allowed the
  // old ownership marker to become tracked and appear in every linked worktree.
  await initGitWorkspace(ctx.repoPath, initBranch);
  const add = await gitRun(ctx.repoPath, ['add', '-A']);
  if (add.code !== 0) {
    throw new Error(`git add -A failed (exit ${add.code}): ${add.stderr || add.stdout}`);
  }
  const commit = await gitRun(
    ctx.repoPath,
    ['commit', '--allow-empty', '-m', commitMessage],
    commitEnv,
  );
  if (commit.code !== 0) {
    throw new Error(`git commit failed (exit ${commit.code}): ${commit.stderr || commit.stdout}`);
  }
  ctx.logger.info({ initBranch }, 'initialized new git repository');
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
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { title: true, description: true, metadata: true },
    });
    const title = task?.title ?? '';
    const category = (task?.metadata as { category?: string } | null)?.category ?? null;
    const baseProposal = proposeBranchName(
      title,
      isBugBranch(title, task?.description ?? null, category),
    );

    // The base branch picked + freshened by 00a-sync-base (runs before this step).
    const syncPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '00a-sync-base');
    const syncedBase = (syncPrev?.output as { base?: string | null } | null)?.base ?? null;

    const gitDir = path.join(ctx.repoPath, '.git');
    const hasGit = await pathExists(gitDir);
    if (!hasGit) {
      return {
        hasGit: false,
        currentBranch: null,
        isClean: true,
        proposedBranch: baseProposal,
        proposalBumpedFrom: null,
        syncedBase,
      };
    }
    const branch = await gitRun(ctx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = await gitRun(ctx.repoPath, ['status', '--porcelain']);
    // Never PROPOSE a name that already exists here. `git worktree add <path> <branch>`
    // adopts an existing branch and its commits instead of forking the base 00a-sync-base
    // freshened, and when that branch's worktree is still registered the new task silently
    // shares the other task's directory.
    const taken = await listLocalBranches(ctx.repoPath);
    const takenDirs = new Set([...taken].map(worktreeDirName));
    const proposedBranch = nextFreeBranchName(
      baseProposal,
      (name) => taken.has(name) || takenDirs.has(worktreeDirName(name)),
    );
    return {
      hasGit: true,
      currentBranch: branch.code === 0 ? branch.stdout.trim() : null,
      isClean: status.code === 0 && status.stdout.trim().length === 0,
      proposedBranch,
      proposalBumpedFrom: proposedBranch === baseProposal ? null : baseProposal,
      syncedBase,
    };
  },

  form(_ctx, detected): FormSchema {
    if (!detected.hasGit) {
      return {
        title: 'Worktree setup',
        description:
          'No git repository detected at the repo root. Submit to initialize one — Haive will run `git init`, stage every current file, and create an initial commit. Then a worktree will be created for your feature branch. Use the Terminal tab if you need a more complex setup (existing remote, custom .gitignore, etc.) and Retry afterwards.',
        fields: [
          {
            type: 'text',
            id: 'branchName',
            label: 'Feature branch name',
            placeholder: 'feature/my-change',
            default: detected.proposedBranch,
            required: true,
          },
          {
            type: 'text',
            id: 'initBranch',
            label: 'Initial branch name',
            default: 'main',
            description: 'The branch `git init` creates. Also used as the base branch.',
          },
          {
            type: 'text',
            id: 'commitMessage',
            label: 'Initial commit message',
            default: 'Initial commit (via Haive)',
          },
        ],
        submitLabel: 'Initialize git & create worktree',
      };
    }
    // Base is chosen + freshened earlier by 00a-sync-base; show it read-only here.
    const base = detected.syncedBase ?? detected.currentBranch ?? 'main';
    const fields: FormField[] = [
      {
        type: 'text',
        id: 'branchName',
        label: 'Feature branch name',
        placeholder: 'feature/my-change',
        default: detected.proposedBranch,
        required: true,
      },
    ];
    if (detected.proposalBumpedFrom) {
      fields.push({
        type: 'note',
        id: 'branchTakenNote',
        label: 'Branch name adjusted',
        body: `**${detected.proposalBumpedFrom}** already exists in this repository, so **${detected.proposedBranch}** is proposed instead. Two tasks cannot share a branch — they would work in the same worktree directory. The original name frees up once the task holding it is completed or cancelled.`,
        variant: 'info',
      });
    }
    return {
      title: 'Worktree setup',
      description: `Base branch: ${base}. Working tree ${detected.isClean ? 'clean' : 'dirty'}. A new worktree will be created inside the repo at .haive/worktrees/<branch>, branched from ${base}.`,
      fields,
      submitLabel: 'Prepare workspace',
    };
  },

  async apply(ctx, args): Promise<WorktreeApply> {
    const values = args.formValues as {
      branchName?: string;
      baseBranch?: string;
      initBranch?: string;
      commitMessage?: string;
    };
    const branchName = slugifyBranch(values.branchName ?? 'feature-task');

    // Refuse a branch another live task already holds, BEFORE any git mutation (an init
    // that then failed would leave a half-set-up repo). The reuse path below is silent on
    // purpose — a Retry must re-enter this task's own worktree — so without this check a
    // second task adopts the first one's tree and branch and nothing reports it.
    const owner = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { repositoryId: true },
    });
    if (owner?.repositoryId) {
      const claimant = await findBranchClaimant(ctx.db, {
        repositoryId: owner.repositoryId,
        branchName,
        taskId: ctx.taskId,
      });
      if (claimant) {
        throw new Error(
          `Branch "${branchName}" is already held by task "${claimant.title}" ` +
            `(${claimant.id}, ${claimant.status}). Two tasks cannot share a branch — both ` +
            `would work in the same worktree directory. Retry this step and pick a different ` +
            `name, or finish/cancel that task first.`,
        );
      }
    }

    const dirName = worktreeDirName(branchName);
    let base: string;

    if (!args.detected.hasGit) {
      const initBranch = (values.initBranch ?? 'main').trim() || 'main';
      const commitMessage = (values.commitMessage ?? 'Initial commit (via Haive)').trim();
      await initGitRepo(ctx, initBranch, commitMessage);
      base = initBranch;
    } else {
      // Prefer the base 00a-sync-base picked + freshened; fall back to a legacy form
      // value (older tasks) then the parent's current branch.
      base = args.detected.syncedBase ?? values.baseBranch ?? args.detected.currentBranch ?? 'main';
    }

    await ensureGitExcludeEntry(ctx.repoPath);

    const worktreePath = path.join(ctx.repoPath, WORKTREE_SUBDIR, dirName);
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

    // `git worktree add` runs as the worker (root in compose), while cli-exec
    // runs as uid 1000. Repair both new and reused worktrees and fail before a
    // model call if the ownership cannot be made writable.
    await ensureSandboxWritableTree(worktreePath);

    const sandboxWorktree = sandboxWorktreePath(ctx.sandboxWorkdir, branchName);
    // Durable record for the cancel reaper (removeTaskWorktree). This step's `output`
    // is not enough: a Retry cascade nulls it while the worktree stays on disk.
    await ctx.db
      .update(schema.tasks)
      .set({ worktreePath, worktreeBranch: branchName })
      .where(eq(schema.tasks.id, ctx.taskId));
    ctx.logger.info(
      { worktreePath, sandboxWorktreePath: sandboxWorktree, branchName, base },
      'worktree created',
    );
    return {
      mode: 'worktree',
      worktreePath,
      sandboxWorktreePath: sandboxWorktree,
      branchName,
      baseBranch: base,
    };
  },
};

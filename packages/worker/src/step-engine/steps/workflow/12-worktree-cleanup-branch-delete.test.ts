import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergeResolveState } from '@haive/database';
import type { StepContext } from '../../step-definition.js';
import { gitRun, type GitRunResult } from '../../../repo/git-exec.js';
import { warnStep } from '../../../project-state/branch-revert.js';
import { deleteSquashedBranch, worktreeCleanupStep } from './12-worktree-cleanup.js';

vi.mock('../../../repo/git-exec.js', async (original) => ({
  ...(await original<typeof import('../../../repo/git-exec.js')>()),
  gitRun: vi.fn(),
}));
vi.mock('../../../repo/worktree-remove.js', () => ({
  removeWorktreeDir: vi.fn(async () => ({ removed: true })),
}));
vi.mock('../../../repo/worktree-changes.js', async (original) => ({
  ...(await original<typeof import('../../../repo/worktree-changes.js')>()),
  readUncommittedChanges: vi.fn(async () => ({ count: 0, paths: [] })),
}));
vi.mock('../../../repo/worktree-claims.js', async (original) => ({
  ...(await original<typeof import('../../../repo/worktree-claims.js')>()),
  findWorktreePathClaimant: vi.fn(async () => undefined),
}));
vi.mock('../../../project-state/branch-revert.js', async (original) => ({
  ...(await original<typeof import('../../../project-state/branch-revert.js')>()),
  projectionRevertNotes: vi.fn(async () => []),
  warnStep: vi.fn(),
}));

const repo = '/unused-repository';
const branch = 'feature/x';
const ref = `refs/heads/${branch}`;
const tip = 'a'.repeat(40);
const mergedFeature = 'b'.repeat(40);
const reply = (code = 0, stdout = ''): GitRunResult => ({ code, stdout, stderr: '' });
type GitCall = [string[], GitRunResult];
const symbolic: GitCall = [['symbolic-ref', '-q', ref], reply(1)];
const readTip: GitCall = [['rev-parse', '-q', '--verify', ref], reply(0, `${tip}\n`)];
const ancestry: GitCall = [['merge-base', '--is-ancestor', tip, mergedFeature], reply()];
const holders: GitCall = [['worktree', 'list', '--porcelain', '-z'], reply()];
const remove: GitCall = [['update-ref', '-d', ref, tip, '--no-deref'], reply()];
const configArgs = ['config', '--remove-section', `branch.${branch}`];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitRun).mockReset();
});

/** Every call is faked; an unexpected command cannot fall through to real Git. */
function expectGitCalls(calls: GitCall[]) {
  const pending = [...calls];
  vi.mocked(gitRun).mockImplementation(async (dir, args) => {
    expect(dir).toBe(repo);
    const next = pending.shift();
    expect(args).toEqual(next?.[0]);
    return next![1];
  });
  return () => {
    expect(pending).toEqual([]);
    // Holder inspection catches errors, so verify outside that catch as well.
    expect(vi.mocked(gitRun).mock.calls).toEqual(calls.map(([args]) => [repo, args]));
  };
}

describe('T316 squashed-branch delete decisions (faked Git)', () => {
  it.each([
    {
      name: 'worktree-list failure',
      calls: [symbolic, readTip, ancestry, [holders[0], reply(128)]] as GitCall[],
      reason: 'unreadable-worktrees',
      observedTip: tip,
    },
    {
      name: 'ancestry error',
      calls: [symbolic, readTip, [ancestry[0], reply(128)]] as GitCall[],
      reason: 'unreadable-branch',
      observedTip: tip,
    },
    {
      name: 'unreadable tip',
      calls: [symbolic, [readTip[0], reply(128)]] as GitCall[],
      reason: 'unreadable-branch',
      observedTip: null,
    },
    {
      name: 'uncontained tip',
      calls: [symbolic, readTip, [ancestry[0], reply(1)]] as GitCall[],
      reason: 'not-contained-in-squash',
      observedTip: tip,
    },
    {
      name: 'checked-out branch',
      calls: [
        symbolic,
        readTip,
        ancestry,
        [holders[0], reply(0, `worktree /holder\0branch ${ref}\0\0`)],
      ] as GitCall[],
      reason: 'checked-out',
      observedTip: tip,
    },
    {
      name: 'refused delete',
      calls: [symbolic, readTip, ancestry, holders, [remove[0], reply(1)]] as GitCall[],
      reason: 'delete-refused',
      observedTip: tip,
    },
  ])('retains the branch on $name', async ({ calls, reason, observedTip }) => {
    const done = expectGitCalls(calls);
    expect(await deleteSquashedBranch(repo, branch, mergedFeature)).toEqual({
      reason,
      tip: observedTip,
    });
    done();
    expect(vi.mocked(gitRun).mock.calls.some(([, args]) => args[0] === 'config')).toBe(false);
  });

  it('retains an existing branch without readable squash evidence', async () => {
    const done = expectGitCalls([symbolic, readTip]);
    expect(await deleteSquashedBranch(repo, branch, null)).toEqual({
      reason: 'unreadable-squash',
      tip,
    });
    done();
  });

  it('reports refused config cleanup after deletion, then finishes on absent-ref Retry', async () => {
    const done = expectGitCalls([
      symbolic,
      readTip,
      ancestry,
      holders,
      remove,
      [configArgs, reply(5)],
      symbolic,
      [readTip[0], reply(1)],
      [['show-ref', '--verify', '--quiet', ref], reply(1)],
      [configArgs, reply()],
    ]);
    expect(await deleteSquashedBranch(repo, branch, mergedFeature)).toEqual({
      reason: 'config-cleanup-refused',
      tip,
    });
    // The recorded merge can be pruned by Retry; absent refs need no ancestry proof.
    expect(await deleteSquashedBranch(repo, branch, null)).toEqual({ reason: null, tip: null });
    done();
  });

  it.each([0, 128, 5])('handles absent-ref config exit %s without merge evidence', async (code) => {
    const done = expectGitCalls([
      symbolic,
      [readTip[0], reply(1)],
      [['show-ref', '--verify', '--quiet', ref], reply(1)],
      [configArgs, reply(code)],
    ]);
    expect(await deleteSquashedBranch(repo, branch, null)).toEqual({
      reason: code === 5 ? 'config-cleanup-refused' : null,
      tip: null,
    });
    done();
  });
});

/** Apply only consumes persisted merge evidence here; no merge or filesystem fixture is needed. */
function applyFixture(
  opts: { squash?: boolean; evidence?: 'missing' | 'pruned'; contained?: boolean } = {},
) {
  const state: MergeResolveState = {
    mode: 'same-branch',
    phase: 'done',
    baseBranch: 'main',
    featureBranch: branch,
    mergeDir: repo,
    sandboxMergeDir: repo,
    fixInvocationId: null,
    conflictRetries: 0,
    pendingQuestion: null,
    pushAfterMerge: false,
    merged: true,
    skipReason: null,
    pushed: false,
    ...(opts.squash === false ? {} : { squashCommitSha: 'squash' }),
    ...(opts.evidence === 'missing' ? {} : { squashMergeSha: 'merge' }),
  };
  const events: { eventType: string; payload: unknown }[] = [];
  const refs = new Map([[ref, tip]]);
  let issueBranches: string[] = [];
  vi.mocked(gitRun).mockImplementation(async (dir, args) => {
    expect(dir).toBe(repo);
    if (args[0] === 'branch' && args[1] === '--list') return reply(0, issueBranches.join('\n'));
    if (args[0] === 'branch' && args[1] === '-d') return reply();
    if (args[0] === 'symbolic-ref') return reply(1);
    if (args[0] === 'rev-parse' && args.at(-1) === 'merge^2^{commit}') {
      return opts.evidence === 'pruned' ? reply(1) : reply(0, mergedFeature);
    }
    if (args[0] === 'rev-parse' && args[2] === '--verify') {
      const sha = refs.get(args[3]!);
      return sha ? reply(0, sha) : reply(1);
    }
    if (args[0] === 'show-ref') return reply(1);
    if (args[0] === 'merge-base') return reply(opts.contained === false ? 1 : 0);
    if (args[0] === 'worktree' && args[1] === 'list') return reply();
    if (args[0] === 'update-ref' && args[1] === '-d') {
      refs.delete(args[2]!);
      return reply();
    }
    if (args[0] === 'config') return reply(128);
    throw new Error(`Unexpected Git command: ${JSON.stringify(args)}`);
  });
  const db = {
    query: {
      taskSteps: { findFirst: async () => ({ mergeResolveState: state }) },
      taskEvents: { findMany: async () => events },
    },
    insert: () => ({ values: async (event: (typeof events)[number]) => void events.push(event) }),
  };
  const ctx = {
    repoPath: repo,
    taskId: 'task',
    taskStepId: 'step',
    db,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as StepContext;
  const detected: Parameters<typeof worktreeCleanupStep.apply>[1]['detected'] = {
    mode: 'worktree',
    worktreePath: `${repo}/.haive/worktrees/feature-x`,
    branchName: branch,
    baseBranch: 'main',
    parentBranch: 'main',
    uncommitted: { count: 0, paths: [] },
    repositoryId: 'repo',
    hasOrigin: false,
    originUrl: null,
    boundCredentialId: null,
    credentials: [],
    prWorkflowAvailable: false,
    taskTitle: '',
    taskDescription: '',
  };
  return {
    events,
    refs,
    addIssue: (name: string) => {
      issueBranches = [name];
      refs.set(`refs/heads/${name}`, tip);
    },
    apply: () =>
      worktreeCleanupStep.apply(ctx, {
        detected,
        formValues: { action: 'merge_remove', deleteBranch: true },
        iteration: 0,
        previousIterations: [],
      }),
  };
}

describe('T316 cleanup reporting and command selection (faked seams)', () => {
  it.each(['missing', 'pruned'] as const)(
    'reports %s recorded merge evidence',
    async (evidence) => {
      const h = applyFixture({ evidence });
      expect(await h.apply()).toMatchObject({
        removed: true,
        merged: true,
        branchDeleted: false,
        branchLeftovers: [{ branch, reason: 'unreadable-squash' }],
      });
      expect(h.refs.get(ref)).toBe(tip);
      expect(vi.mocked(gitRun).mock.calls.some(([, args]) => args[0] === 'update-ref')).toBe(false);
    },
  );

  it('retries an absent branch after the recorded merge was pruned without a leftover', async () => {
    const h = applyFixture({ evidence: 'pruned' });
    h.refs.clear();
    expect(await h.apply()).toMatchObject({ branchDeleted: true });
    expect((await h.apply()).branchLeftovers).toBeUndefined();
    expect(h.events).toEqual([]);
    expect(gitRun).toHaveBeenCalledWith(repo, configArgs);
    expect(vi.mocked(gitRun).mock.calls.some(([, args]) => args[0] === 'merge-base')).toBe(false);
  });

  it.each([true, false])('selects DAG deletion commands with squash=%s', async (squash) => {
    const h = applyFixture({ squash });
    h.addIssue(`${branch}--issue`);
    const applied = await h.apply();
    expect(applied.branchDeleted).toBe(true);
    expect(applied.message).toContain('1 merged DAG issue branch');
    expect(gitRun).toHaveBeenCalledWith(repo, [
      'branch',
      '--list',
      '--format=%(refname:lstrip=2)',
      ...(squash ? [] : ['--merged', ref]),
      `${branch}--*`,
    ]);
    for (const name of [branch, `${branch}--issue`]) {
      expect(gitRun).toHaveBeenCalledWith(
        repo,
        squash
          ? ['update-ref', '-d', `refs/heads/${name}`, tip, '--no-deref']
          : ['branch', '-d', name],
      );
    }
  });

  it('reports recovery guidance and deduplicates leftovers by branch and tip on Retry', async () => {
    const h = applyFixture({ contained: false });
    const first = await h.apply();
    expect(first.message).toContain('Inspect the branch in the repository terminal');
    expect(first.message).not.toContain('not-contained-in-squash');
    expect(first.branchLeftovers).toEqual([{ branch, reason: 'not-contained-in-squash' }]);
    expect(warnStep).toHaveBeenCalledWith(expect.anything(), [
      expect.stringContaining('Inspect the branch in the repository terminal'),
    ]);
    await h.apply();
    expect(h.events).toHaveLength(1);
    h.refs.set(ref, 'c'.repeat(40));
    await h.apply();
    expect(h.events).toHaveLength(2);
    expect(h.events[1]).toMatchObject({
      eventType: 'worktree.branch_leftovers',
      payload: { tips: { [branch]: 'c'.repeat(40) } },
    });
  });
});

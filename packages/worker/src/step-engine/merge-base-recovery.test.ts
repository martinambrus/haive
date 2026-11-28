import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { schema, type Database, type MergeResolveState } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared/logger';
import { claimFake, mergeDirClaimOverrides } from '../../test/merge-dir-claim-fake.js';
import { gitTemplate } from '../../test/support/git-template.js';
import { resolveMergePhase } from './merge-resolver.js';
import type { StepContext, StepDefinition } from './step-definition.js';
import type { AdvanceStepParams, TaskStepRow } from './step-runner.js';

const h = vi.hoisted(() => ({
  crashAfterMerge: false,
  crashBeforeMerge: false,
  /** The next git call this matches answers with a failed exit, once: a transient read error. */
  failRead: null as ((argv: string[]) => boolean) | null,
  pushes: [] as Array<{ branch: string; sha?: string }>,
}));
// The seams a task with a repository row goes through (a task without one never calls them), and the
// step's own put-back hook.
const aside = vi.hoisted(() => ({
  setAside: vi.fn(),
  restore: vi.fn(),
  seed: vi.fn(),
  putBack: vi.fn(),
}));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  lockRepositoryTasksKey: async () => {},
}));
vi.mock('../plan/mirror.js', async (original) => ({
  ...(await original<typeof import('../plan/mirror.js')>()),
  seedPlanBaseFromCheckout: aside.seed,
}));
vi.mock('../repo/refresh.js', async (original) => ({
  ...(await original<typeof import('../repo/refresh.js')>()),
  checkoutHoldingTasks: async () => 0,
}));
vi.mock('../project-state/set-aside.js', async (original) => ({
  ...(await original<typeof import('../project-state/set-aside.js')>()),
  setAsideHaiveProjections: aside.setAside,
  restoreProjectionsInTx: aside.restore,
  putBackProjections: async () => {},
  resyncHaiveProjections: async () => true,
}));
vi.mock('./merge-dir-claim.js', async (original) => ({
  ...(await original<typeof import('./merge-dir-claim.js')>()),
  ...mergeDirClaimOverrides(),
}));
vi.mock('../repo/git-push.js', async (original) => {
  const actual = await original<typeof import('../repo/git-push.js')>();
  return {
    ...actual,
    pushBranch: async (args: { branch: string; sha?: string }) => {
      h.pushes.push({ branch: args.branch, sha: args.sha });
      return { pushed: true as const, remote: 'origin' as const, branch: args.branch };
    },
    gitRun: async (...args: Parameters<typeof actual.gitRun>) => {
      if (h.failRead?.(args[1])) {
        h.failRead = null;
        return { stdout: '', stderr: 'injected git failure', code: 128 };
      }
      if (h.crashBeforeMerge && args[1][0] === 'merge' && args[1].includes('--no-ff')) {
        h.crashBeforeMerge = false;
        throw new Error('worker died before the merge');
      }
      const result = await actual.gitRun(...args);
      if (h.crashAfterMerge && args[1][0] === 'merge' && result.code === 0) {
        h.crashAfterMerge = false;
        throw new Error('worker died after merge before state save');
      }
      return result;
    },
  };
});
const exec = promisify(execFile);
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@test.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@test.local',
};
async function git(dir: string, ...args: string[]) {
  return (await exec('git', args, { cwd: dir, env })).stdout.trim();
}
const template = gitTemplate(async (dir) => {
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'gc.auto', '0');
  await git(dir, 'config', 'maintenance.auto', 'false');
  await writeFile(path.join(dir, 'base'), 'base\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'base');
  const before = await git(dir, 'rev-parse', 'HEAD');
  await git(dir, 'switch', '-c', 'feature');
  await writeFile(path.join(dir, 'feature'), 'feature\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'feature');
  const feature = await git(dir, 'rev-parse', 'HEAD');
  await git(dir, 'switch', 'main');
  return { before, feature };
});

interface Config {
  squash: boolean;
  push: boolean;
  cross?: boolean;
  /** A merge step other than 12: it never squashes and records no landing. */
  otherStep?: boolean;
  /** The task has a repository row, so the merge sets Haive's project files aside first. */
  repository?: boolean;
  /** The step puts Haive's files back before its feature merge, as 12 does. */
  putBack?: boolean;
}
type Fixture = Awaited<ReturnType<typeof setup>>;

async function setup(cfg: Config) {
  claimFake.reset();
  h.pushes = [];
  h.crashBeforeMerge = false;
  h.failRead = null;
  aside.setAside.mockReset().mockResolvedValue({ outcome: 'clean' });
  aside.restore.mockReset().mockResolvedValue({ outcome: 'clean' });
  aside.seed.mockReset().mockResolvedValue(undefined);
  aside.putBack.mockReset().mockResolvedValue([]);
  const { dir, data } = await template.copy();
  const fake = createFakeDb({
    taskSteps: schema.taskSteps,
    tasks: schema.tasks,
    users: schema.users,
    repositories: schema.repositories,
    taskDagIssues: schema.taskDagIssues,
    taskEvents: schema.taskEvents,
  });
  const taskId = randomUUID();
  const stepId = randomUUID();
  const userId = randomUUID();
  if (cfg.cross) await git(dir, 'switch', '-c', 'develop');
  const mergeDir = cfg.cross ? path.join(dir, '.haive', 'worktrees', 'main--base') : dir;
  const state: MergeResolveState = {
    phase: 'pending',
    mode: cfg.cross ? 'cross-branch' : 'same-branch',
    baseBranch: 'main',
    featureBranch: 'feature',
    mergeDir,
    sandboxMergeDir: '/workspace',
    fixInvocationId: null,
    conflictRetries: 0,
    pendingQuestion: null,
    pushAfterMerge: cfg.push,
    squashAfterMerge: cfg.squash,
    merged: false,
    skipReason: null,
    pushed: false,
    mergeStage: 'feature',
    baseSyncRounds: 0,
  };
  fake.insert(schema.tasks, {
    id: taskId,
    userId,
    status: 'running',
    repositoryId: cfg.repository ? randomUUID() : null,
  });
  fake.insert(schema.taskSteps, {
    id: stepId,
    taskId,
    status: 'running',
    mergeResolveState: state,
  });
  const db = fake.db as unknown as Database;
  const step = {
    metadata: { id: cfg.otherStep ? '00a-sync-base' : '12-worktree-cleanup' },
    mergeResolve: {
      selectedMerge: () => true,
      ...(cfg.otherStep ? {} : { squashable: true }),
      ...(cfg.putBack ? { putBackBeforeMerge: aside.putBack } : {}),
    },
  } as unknown as StepDefinition;
  const ctx: StepContext = {
    userId,
    taskId,
    taskStepId: stepId,
    repoPath: dir,
    workspacePath: dir,
    sandboxWorkdir: '/workspace',
    cliProviderId: null,
    round: 0,
    db,
    logger: logger as unknown as StepContext['logger'],
    signal: new AbortController().signal,
    emitProgress: async () => {},
    throwIfCancelled: () => {},
  };
  const params = { taskId, stepDef: step } as AdvanceStepParams;
  // Each pass reads its input from the stored row, as a fresh invocation does.
  const run = () =>
    resolveMergePhase(
      db,
      step,
      structuredClone(fake.rows(schema.taskSteps)[0]) as unknown as TaskStepRow,
      ctx,
      params,
    );
  const stored = () => fake.rows(schema.taskSteps)[0]?.mergeResolveState as MergeResolveState;
  const landedEvents = () =>
    fake.rows(schema.taskEvents).filter((row) => row.eventType === 'merge.landed');
  return { dir, data, fake, db, stepId, run, stored, landedEvents };
}

/** Run 1: the worker dies right after git landed the clean merge, before the section saved. */
async function stopAfterLanding(f: Fixture) {
  h.crashAfterMerge = true;
  await expect(f.run()).rejects.toThrow('worker died after merge before state save');
  expect(f.stored().phase).toBe('pending');
  const landed = await git(f.dir, 'rev-parse', 'main');
  expect(await git(f.dir, 'rev-list', '--parents', '-n', '1', 'main')).toBe(
    `${landed} ${f.data.before} ${f.data.feature}`,
  );
  return {
    landed,
    tree: await git(f.dir, 'rev-parse', 'main^{tree}'),
    reflog: await git(f.dir, 'reflog', '--format=%H %gs'),
  };
}

async function retry(f: Fixture) {
  await f.db
    .update(schema.taskSteps)
    .set({ status: 'running' })
    .where(eq(schema.taskSteps.id, f.stepId));
}

async function summary(f: Fixture) {
  const st = f.stored();
  const head = await git(f.dir, 'rev-parse', 'main');
  const events = [];
  for (const row of f.landedEvents()) {
    const p = row.payload as {
      baseShaBefore: string;
      baseShaAfter: string;
      squashMergeSha?: string;
    };
    const after = (await git(f.dir, 'rev-list', '--parents', '-n', '1', p.baseShaAfter)).split(' ');
    events.push({
      beforeIsPreMergeTip: p.baseShaBefore === f.data.before,
      afterParentCount: after.length - 1,
      hasSquashMergeSha: Boolean(p.squashMergeSha),
    });
  }
  return {
    phase: st.phase,
    merged: st.merged,
    baseIsPreMergeTip: st.baseShaBefore === f.data.before,
    hasSquashCommit: Boolean(st.squashCommitSha),
    hasSkipReason: Boolean(st.squashSkipReason),
    commitCount: await git(f.dir, 'rev-list', '--count', 'main'),
    headParentCount:
      (await git(f.dir, 'rev-list', '--parents', '-n', '1', 'main')).split(' ').length - 1,
    tree: await git(f.dir, 'rev-parse', 'main^{tree}'),
    events,
    pushedShaIsHead: h.pushes.length === 0 ? null : h.pushes.at(-1)?.sha === head,
  };
}

async function expectLandedOnce(f: Fixture, cfg: Config, tree: string, landed: string) {
  const { data, dir } = f;
  const s = await summary(f);
  const parents = (await git(dir, 'rev-list', '--parents', '-n', '1', 'main')).split(' ');
  expect(s.phase).toBe('done');
  expect(s.baseIsPreMergeTip).toBe(true);
  expect(s.hasSkipReason).toBe(false);
  expect(s.tree).toBe(tree);
  expect(s.pushedShaIsHead).toBe(cfg.push ? true : null);
  if (cfg.squash) {
    expect(s.hasSquashCommit).toBe(true);
    expect(parents.slice(1)).toEqual([data.before]);
    expect(s.commitCount).toBe('2');
    expect(s.events).toEqual([
      { beforeIsPreMergeTip: true, afterParentCount: 2, hasSquashMergeSha: false },
      { beforeIsPreMergeTip: true, afterParentCount: 1, hasSquashMergeSha: true },
    ]);
    expect(f.stored().squashCommitSha).toBe(parents[0]);
  } else {
    expect(s.hasSquashCommit).toBe(false);
    expect(parents[0]).toBe(landed);
    expect(s.commitCount).toBe('3');
    expect(s.events).toEqual([
      { beforeIsPreMergeTip: true, afterParentCount: 2, hasSquashMergeSha: false },
    ]);
  }
  expect(await git(dir, 'show', 'main:feature')).toBe('feature');
  expect(await git(dir, 'status', '--porcelain')).toBe('');
  expect(claimFake.claims.has(f.stored().mergeDir)).toBe(false);
}

describe('T785 replay after a clean merge landed before its state was saved', () => {
  it.each([
    { squash: true, push: false },
    { squash: true, push: true },
    { squash: false, push: false },
    { squash: false, push: true },
  ])('same-branch %j: the replay finishes as an uninterrupted run would', async (cfg) => {
    const control = await setup(cfg);
    expect((await control.run()).resolved).toBe(true);
    const expected = await summary(control);

    const f = await setup(cfg);
    const { landed, tree } = await stopAfterLanding(f);
    h.pushes = [];
    expect((await f.run()).resolved).toBe(true);
    expect(await summary(f)).toEqual(expected);
    await expectLandedOnce(f, cfg, tree, landed);
  });

  it('cross-branch: the replay in the base worktree finishes as an uninterrupted run would', async () => {
    const cfg = { squash: true, push: false, cross: true };
    const control = await setup(cfg);
    expect((await control.run()).resolved).toBe(true);
    const expected = await summary(control);

    const f = await setup(cfg);
    const { landed, tree } = await stopAfterLanding(f);
    expect((await f.run()).resolved).toBe(true);
    expect(await summary(f)).toEqual(expected);
    await expectLandedOnce(f, cfg, tree, landed);
    expect(await git(f.dir, 'worktree', 'list', '--porcelain')).not.toContain('main--base');
  });

  async function expectLeftAlone(f: Fixture, before: { head: string; reflog: string }) {
    expect((await f.run()).resolved).toBe(true);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(before.head);
    expect(await git(f.dir, 'reflog', '--format=%H %gs')).toBe(before.reflog);
    const st = f.stored();
    expect(st.phase).toBe('done');
    expect(st.squashCommitSha ?? null).toBeNull();
    expect(typeof st.squashSkipReason).toBe('string');
    expect(st.squashSkipReason).not.toBe('');
    expect(f.landedEvents()).toEqual([]);
  }

  it('moved tip: a commit on top of the landed merge is neither squashed nor rewritten', async () => {
    const f = await setup({ squash: true, push: false });
    await stopAfterLanding(f);
    await writeFile(path.join(f.dir, 'person'), 'person\n');
    await git(f.dir, 'add', '.');
    await git(f.dir, 'commit', '-m', 'person');
    await retry(f);
    await expectLeftAlone(f, {
      head: await git(f.dir, 'rev-parse', 'main'),
      reflog: await git(f.dir, 'reflog', '--format=%H %gs'),
    });
  });

  it('another merge of the same feature that is not this step is neither squashed nor rewritten', async () => {
    const f = await setup({ squash: true, push: false });
    await stopAfterLanding(f);
    await git(f.dir, 'reset', '--hard', f.data.before);
    await writeFile(path.join(f.dir, 'unrelated'), 'unrelated\n');
    await git(f.dir, 'add', '.');
    await git(f.dir, 'commit', '-m', 'unrelated');
    await git(f.dir, 'merge', '--no-ff', 'feature', '-m', 'by hand');
    await retry(f);
    await expectLeftAlone(f, {
      head: await git(f.dir, 'rev-parse', 'main'),
      reflog: await git(f.dir, 'reflog', '--format=%H %gs'),
    });
  });

  it('a merge on the recorded base whose second parent is not the feature is not mistaken for this step', async () => {
    const f = await setup({ squash: true, push: false });
    await stopAfterLanding(f);
    await git(f.dir, 'reset', '--hard', f.data.before);
    await git(f.dir, 'switch', '-c', 'other');
    await writeFile(path.join(f.dir, 'other'), 'other\n');
    await git(f.dir, 'add', '.');
    await git(f.dir, 'commit', '-m', 'other');
    await git(f.dir, 'switch', 'main');
    await git(f.dir, 'merge', '--no-ff', 'other', '-m', 'merge other');
    const tip = await git(f.dir, 'rev-parse', 'main');
    await retry(f);
    expect((await f.run()).resolved).toBe(true);
    const s = await summary(f);
    const parents = (await git(f.dir, 'rev-list', '--parents', '-n', '1', 'main')).split(' ');
    expect(s.phase).toBe('done');
    expect(parents.slice(1)).toEqual([tip]);
    expect((await git(f.dir, 'rev-list', '--parents', '-n', '1', tip)).split(' ')).toHaveLength(3);
    expect(f.stored().baseShaBefore).toBe(tip);
    expect(
      f.landedEvents().map((e) => (e.payload as { baseShaBefore: string }).baseShaBefore),
    ).toEqual([tip, tip]);
  });

  it('a merge of another branch on a tip that already held the feature is neither squashed nor rewritten', async () => {
    const f = await setup({ squash: true, push: false });
    await git(f.dir, 'merge', '--no-ff', 'feature', '-m', 'by hand');
    h.crashAfterMerge = true;
    await expect(f.run()).rejects.toThrow('worker died after merge before state save');
    expect(f.stored().phase).toBe('pending');
    await git(f.dir, 'switch', '-c', 'other', f.data.before);
    await writeFile(path.join(f.dir, 'other'), 'other\n');
    await git(f.dir, 'add', '.');
    await git(f.dir, 'commit', '-m', 'other');
    await git(f.dir, 'switch', 'main');
    await git(f.dir, 'merge', '--no-ff', 'other', '-m', 'merge other');
    await retry(f);
    await expectLeftAlone(f, {
      head: await git(f.dir, 'rev-parse', 'main'),
      reflog: await git(f.dir, 'reflog', '--format=%H %gs'),
    });
  });

  it('a feature that moved on after the stop is merged atop the landed merge, which stays as it is', async () => {
    const f = await setup({ squash: true, push: false });
    const { landed } = await stopAfterLanding(f);
    await git(f.dir, 'switch', 'feature');
    await writeFile(path.join(f.dir, 'later'), 'later\n');
    await git(f.dir, 'add', '.');
    await git(f.dir, 'commit', '-m', 'later');
    await git(f.dir, 'switch', 'main');
    await retry(f);
    expect((await f.run()).resolved).toBe(true);
    const parents = (await git(f.dir, 'rev-list', '--parents', '-n', '1', 'main')).split(' ');
    expect(f.stored().phase).toBe('done');
    expect(f.stored().baseShaBefore).toBe(landed);
    expect(parents.slice(1)).toEqual([landed]);
    expect(await git(f.dir, 'rev-list', '--parents', '-n', '1', landed)).toBe(
      `${landed} ${f.data.before} ${f.data.feature}`,
    );
    expect(await git(f.dir, 'show', 'main:later')).toBe('later');
  });

  it('a merge step that is not squashable records no tip and replays as before', async () => {
    const f = await setup({ squash: false, push: false, otherStep: true });
    const { landed } = await stopAfterLanding(f);
    expect(f.stored().preMergeBaseSha).toBeUndefined();
    expect((await f.run()).resolved).toBe(true);
    expect(f.stored().preMergeBaseSha).toBeUndefined();
    expect(f.stored().baseShaBefore).toBe(landed);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(landed);
    expect(f.landedEvents()).toEqual([]);
  });

  it('a merge of the feature that a person makes on the tip after a refused attempt is left alone', async () => {
    const f = await setup({ squash: true, push: false });
    await writeFile(path.join(f.dir, 'feature'), 'local\n');
    await f.run();
    expect(f.fake.rows(schema.taskSteps)[0]?.status).toBe('failed');
    expect(f.stored().phase).toBe('pending');
    expect(f.stored().baseShaBefore).toBeUndefined();
    await rm(path.join(f.dir, 'feature'));
    await git(f.dir, 'merge', '--no-ff', 'feature', '-m', 'by hand');
    const head = await git(f.dir, 'rev-parse', 'main');
    const reflog = await git(f.dir, 'reflog', '--format=%H %gs');
    await retry(f);
    expect((await f.run()).resolved).toBe(true);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(head);
    expect(await git(f.dir, 'reflog', '--format=%H %gs')).toBe(reflog);
    expect(f.stored().phase).toBe('done');
    expect(f.stored().squashCommitSha ?? null).toBeNull();
    expect(f.landedEvents()).toEqual([]);
  });

  it('a retry after a refused first attempt measures the base afresh', async () => {
    const f = await setup({ squash: true, push: false });
    await writeFile(path.join(f.dir, 'feature'), 'local\n');
    await f.run();
    expect(f.fake.rows(schema.taskSteps)[0]?.status).toBe('failed');
    await rm(path.join(f.dir, 'feature'));
    await writeFile(path.join(f.dir, 'x'), 'x\n');
    await git(f.dir, 'add', '.');
    await git(f.dir, 'commit', '-m', 'x');
    const tip = await git(f.dir, 'rev-parse', 'main');
    await retry(f);
    expect((await f.run()).resolved).toBe(true);
    const parents = (await git(f.dir, 'rev-list', '--parents', '-n', '1', 'main')).split(' ');
    expect(f.stored().phase).toBe('done');
    expect(f.stored().baseShaBefore).toBe(tip);
    expect(parents.slice(1)).toEqual([tip]);
    expect(await git(f.dir, 'rev-list', '--count', 'main')).toBe('3');
    expect(
      f.landedEvents().map((e) => (e.payload as { baseShaBefore: string }).baseShaBefore),
    ).toEqual([tip, tip]);
  });

  it('a halt in the set-aside loop that merged nothing leaves a later hand merge on the tip alone', async () => {
    const f = await setup({ squash: true, push: false, repository: true });
    // A file Haive rewrote sends the open round again, and the second set-aside refuses.
    aside.restore.mockResolvedValueOnce({ outcome: 'retry' });
    aside.setAside.mockResolvedValueOnce({ outcome: 'clean' }).mockResolvedValueOnce({
      outcome: 'refused',
      file: 'x',
      reason: 'a local change',
      code: 'git_operation',
    });
    await f.run();
    expect(aside.setAside).toHaveBeenCalledTimes(2);
    expect(f.fake.rows(schema.taskSteps)[0]?.status).toBe('failed');
    expect(f.stored().phase).toBe('pending');
    expect(f.stored().baseShaBefore).toBeUndefined();
    await git(f.dir, 'merge', '--no-ff', 'feature', '-m', 'by hand');
    const head = await git(f.dir, 'rev-parse', 'main');
    const reflog = await git(f.dir, 'reflog', '--format=%H %gs');
    await retry(f);
    expect((await f.run()).resolved).toBe(true);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(head);
    expect(await git(f.dir, 'reflog', '--format=%H %gs')).toBe(reflog);
    expect(f.stored().phase).toBe('done');
    expect(f.stored().squashCommitSha ?? null).toBeNull();
    expect(f.landedEvents()).toEqual([]);
  });

  // A git error reading the proof gives no answer. Taken for "not this step's merge" it measured the tip
  // afresh and overwrote the recorded one with the landed merge, so no later retry could squash the
  // feature or record its landing. Each read fails once after a landed merge: the retry fails with the
  // record kept, and the next retry finishes as an uninterrupted run would.
  it.each([
    ['the parents of the tip', (argv: string[]) => argv[0] === 'rev-list'],
    [
      'the feature tip',
      (argv: string[]) => argv[0] === 'rev-parse' && argv.includes('feature^{commit}'),
    ],
    ['whether the feature is in the tip', (argv: string[]) => argv[0] === 'merge-base'],
  ])(
    'a git error reading %s after a landed merge fails the retry and keeps the recorded tip',
    async (_read, fails) => {
      const cfg = { squash: true, push: false };
      const f = await setup(cfg);
      const { landed, tree } = await stopAfterLanding(f);
      h.failRead = fails;
      await expect(f.run()).rejects.toThrow();
      expect(h.failRead).toBeNull();
      expect(f.stored().preMergeBaseSha).toBe(f.data.before);
      expect(f.stored().baseShaBefore).toBeUndefined();
      expect(f.stored().phase).toBe('pending');
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(landed);
      expect((await f.run()).resolved).toBe(true);
      await expectLandedOnce(f, cfg, tree, landed);
    },
  );

  // A retry that halts before its merge section merged nothing: with the base still at the recorded tip,
  // a merge a person makes on it afterwards is not this step's.
  const earlyHalts: Array<{
    halt: string;
    config: Partial<Config>;
    /** Makes the next attempt halt; returns what shows it halted there. */
    arrange: (f: Fixture) => () => void;
  }> = [
    {
      halt: "Haive's files could not be put back",
      config: { putBack: true },
      arrange: () => {
        aside.putBack.mockRejectedValueOnce(new Error('put back failed'));
        return () => expect(aside.putBack).toHaveBeenCalledTimes(2);
      },
    },
    {
      halt: "the plan's base could not be read",
      config: { repository: true },
      arrange: () => {
        aside.seed.mockRejectedValueOnce(new Error('plan base unreadable'));
        return () => {
          expect(aside.seed).toHaveBeenCalledTimes(2);
          expect(aside.setAside).toHaveBeenCalledTimes(1);
        };
      },
    },
    {
      halt: "Haive's files could not be set aside",
      config: { repository: true },
      arrange: () => {
        aside.setAside.mockResolvedValueOnce({
          outcome: 'refused',
          file: 'x',
          reason: 'a local change',
          code: 'git_operation',
        });
        return () => expect(aside.setAside).toHaveBeenCalledTimes(2);
      },
    },
    {
      halt: 'another task works in the checkout',
      config: { repository: true },
      arrange: () => {
        aside.setAside.mockResolvedValueOnce({ outcome: 'held', holding: 1 });
        return () => expect(aside.setAside).toHaveBeenCalledTimes(2);
      },
    },
    {
      halt: 'another task holds the merge directory',
      config: { putBack: true },
      arrange: (f) => {
        const holder = randomUUID();
        claimFake.claims.set(f.dir, { taskId: holder, stepId: randomUUID(), title: 'Other task' });
        return () => {
          expect(f.fake.rows(schema.taskSteps)[0]?.errorMessage).toContain(holder);
          expect(aside.putBack).toHaveBeenCalledTimes(1);
        };
      },
    },
  ];
  it.each(earlyHalts)(
    'a thrown exit, then a retry that halts because $halt, leaves a later hand merge on the tip alone',
    async ({ config, arrange }) => {
      const f = await setup({ squash: true, push: false, ...config });
      h.crashBeforeMerge = true;
      await expect(f.run()).rejects.toThrow('worker died before the merge');
      expect(f.stored().preMergeBaseSha).toBe(f.data.before);
      const haltedThere = arrange(f);
      await retry(f);
      await f.run();
      expect(f.fake.rows(schema.taskSteps)[0]?.status).toBe('failed');
      haltedThere();
      expect(f.stored().phase).toBe('pending');
      expect(f.stored().preMergeBaseSha).toBeUndefined();
      claimFake.claims.delete(f.dir);
      await git(f.dir, 'merge', '--no-ff', 'feature', '-m', 'by hand');
      const head = await git(f.dir, 'rev-parse', 'main');
      const reflog = await git(f.dir, 'reflog', '--format=%H %gs');
      await retry(f);
      expect((await f.run()).resolved).toBe(true);
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(head);
      expect(await git(f.dir, 'reflog', '--format=%H %gs')).toBe(reflog);
      expect(f.stored().phase).toBe('done');
      expect(f.stored().squashCommitSha ?? null).toBeNull();
      expect(f.landedEvents()).toEqual([]);
    },
  );

  // The same halts after a stop that did land the merge: the base is no longer at the recorded tip, which
  // stays for the retry that squashes the landed merge and records its landing.
  it('a stop after a landed merge, then a retry that halts before its merge section, keeps the recorded tip', async () => {
    const cfg = { squash: true, push: false, repository: true };
    const f = await setup(cfg);
    const { landed, tree } = await stopAfterLanding(f);
    aside.setAside.mockResolvedValueOnce({
      outcome: 'refused',
      file: 'x',
      reason: 'a local change',
      code: 'git_operation',
    });
    await retry(f);
    await f.run();
    expect(f.fake.rows(schema.taskSteps)[0]?.status).toBe('failed');
    expect(aside.setAside).toHaveBeenCalledTimes(2);
    expect(f.stored().preMergeBaseSha).toBe(f.data.before);
    await retry(f);
    expect((await f.run()).resolved).toBe(true);
    await expectLandedOnce(f, cfg, tree, landed);
  });

  it('a halt on a state that has measured its base leaves the recorded tip as it is', async () => {
    const f = await setup({ squash: true, push: false });
    await f.db
      .update(schema.taskSteps)
      .set({
        mergeResolveState: {
          ...f.stored(),
          phase: 'resolving',
          baseShaBefore: f.data.before,
          preMergeBaseSha: f.data.before,
        },
      })
      .where(eq(schema.taskSteps.id, f.stepId));
    claimFake.claims.set(f.dir, {
      taskId: randomUUID(),
      stepId: randomUUID(),
      title: 'Other task',
    });
    await f.run();
    expect(f.fake.rows(schema.taskSteps)[0]?.status).toBe('failed');
    expect(f.stored().phase).toBe('resolving');
    expect(f.stored().preMergeBaseSha).toBe(f.data.before);
  });

  // Pins a limitation the docs name: by parents alone a merge of the feature on exactly the saved tip
  // is this step's merge, whoever made it and whatever stopped this step before its own merge landed.
  it("LIMITATION: a hand merge of the feature on exactly the saved tip after a thrown exit is squashed as this step's", async () => {
    const f = await setup({ squash: true, push: false });
    h.crashBeforeMerge = true;
    await expect(f.run()).rejects.toThrow('worker died before the merge');
    expect(f.stored().preMergeBaseSha).toBe(f.data.before);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.data.before);
    await git(f.dir, 'merge', '--no-ff', 'feature', '-m', 'by hand');
    expect((await f.run()).resolved).toBe(true);
    const parents = (await git(f.dir, 'rev-list', '--parents', '-n', '1', 'main')).split(' ');
    expect(parents.slice(1)).toEqual([f.data.before]);
    expect(f.stored().squashCommitSha).toBe(parents[0]);
    expect(f.landedEvents()).toHaveLength(2);
  });
});

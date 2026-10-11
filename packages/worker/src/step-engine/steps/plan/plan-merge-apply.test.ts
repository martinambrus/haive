import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { PLAN_MERGE_MESSAGE_EVENT } from '@haive/shared';
import { discardPlanMerge, planMergeStep } from './01-plan-merge.js';
import { PLAN_MERGE_BASELINE_EVENT } from '../../../plan/merge-baseline.js';
import { relocateFixerChanges, type FixBaseline } from '../../git-merge.js';
import type { StepContext } from '../../step-definition.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}

async function gitCode(dir: string, args: string[]): Promise<number> {
  try {
    await exec('git', args, { cwd: dir, env: GIT_ENV });
    return 0;
  } catch (e) {
    return (e as { code?: number }).code ?? 1;
  }
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function write(dir: string, file: string, body: string): Promise<void> {
  const full = path.join(dir, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, 'utf8');
}

/** A Haive repo and a remote made on its own, sharing no commit: both READMEs collide. */
async function unrelatedPair(): Promise<string> {
  const remote = await mkdtemp(path.join(tmpdir(), 'planmerge-apply-remote-'));
  const local = await mkdtemp(path.join(tmpdir(), 'planmerge-apply-local-'));
  dirs.push(remote, local);
  for (const [dir, readme] of [
    [remote, '# vareska\n\nfrom the forge\n'],
    [local, '# vareska\n\nfrom Haive\n'],
  ] as const) {
    await git(dir, ['init', '-b', 'main']);
    await git(dir, ['config', 'gc.auto', '0']);
    await write(dir, 'README.md', readme);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'initial']);
  }
  await git(local, ['remote', 'add', 'origin', remote]);
  return local;
}

type Event = { taskId: string; taskStepId: string; eventType: string; payload: unknown };

function fakeDb() {
  const events: Event[] = [];
  const flags = {
    maskFails: false,
    readTaskId: 't1',
    taskType: 'plan_merge',
    repoPath: null as string | null,
    others: [] as { id: string }[],
  };
  // The one joined read is the recorded-tree lookup, newest first.
  const recorded = (n: number) =>
    events
      .filter((e) => e.eventType === PLAN_MERGE_BASELINE_EVENT)
      .reverse()
      .slice(0, n);
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === schema.tasks ? [{ repositoryId: 'r1' }] : []),
          orderBy: async () =>
            table === schema.taskEvents
              ? events
                  .filter(
                    (e) =>
                      e.eventType === PLAN_MERGE_MESSAGE_EVENT && e.taskId === flags.readTaskId,
                  )
                  .map((e) => ({ payload: e.payload }))
              : [],
        }),
        innerJoin: () => ({
          where: () => ({ orderBy: () => ({ limit: async (n: number) => recorded(n) }) }),
        }),
      }),
    }),
    query: {
      // Only the secret mask's policy reads the task this way.
      tasks: {
        findFirst: async () => {
          if (flags.maskFails) throw new Error('mask read failed');
          return { userId: 'u1', repositoryId: 'r1', type: flags.taskType };
        },
        findMany: async () => flags.others,
      },
      repositories: {
        findFirst: async () => ({ credentialsSecretId: null, storagePath: flags.repoPath }),
      },
      users: { findFirst: async () => ({ gitName: 'T', gitEmail: 't@haive.local' }) },
    },
    insert: (table: unknown) => ({
      values: async (v: Event) => {
        if (table === schema.taskEvents) events.push(v);
      },
    }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({ ...db, execute: async () => undefined }),
  };
  return { db, events, flags };
}

function contextFor(repoPath: string, db: unknown): StepContext {
  return {
    repoPath,
    userId: 'u1',
    taskId: 't1',
    taskStepId: 's1',
    cliProviderId: null,
    db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as StepContext;
}

describe('plan merge: the answer pass', () => {
  it("moves the agent's changes outside the conflict aside and commits only the merge", async () => {
    const local = await unrelatedPair();
    const { db, events } = fakeDb();
    const ctx = {
      repoPath: local,
      userId: 'u1',
      taskId: 't1',
      taskStepId: 's1',
      cliProviderId: null,
      db,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as StepContext;
    const detected = await planMergeStep.detect!(ctx);
    expect(detected.conflicts).toEqual(['README.md']);
    const wt = detected.worktreePath;
    await writeFile(path.join(wt, 'README.md'), '# vareska\n\nboth sides\n', 'utf8');
    await writeFile(path.join(wt, 'notes.txt'), 'scratch\n', 'utf8');
    const out = await planMergeStep.apply(ctx, {
      detected,
      formValues: {},
      llmOutput: 'Kept both sides.',
      llmInvocationId: 'inv1',
      iteration: 0,
      previousIterations: [],
    });
    expect(out.resolved).toBe(true);
    expect(await git(wt, ['show', 'HEAD:README.md'])).toBe('# vareska\n\nboth sides\n');
    expect(await gitCode(wt, ['cat-file', '-e', 'HEAD:notes.txt'])).not.toBe(0);
    const moved = path.join(local, '.haive', 'merge-leftovers', 't1', 'inv1', 'files', 'notes.txt');
    expect(await readFile(moved, 'utf8')).toBe('scratch\n');
    expect(events.map((e) => e.eventType)).toContain('merge.fixer_leftovers');
    expect(out.summary).toContain('.haive/merge-leftovers/t1/');
  });
});

describe('plan merge: a fixer that did not finish', () => {
  it('moves aside what it left before the next fixer is sent in', async () => {
    const local = await unrelatedPair();
    const { db, events } = fakeDb();
    const ctx = contextFor(local, db);
    const first = await planMergeStep.detect!(ctx);
    expect(first.fixBaseline).toMatchObject({ resolving: ['README.md'] });
    const wt = first.worktreePath;
    // It staged a change outside the conflict, and its run failed: apply never ran.
    await writeFile(path.join(wt, 'notes.txt'), 'scratch\n', 'utf8');
    await git(wt, ['add', 'notes.txt']);

    const retried = await planMergeStep.detect!(ctx);
    expect(retried.fixBaseline).toEqual(first.fixBaseline);
    await planMergeStep.llm!.prepareWorkspace!({ ctx, detected: retried, formValues: {} });
    expect(await gitCode(wt, ['cat-file', '-e', ':notes.txt'])).not.toBe(0);
    await expect(readFile(path.join(wt, 'notes.txt'), 'utf8')).rejects.toThrow();
    const moved = events.find((e) => e.eventType === 'merge.fixer_leftovers');
    expect(moved?.payload).toMatchObject({ moved: ['notes.txt'] });
    const folder = (moved?.payload as { folder: string }).folder;
    expect(await readFile(path.join(local, folder, 'files', 'notes.txt'), 'utf8')).toBe(
      'scratch\n',
    );

    await writeFile(path.join(wt, 'README.md'), '# vareska\n\nboth sides\n', 'utf8');
    const out = await planMergeStep.apply(ctx, {
      detected: retried,
      formValues: {},
      llmOutput: 'Kept both sides.',
      llmInvocationId: 'inv2',
      iteration: 0,
      previousIterations: [],
    });
    expect(out.resolved).toBe(true);
    expect(await gitCode(wt, ['cat-file', '-e', 'HEAD:notes.txt'])).not.toBe(0);
  });

  it('commits nothing while the index holds what a fixer staged outside the conflict', async () => {
    const local = await unrelatedPair();
    const { db } = fakeDb();
    const ctx = contextFor(local, db);
    const detected = await planMergeStep.detect!(ctx);
    const wt = detected.worktreePath;
    await writeFile(path.join(wt, 'README.md'), '# vareska\n\nboth sides\n', 'utf8');
    await writeFile(path.join(wt, 'notes.txt'), 'scratch\n', 'utf8');
    await git(wt, ['add', 'notes.txt']);
    await rm(path.join(wt, 'notes.txt'));
    const lock = path.join(local, '.git', 'worktrees', 'plan-merge', 'index.lock');
    await writeFile(lock, '');
    try {
      await expect(
        planMergeStep.apply(ctx, {
          detected,
          formValues: {},
          llmOutput: 'Kept both sides.',
          llmInvocationId: 'inv1',
          iteration: 0,
          previousIterations: [],
        }),
      ).rejects.toThrow('could not be taken back out of the index');
    } finally {
      await rm(lock, { force: true });
    }
    expect(await gitCode(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(0);
  });

  it('keeps a tree git could not record, so what a failed fixer left is reported', async () => {
    const local = await unrelatedPair();
    const { db, events, flags } = fakeDb();
    const ctx = contextFor(local, db);
    flags.maskFails = true;
    const first = await planMergeStep.detect!(ctx);
    expect(first.fixBaseline).toHaveProperty('unavailable');
    const wt = first.worktreePath;
    await writeFile(path.join(wt, 'notes.txt'), 'scratch\n', 'utf8');
    await git(wt, ['add', 'notes.txt']);
    flags.maskFails = false;

    const retried = await planMergeStep.detect!(ctx);
    expect(retried.fixBaseline).toEqual(first.fixBaseline);
    await writeFile(path.join(wt, 'README.md'), '# vareska\n\nboth sides\n', 'utf8');
    await planMergeStep.apply(ctx, {
      detected: retried,
      formValues: {},
      llmOutput: 'Kept both sides.',
      llmInvocationId: 'inv2',
      iteration: 0,
      previousIterations: [],
    });
    expect(events.find((e) => e.eventType === 'merge.fixer_leftovers')?.payload).toMatchObject({
      unchecked: expect.stringContaining('nothing was recorded'),
    });
  });

  it('reports a tree git could not record before sending in the fixer after one that did not finish', async () => {
    const local = await unrelatedPair();
    const { db, events, flags } = fakeDb();
    const ctx = contextFor(local, db);
    const leftoversEvents = () => events.filter((e) => e.eventType === 'merge.fixer_leftovers');
    flags.maskFails = true;
    const first = await planMergeStep.detect!(ctx);
    expect(first.fixBaseline).toHaveProperty('unavailable');
    await planMergeStep.llm!.prepareWorkspace!({ ctx, detected: first, formValues: {} });
    expect(leftoversEvents()).toEqual([]);
    await writeFile(path.join(first.worktreePath, 'notes.txt'), 'scratch\n', 'utf8');
    flags.maskFails = false;

    const retried = await planMergeStep.detect!(ctx);
    await planMergeStep.llm!.prepareWorkspace!({ ctx, detected: retried, formValues: {} });
    expect(leftoversEvents()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          unchecked: expect.stringContaining('nothing was recorded'),
        }),
      }),
    ]);
  });

  it('reports what the conversation whose merge it resumes never reported', async () => {
    const local = await unrelatedPair();
    const { db, events } = fakeDb();
    const first = await planMergeStep.detect!(contextFor(local, db));
    const wt = first.worktreePath;
    await writeFile(path.join(wt, 'notes.txt'), 'scratch\n', 'utf8');
    // The first conversation's move stopped before its event: nothing reported it.
    await relocateFixerChanges(
      wt,
      first.fixBaseline,
      { taskId: 't1', runId: 'inv1' },
      async () => null,
    );

    const next = { ...contextFor(local, db), taskId: 't2', taskStepId: 's2' } as StepContext;
    const resumed = await planMergeStep.detect!(next);
    expect(resumed.fixBaselineOwner).toBe('t1');
    await planMergeStep.llm!.prepareWorkspace!({ ctx: next, detected: resumed, formValues: {} });
    expect(events.find((e) => e.eventType === 'merge.fixer_leftovers')).toMatchObject({
      taskId: 't2',
      payload: { interrupted: ['.haive/merge-leftovers/t1/inv1'] },
    });
  });

  it('records the tree afresh when it opens the merge again', async () => {
    const local = await unrelatedPair();
    const { db, events } = fakeDb();
    const ctx = contextFor(local, db);
    const first = await planMergeStep.detect!(ctx);
    const wt = first.worktreePath;
    await git(wt, ['merge', '--abort']);
    await writeFile(path.join(wt, 'kept.txt'), 'here before the merge\n', 'utf8');

    const again = await planMergeStep.detect!(ctx);
    expect(again.mergeOpen).toBe(true);
    expect((again.fixBaseline as FixBaseline).tree).not.toBe(
      (first.fixBaseline as FixBaseline).tree,
    );
    expect(events.filter((e) => e.eventType === PLAN_MERGE_BASELINE_EVENT)).toHaveLength(2);
    await planMergeStep.llm!.prepareWorkspace!({ ctx, detected: again, formValues: {} });
    expect(await readFile(path.join(wt, 'kept.txt'), 'utf8')).toBe('here before the merge\n');
  });
});

/** The answer pass done: the agent's resolution committed in the scratch worktree. */
async function resolved(
  local: string,
  db: unknown,
  body: string | null = '# vareska\n\nboth sides\n',
): Promise<{ ctx: StepContext; wt: string }> {
  const ctx = contextFor(local, db);
  const detected = await planMergeStep.detect!(ctx);
  const wt = detected.worktreePath;
  if (body === null) await rm(path.join(wt, 'README.md'));
  else await writeFile(path.join(wt, 'README.md'), body, 'utf8');
  const out = await planMergeStep.apply(ctx, {
    detected,
    formValues: {},
    llmOutput: 'Kept both sides.',
    llmInvocationId: 'inv1',
    iteration: 0,
    previousIterations: [],
  });
  expect(out.resolved).toBe(true);
  return { ctx, wt };
}

const revise = (
  ctx: StepContext,
  detected: Awaited<ReturnType<NonNullable<typeof planMergeStep.detect>>>,
) =>
  planMergeStep.apply(ctx, {
    detected,
    formValues: { decision: 'revise', message: 'also keep the forge heading' },
    llmOutput: undefined,
    iteration: 0,
    previousIterations: [],
  });

describe('plan merge: asking for a change after the merge was resolved', () => {
  it('reopens the conflicts as git opens them, under the new guidance', async () => {
    const local = await unrelatedPair();
    const { db } = fakeDb();
    const head = (await git(local, ['rev-parse', 'HEAD'])).trim();
    const { ctx, wt } = await resolved(local, db);
    const collect = await planMergeStep.detect!(ctx);
    expect(collect.conflicts).toEqual([]);
    expect((await revise(ctx, collect)).continueRequested).toBe(true);

    const next = await planMergeStep.detect!(ctx);
    expect(next.mergeOpen).toBe(true);
    expect(next.conflicts).toEqual(['README.md']);
    expect(next.pendingGuidance).toBe('also keep the forge heading');
    expect(planMergeStep.llm!.skipIf!({ detected: next, formValues: {}, iteration: 0 })).toBe(
      false,
    );
    expect(await readFile(path.join(wt, 'README.md'), 'utf8')).toContain('<<<<<<<');
    expect(await git(local, ['rev-parse', 'HEAD'])).toBe(`${head}\n`);

    await writeFile(path.join(wt, 'README.md'), '# vareska\n\nboth sides, forge heading\n', 'utf8');
    const again = await planMergeStep.apply(ctx, {
      detected: next,
      formValues: {},
      llmOutput: 'Kept the heading too.',
      llmInvocationId: 'inv2',
      iteration: 0,
      previousIterations: [],
    });
    expect(again.resolved).toBe(true);
    expect(await git(wt, ['rev-parse', 'HEAD^1'])).toBe(`${head}\n`);
    expect(await git(wt, ['show', 'HEAD:README.md'])).toBe(
      '# vareska\n\nboth sides, forge heading\n',
    );
    expect(await git(wt, ['rev-list', '--merges', '--count', `${head}..HEAD`])).toBe('1\n');
  });

  it.runIf(process.getuid?.() === 0)(
    'hands the reopened files to the tree owner a fixer runs as',
    async () => {
      const local = await unrelatedPair();
      const { db } = fakeDb();
      const { ctx, wt } = await resolved(local, db);
      await exec('chown', ['-R', '1000:1000', local]);
      await revise(ctx, await planMergeStep.detect!(ctx));
      expect((await planMergeStep.detect!(ctx)).conflicts).toEqual(['README.md']);
      expect((await lstat(path.join(wt, 'README.md'))).uid).toBe(1000);
    },
  );

  it("leaves a merge that is not this conversation's own unlanded one alone", async () => {
    const local = await unrelatedPair();
    const { db } = fakeDb();
    const { ctx, wt } = await resolved(local, db);
    const sha = (await git(wt, ['rev-parse', 'HEAD'])).trim();
    await git(local, ['merge', '--ff-only', sha]);

    const collect = await planMergeStep.detect!(ctx);
    await revise(ctx, collect);
    const next = await planMergeStep.detect!(ctx);
    expect(next.mergeOpen).toBe(false);
    expect(next.conflicts).toEqual([]);
    expect((await git(wt, ['rev-parse', 'HEAD'])).trim()).toBe(sha);
  });

  it('offers a resolution another conversation left, without reopening it', async () => {
    const local = await unrelatedPair();
    const { db, flags } = fakeDb();
    const { wt } = await resolved(local, db);
    const sha = (await git(wt, ['rev-parse', 'HEAD'])).trim();
    flags.readTaskId = 't2';
    const next = await planMergeStep.detect!({
      ...contextFor(local, db),
      taskId: 't2',
    } as StepContext);
    expect(next.conflicts).toEqual([]);
    expect(next.mergeOpen).toBe(false);
    expect((await git(wt, ['rev-parse', 'HEAD'])).trim()).toBe(sha);
  });
});

describe("plan merge: discarding a cancelled conversation's merge", () => {
  async function open(local: string, db: unknown): Promise<{ ctx: StepContext; wt: string }> {
    const ctx = contextFor(local, db);
    return { ctx, wt: (await planMergeStep.detect!(ctx)).worktreePath };
  }
  const registered = async (local: string, wt: string): Promise<boolean> =>
    (await git(local, ['worktree', 'list', '--porcelain'])).includes(`worktree ${wt}`);

  it('removes the scratch worktree, so the next conversation starts the merge afresh', async () => {
    const local = await unrelatedPair();
    const { db, flags } = fakeDb();
    flags.repoPath = local;
    const { wt } = await resolved(local, db);

    await discardPlanMerge(db as never, 't1');
    expect(await registered(local, wt)).toBe(false);

    flags.readTaskId = 't2';
    const next = await planMergeStep.detect!({
      ...contextFor(local, db),
      taskId: 't2',
    } as StepContext);
    expect(next.mergeOpen).toBe(true);
    expect(next.conflicts).toEqual(['README.md']);
    expect(await readFile(path.join(wt, 'README.md'), 'utf8')).toContain('<<<<<<<');
  });

  it('records a discard that could not remove the worktree, rather than calling it done', async () => {
    const local = await unrelatedPair();
    const { db, events, flags } = fakeDb();
    flags.repoPath = local;
    const { wt } = await open(local, db);
    // A locked worktree refuses `worktree remove --force`, so the removal fails.
    await git(local, ['worktree', 'lock', wt]);

    await discardPlanMerge(db as never, 't1');
    expect(await registered(local, wt)).toBe(true);
    expect(events.some((e) => e.eventType === 'plan_merge.discard_failed')).toBe(true);
    await git(local, ['worktree', 'unlock', wt]);
  });

  it('moves aside what a fixer left in the open merge, and reports it', async () => {
    const local = await unrelatedPair();
    const { db, events, flags } = fakeDb();
    flags.repoPath = local;
    const { wt } = await open(local, db);
    await writeFile(path.join(wt, 'notes.txt'), 'scratch\n', 'utf8');

    await discardPlanMerge(db as never, 't1');
    expect(await registered(local, wt)).toBe(false);
    const moved = events.find((e) => e.eventType === 'merge.fixer_leftovers');
    expect(moved?.payload).toMatchObject({ moved: ['notes.txt'] });
    const folder = (moved?.payload as { folder: string }).folder;
    expect(await readFile(path.join(local, folder, 'files', 'notes.txt'), 'utf8')).toBe(
      'scratch\n',
    );
  });

  it('leaves the worktree to another live conversation, and says so', async () => {
    const local = await unrelatedPair();
    const { db, events, flags } = fakeDb();
    flags.repoPath = local;
    flags.others = [{ id: 't2' }];
    const { wt } = await open(local, db);

    await discardPlanMerge(db as never, 't1');
    expect(await registered(local, wt)).toBe(true);
    expect(await gitCode(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(0);
    expect(events.find((e) => e.eventType === 'plan_merge.discard_skipped')?.payload).toMatchObject(
      {
        otherTaskId: 't2',
      },
    );
  });

  it('touches nothing of another kind of task, and never throws', async () => {
    const local = await unrelatedPair();
    const { db, events, flags } = fakeDb();
    flags.repoPath = local;
    const { wt } = await open(local, db);

    flags.taskType = 'plan_chat';
    await discardPlanMerge(db as never, 't1');
    expect(await registered(local, wt)).toBe(true);

    flags.taskType = 'plan_merge';
    const lock = path.join(local, '.git', 'worktrees', 'plan-merge', 'index.lock');
    await writeFile(path.join(wt, 'notes.txt'), 'scratch\n', 'utf8');
    await git(wt, ['add', 'notes.txt']);
    await rm(path.join(wt, 'notes.txt'));
    await writeFile(lock, '');
    try {
      await expect(discardPlanMerge(db as never, 't1')).resolves.toBeUndefined();
    } finally {
      await rm(lock, { force: true });
    }
    expect(await registered(local, wt)).toBe(true);
    expect(events.find((e) => e.eventType === 'plan_merge.discard_failed')).toBeDefined();
  });
});

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type MergeResolveState } from '@haive/database';
import { captureFixBaseline } from '../step-engine/git-merge.js';
import { settleCancelledMerges } from './task-queue.js';

vi.mock('./cli-exec/secret-mask.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cli-exec/secret-mask.js')>()),
  taskSecretMaskPolicy: async () => null,
}));

const exec = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const git = async (dir: string, args: string[]): Promise<string> =>
  (await exec('git', args, { cwd: dir, env: ENV })).stdout.toString();
const mergeOpen = async (dir: string): Promise<boolean> =>
  exec('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: dir, env: ENV }).then(
    () => true,
    () => false,
  );

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })),
  );
});

/** A repo with `feature/x` merging into `main` over `base.txt`, a conflict left open. */
async function openConflict(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gm-cancel-'));
  dirs.push(dir);
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'gc.auto', '0']);
  await git(dir, ['config', 'maintenance.auto', 'false']);
  await writeFile(path.join(dir, 'base.txt'), 'base\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'init']);
  await git(dir, ['checkout', '-b', 'feature/x']);
  await writeFile(path.join(dir, 'base.txt'), 'feature\n');
  await git(dir, ['commit', '-am', 'feature']);
  await git(dir, ['checkout', 'main']);
  await writeFile(path.join(dir, 'base.txt'), 'main\n');
  await git(dir, ['commit', '-am', 'main']);
  await exec('git', ['merge', '--no-ff', '--no-edit', 'feature/x'], { cwd: dir, env: ENV }).catch(
    () => undefined,
  );
  return dir;
}

async function stateFor(dir: string, withBaseline: boolean): Promise<MergeResolveState> {
  const fixBaseline = withBaseline ? await captureFixBaseline(dir, async () => null) : null;
  return {
    mode: 'same-branch',
    phase: 'resolving',
    baseBranch: 'main',
    featureBranch: 'feature/x',
    mergeDir: dir,
    sandboxMergeDir: dir,
    fixInvocationId: 'inv-1',
    conflictRetries: 1,
    pendingQuestion: null,
    pushAfterMerge: false,
    merged: false,
    skipReason: null,
    pushed: false,
    fixBaseline,
  } as MergeResolveState;
}

interface LevelRow {
  id: string;
  planId: string;
  stepRowId: string;
  mergeState: unknown;
}

function makeDb(
  rows: { id: string; state: MergeResolveState | null }[],
  worktreePath: string | null,
  dag: { levels: LevelRow[]; integration?: { worktreePath: string; branchName: string } } = {
    levels: [],
  },
) {
  const events: { eventType: string; payload: Record<string, unknown> }[] = [];
  const patches: Record<string, unknown>[] = [];
  const levelPatches: Record<string, unknown>[] = [];
  const db = {
    query: { tasks: { findFirst: async () => ({ worktreePath }) } },
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.taskDagLevels) {
          return { innerJoin: () => ({ where: async () => dag.levels }) };
        }
        if (table === schema.taskDagIssues) {
          return { where: async () => [{ branchName: 'main--ISSUE-1' }] };
        }
        return {
          where: () =>
            Object.assign(Promise.resolve(rows), {
              orderBy: () => ({
                limit: async () => (dag.integration ? [{ output: dag.integration }] : []),
              }),
            }),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          (table === schema.taskDagLevels ? levelPatches : patches).push(patch);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (v: { eventType: string; payload: Record<string, unknown> }) => {
        if (table === schema.taskEvents) events.push(v);
      },
    }),
  };
  return { db: db as never, events, patches, levelPatches };
}

describe('settleCancelledMerges', () => {
  it('moves a fixer change outside the conflict aside, reports it and aborts the merge', async () => {
    const dir = await openConflict();
    const state = await stateFor(dir, true);
    await writeFile(path.join(dir, 'stray.txt'), 'fixer scratch\n');
    const h = makeDb([{ id: 'row1', state }], null);
    await settleCancelledMerges(h.db, 'task-1');
    expect(await mergeOpen(dir)).toBe(false);
    expect(await readFile(path.join(dir, 'base.txt'), 'utf8')).toBe('main\n');
    expect(
      await readFile(path.join(dir, '.haive/merge-leftovers/task-1/inv-1/files/stray.txt'), 'utf8'),
    ).toBe('fixer scratch\n');
    const event = h.events.find((e) => e.eventType === 'merge.fixer_leftovers');
    expect(event?.payload).toMatchObject({ branch: 'feature/x', movedCount: 1 });
    expect(h.events.some((e) => e.eventType === 'merge.abort_failed')).toBe(false);
    expect(h.patches).toEqual([{ mergeResolveState: { ...state, fixBaseline: null } }]);
  });

  it('touches nothing for a task with no merge state, or none with a fixer in flight', async () => {
    const dir = await openConflict();
    const idle = await stateFor(dir, false);
    for (const rows of [[], [{ id: 'row1', state: null }], [{ id: 'row2', state: idle }]]) {
      const h = makeDb(rows, null);
      await settleCancelledMerges(h.db, 'task-1');
      expect(h.events).toEqual([]);
      expect(h.patches).toEqual([]);
    }
    expect(await mergeOpen(dir)).toBe(true);
  });

  it("settles a merge in the task's own worktree when the cancel kept that worktree", async () => {
    const dir = await openConflict();
    const state = await stateFor(dir, true);
    const h = makeDb([{ id: 'row1', state }], dir);
    await settleCancelledMerges(h.db, 'task-1');
    expect(await mergeOpen(dir)).toBe(false);
    expect(h.patches).toEqual([{ mergeResolveState: { ...state, fixBaseline: null } }]);
  });

  it('does nothing for a merge whose worktree the cancel removed', async () => {
    const dir = await openConflict();
    const state = await stateFor(dir, true);
    await rm(dir, { recursive: true, force: true });
    const h = makeDb([{ id: 'row1', state }], dir);
    await settleCancelledMerges(h.db, 'task-1');
    expect(h.events).toEqual([]);
    expect(h.patches).toEqual([]);
  });

  it('leaves alone a merge that is no longer the one the fixer was sent into', async () => {
    const dir = await openConflict();
    const state = await stateFor(dir, true);
    await git(dir, ['merge', '--abort']);
    const h = makeDb([{ id: 'row1', state }], null);
    await settleCancelledMerges(h.db, 'task-1');
    expect(h.events).toEqual([]);
    expect(h.patches).toEqual([]);
  });

  it('leaves alone the same feature merged again onto a base that moved', async () => {
    const dir = await openConflict();
    const state = await stateFor(dir, true);
    await git(dir, ['merge', '--abort']);
    await writeFile(path.join(dir, 'other.txt'), 'base moved\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'base moved']);
    await git(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']).catch(() => undefined);
    const h = makeDb([{ id: 'row1', state }], null);
    await settleCancelledMerges(h.db, 'task-1');
    expect(await mergeOpen(dir)).toBe(true);
    expect(h.events).toEqual([]);
    expect(h.patches).toEqual([]);
  });

  it('clears the baseline only once the merge is aborted, so a crash in between can settle again', async () => {
    const dir = await openConflict();
    const state = await stateFor(dir, true);
    const h = makeDb([{ id: 'row1', state }], null);
    const openWhenCleared: boolean[] = [];
    const update = h.db as unknown as { update: () => unknown };
    const real = update.update;
    update.update = () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          openWhenCleared.push(await mergeOpen(dir));
          h.patches.push(patch);
        },
      }),
    });
    await settleCancelledMerges(h.db, 'task-1');
    update.update = real;
    expect(openWhenCleared).toEqual([false]);
  });

  it('finishes when the abort fails, and says so', async () => {
    const dir = await openConflict();
    const state = await stateFor(dir, true);
    await writeFile(path.join(dir, '.git', 'index.lock'), '');
    const h = makeDb([{ id: 'row1', state }], null);
    await expect(settleCancelledMerges(h.db, 'task-1')).resolves.toBeUndefined();
    expect(h.events.some((e) => e.eventType === 'merge.abort_failed')).toBe(true);
    expect(await mergeOpen(dir)).toBe(true);
  });

  it('settles a merge whose baseline git could not record, when it names the merge that stands', async () => {
    const dir = await openConflict();
    const state = await stateFor(dir, false);
    state.fixBaseline = {
      unavailable: 'git could not record the tree: boom',
      head: (await git(dir, ['rev-parse', 'HEAD'])).trim(),
      mergeHead: (await git(dir, ['rev-parse', 'MERGE_HEAD'])).trim(),
    } as MergeResolveState['fixBaseline'];
    const h = makeDb([{ id: 'row1', state }], null);
    await settleCancelledMerges(h.db, 'task-1');
    expect(await mergeOpen(dir)).toBe(false);
    const event = h.events.find((e) => e.eventType === 'merge.fixer_leftovers');
    expect(event?.payload.unchecked).toContain('boom');
    expect(h.patches).toEqual([{ mergeResolveState: { ...state, fixBaseline: null } }]);
  });

  it('leaves open a merge whose unrecorded baseline names no merge', async () => {
    const dir = await openConflict();
    const state = await stateFor(dir, false);
    state.fixBaseline = { unavailable: 'git could not read the merge' };
    const h = makeDb([{ id: 'row1', state }], null);
    await settleCancelledMerges(h.db, 'task-1');
    expect(await mergeOpen(dir)).toBe(true);
    expect(h.events).toEqual([]);
    expect(h.patches).toEqual([]);
  });
});

describe('settleCancelledMerges for a DAG level', () => {
  async function levelFor(dir: string): Promise<LevelRow> {
    const fixBaseline = await captureFixBaseline(dir, async () => null);
    return {
      id: 'lvl1',
      planId: 'plan1',
      stepRowId: 'dag-step',
      mergeState: {
        activeConflict: 'ISSUE-1',
        fixInvocationId: 'inv-9',
        conflictRetries: { 'ISSUE-1': 1 },
        fixBaseline,
        lastFixerCut: false,
      },
    };
  }

  it('moves a DAG fixer change aside, reports it, clears the baseline and aborts the merge', async () => {
    const dir = await openConflict();
    const level = await levelFor(dir);
    await writeFile(path.join(dir, 'stray.txt'), 'fixer scratch\n');
    const h = makeDb([], null, {
      levels: [level],
      integration: { worktreePath: dir, branchName: 'main' },
    });
    await settleCancelledMerges(h.db, 'task-1');
    expect(await mergeOpen(dir)).toBe(false);
    expect(
      await readFile(path.join(dir, '.haive/merge-leftovers/task-1/inv-9/files/stray.txt'), 'utf8'),
    ).toBe('fixer scratch\n');
    const event = h.events.find((e) => e.eventType === 'merge.fixer_leftovers');
    expect(event?.payload).toMatchObject({ branch: 'main--ISSUE-1', movedCount: 1 });
    expect(h.levelPatches).toEqual([
      {
        mergeState: { ...(level.mergeState as object), fixBaseline: null },
        updatedAt: expect.any(Date),
      },
    ]);
  });

  it('does nothing for a level whose worktree the cancel removed, or with no merge state', async () => {
    const dir = await openConflict();
    const level = await levelFor(dir);
    await rm(dir, { recursive: true, force: true });
    for (const levels of [[level], []]) {
      const h = makeDb([], null, {
        levels,
        integration: { worktreePath: dir, branchName: 'main' },
      });
      await settleCancelledMerges(h.db, 'task-1');
      expect(h.events).toEqual([]);
      expect(h.levelPatches).toEqual([]);
    }
  });
});

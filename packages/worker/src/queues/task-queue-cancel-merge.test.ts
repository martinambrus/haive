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

function makeDb(
  rows: { id: string; state: MergeResolveState | null }[],
  worktreePath: string | null,
) {
  const events: { eventType: string; payload: Record<string, unknown> }[] = [];
  const patches: Record<string, unknown>[] = [];
  const db = {
    query: { tasks: { findFirst: async () => ({ worktreePath }) } },
    select: () => ({ from: () => ({ where: async () => rows }) }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          patches.push(patch);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (v: { eventType: string; payload: Record<string, unknown> }) => {
        if (table === schema.taskEvents) events.push(v);
      },
    }),
  };
  return { db: db as never, events, patches };
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

  it("leaves a merge in the task's own worktree to the worktree's removal", async () => {
    const dir = await openConflict();
    const state = await stateFor(dir, true);
    const h = makeDb([{ id: 'row1', state }], dir);
    await settleCancelledMerges(h.db, 'task-1');
    expect(await mergeOpen(dir)).toBe(true);
    expect(h.events).toEqual([]);
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

  it('finishes when the abort fails, and says so', async () => {
    const dir = await openConflict();
    const state = await stateFor(dir, true);
    await writeFile(path.join(dir, '.git', 'index.lock'), '');
    const h = makeDb([{ id: 'row1', state }], null);
    await expect(settleCancelledMerges(h.db, 'task-1')).resolves.toBeUndefined();
    expect(h.events.some((e) => e.eventType === 'merge.abort_failed')).toBe(true);
    expect(await mergeOpen(dir)).toBe(true);
  });
});

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database, type MergeResolveState } from '@haive/database';
import { recordLandedMerge } from './landed-merge.js';

vi.mock('./step-ownership.js', async (original) => ({
  ...(await original<typeof import('./step-ownership.js')>()),
  updateOwnedStep: async (db: unknown, id: string, patch: unknown) => {
    const fake = db as { taken?: boolean; state?: unknown };
    if (fake.taken) {
      const { StepSupersededError } = await import('./step-ownership.js');
      throw new StepSupersededError(id);
    }
    fake.state = patch;
    return { id };
  },
}));
const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
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
async function landed() {
  const dir = await mkdtemp(path.join(tmpdir(), 'e2-landed-'));
  dirs.push(dir);
  await git(dir, 'init', '-b', 'main');
  await writeFile(path.join(dir, 'base'), 'base');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'base');
  const before = await git(dir, 'rev-parse', 'HEAD');
  await git(dir, 'switch', '-c', 'feature');
  await writeFile(path.join(dir, 'feature'), 'feature');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'feature');
  await git(dir, 'switch', 'main');
  await git(dir, 'merge', '--no-ff', 'feature', '-m', 'merge');
  const after = await git(dir, 'rev-parse', 'HEAD');
  const state = {
    phase: 'resolving',
    baseShaBefore: before,
    baseBranch: 'main',
    mergeDir: dir,
    featureBranch: 'feature',
    merged: false,
  } as MergeResolveState;
  return { dir, before, after, state };
}
function fake() {
  const events: { eventType: string; payload: Record<string, unknown> }[] = [];
  const db = {
    taken: false,
    state: null as unknown,
    select: () => ({ from: () => ({ where: () => ({ orderBy: async () => events }) }) }),
    insert: (table: unknown) => ({
      values: async (event: (typeof events)[number]) => {
        expect(table).toBe(schema.taskEvents);
        events.push(event);
      },
    }),
  };
  return { db, events };
}
describe('step-12 durable landed merge', () => {
  it('records both base shas before reachDone sets merged, independently of step reset', async () => {
    const { dir, before, after, state } = await landed();
    const { db, events } = fake();
    await recordLandedMerge(db as unknown as Database, {
      taskId: 't',
      stepId: 's',
      stepKey: '12-worktree-cleanup',
      repoPath: dir,
      state,
    });
    expect(events).toMatchObject([
      {
        eventType: 'merge.landed',
        payload: { baseShaBefore: before, baseShaAfter: after, landedOn: 'main' },
      },
    ]);
    db.state = null;
    expect(events[0]?.payload.baseShaAfter).toBe(after);
    expect(events[0]?.payload).toMatchObject({
      featureBranch: 'feature',
      featureSha: await git(dir, 'rev-parse', 'feature'),
      mergeStage: 'feature',
    });
    expect(await git(dir, 'rev-parse', 'main')).toBe(after);
  });
  it('keeps the durable fact when cancel took the step during the merge section', async () => {
    const { dir, state, after } = await landed();
    const { db, events } = fake();
    db.taken = true;
    await recordLandedMerge(db as unknown as Database, {
      taskId: 't',
      stepId: 's',
      stepKey: '12-worktree-cleanup',
      repoPath: dir,
      state,
    });
    expect(events[0]?.payload.baseShaAfter).toBe(after);
    expect(db.state).toBeNull();
  });
  it('records the replacement squash sha with the original before sha', async () => {
    const { dir, state, before, after } = await landed();
    const { db, events } = fake();
    const args = { taskId: 't', stepId: 's', stepKey: '12-worktree-cleanup', repoPath: dir, state };
    await recordLandedMerge(db as unknown as Database, args);
    await git(dir, 'reset', '--soft', before);
    await git(dir, 'commit', '-m', 'squash');
    const squash = await git(dir, 'rev-parse', 'HEAD');
    expect(squash).not.toBe(after);
    await recordLandedMerge(db as unknown as Database, args);
    expect(events.at(-1)?.payload).toMatchObject({ baseShaBefore: before, baseShaAfter: squash });
  });
  it('does not record a merge when the base did not move or for other merge steps', async () => {
    const { dir, state, after } = await landed();
    const { db, events } = fake();
    await recordLandedMerge(db as unknown as Database, {
      taskId: 't',
      stepId: 's',
      stepKey: '00a-sync-base',
      repoPath: dir,
      state,
    });
    await recordLandedMerge(db as unknown as Database, {
      taskId: 't',
      stepId: 's',
      stepKey: '12-worktree-cleanup',
      repoPath: dir,
      state: { ...state, baseShaBefore: after },
    });
    expect(events).toEqual([]);
  });
  it('deduplicates recovery writes and keeps the original landing time', async () => {
    const { dir, state } = await landed();
    const { db, events } = fake();
    const args = { taskId: 't', stepId: 's', stepKey: '12-worktree-cleanup', repoPath: dir, state };
    await recordLandedMerge(db as unknown as Database, args);
    const at = events[0]?.payload.landedAt;
    await recordLandedMerge(db as unknown as Database, args);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.landedAt).toBe(at);
  });
  it('fails a landing-state write if its durable journal cannot be written', async () => {
    const { dir, state } = await landed();
    const { db, events } = fake();
    vi.spyOn(db, 'insert').mockImplementationOnce(() => ({
      values: async () => {
        throw new Error('journal refused');
      },
    }));
    await expect(
      recordLandedMerge(db as unknown as Database, {
        taskId: 't',
        stepId: 's',
        stepKey: '12-worktree-cleanup',
        repoPath: dir,
        state,
      }),
    ).rejects.toThrow('journal refused');
    expect(events).toEqual([]);
    expect(db.state).toBeNull();
  });
});

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';
import * as gitPush from '../repo/git-push.js';
import { recordLeftCommittedMerge } from './left-committed-merge.js';
const locks = vi.hoisted(() => ({
  seen: [] as string[],
  before: undefined as ((dir: string) => void) | undefined,
}));
let tail = Promise.resolve();
vi.mock('./merge-dir-claim.js', () => ({
  inMergeDirLock: async (db: unknown, dir: string, fn: (tx: unknown) => Promise<unknown>) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      locks.seen.push(dir);
      locks.before?.(dir);
      return await fn(db);
    } finally {
      release();
    }
  },
}));
const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  locks.seen.length = 0;
  locks.before = undefined;
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
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'e2-report-'));
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
  const payload = {
    baseShaBefore: before,
    baseShaAfter: after,
    landedOn: 'main',
    landedAt: new Date().toISOString(),
    repoPath: dir,
    dir,
  };
  const events: { eventType: string; payload: Record<string, unknown> }[] = [
    { eventType: 'merge.landed', payload },
  ];
  const db = {
    query: {
      tasks: { findFirst: async () => ({ status: 'cancelled' }) },
      taskSteps: { findFirst: async () => null },
    },
    select: () => ({ from: () => ({ where: () => ({ orderBy: async () => events }) }) }),
    insert: () => ({
      values: async (e: (typeof events)[number]) => {
        events.push(e);
      },
    }),
  };
  return { dir, before, after, payload, events, db: db as unknown as Database };
}
describe('cancel reports a merge left committed on the local base', () => {
  it('keeps a known pushed merge report-only for the owner', async () => {
    const f = await fixture();
    vi.spyOn(f.db.query.taskSteps, 'findFirst').mockResolvedValue({
      mergeResolveState: { pushed: true },
    } as never);
    await recordLeftCommittedMerge(f.db, 't');
    expect(f.events.at(-1)?.payload.pushed).toBe(true);
  });
  it('checks every recorded directory before deciding that no landing exists', async () => {
    const f = await fixture();
    f.events.length = 0;
    locks.before = (dir) => {
      if (dir === '/other')
        f.events.push({ eventType: 'merge.landed', payload: { ...f.payload, dir } });
    };
    await recordLeftCommittedMerge(f.db, 't', [f.dir, '/other', f.dir]);
    expect(locks.seen).toEqual([f.dir, '/other']);
    expect(f.events.filter((e) => e.eventType === 'merge.left_committed')).toHaveLength(1);
  });
  it('reports before reachDone, once across concurrent cancels and teardown retries, without undoing', async () => {
    const f = await fixture();
    await Promise.all([recordLeftCommittedMerge(f.db, 't'), recordLeftCommittedMerge(f.db, 't')]);
    await recordLeftCommittedMerge(f.db, 't');
    expect(f.events.filter((e) => e.eventType === 'merge.left_committed')).toMatchObject([
      { payload: { baseShaBefore: f.before, baseShaAfter: f.after, landedOn: 'main' } },
    ]);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
  });
  it('reports when the branch has advanced and still contains the merge, even with another branch checked out', async () => {
    const f = await fixture();
    await writeFile(path.join(f.dir, 'later'), 'later');
    await git(f.dir, 'add', '.');
    await git(f.dir, 'commit', '-m', 'later');
    await git(f.dir, 'switch', 'feature');
    await recordLeftCommittedMerge(f.db, 't');
    expect(f.events.at(-1)?.eventType).toBe('merge.left_committed');
  });
  it('reports neither an unlanded merge nor one removed from the local base', async () => {
    const f = await fixture();
    await git(f.dir, 'reset', '--hard', f.before);
    await recordLeftCommittedMerge(f.db, 't');
    expect(f.events).toHaveLength(1);
    f.events.length = 0;
    await recordLeftCommittedMerge(f.db, 't');
    expect(f.events).toEqual([]);
  });
  it('uses the replacement squash sha, not the discarded merge commit', async () => {
    const f = await fixture();
    await git(f.dir, 'reset', '--soft', f.before);
    await git(f.dir, 'commit', '-m', 'squash');
    const after = await git(f.dir, 'rev-parse', 'HEAD');
    f.events.push({ eventType: 'merge.landed', payload: { ...f.payload, baseShaAfter: after } });
    await recordLeftCommittedMerge(f.db, 't');
    expect(f.events.at(-1)).toMatchObject({
      eventType: 'merge.left_committed',
      payload: { baseShaAfter: after },
    });
  });
  it('does not swallow a failed report write', async () => {
    const f = await fixture();
    vi.spyOn(f.db, 'insert').mockImplementationOnce(
      () =>
        ({
          values: async () => {
            throw new Error('write refused');
          },
        }) as never,
    );
    await expect(recordLeftCommittedMerge(f.db, 't')).rejects.toThrow('write refused');
  });
  it.each(['deleted branch', 'missing repository', 'invalid repository', 'missing object'])(
    'warns without reporting or failing cancel for a %s',
    async (failure) => {
      const f = await fixture();
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      if (failure === 'deleted branch') {
        await git(f.dir, 'switch', 'feature');
        await git(f.dir, 'branch', '-D', 'main');
      } else if (failure === 'missing repository') {
        await rm(f.dir, { recursive: true, force: true });
      } else if (failure === 'invalid repository') {
        await rm(path.join(f.dir, '.git'), { recursive: true, force: true });
      } else {
        f.payload.baseShaAfter = '0'.repeat(40);
      }
      await expect(recordLeftCommittedMerge(f.db, 't')).resolves.toBeUndefined();
      expect(f.events.filter((e) => e.eventType === 'merge.left_committed')).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    },
  );
  it('keeps a git timeout retryable', async () => {
    const f = await fixture();
    vi.spyOn(gitPush, 'gitRun').mockResolvedValueOnce({
      code: 124,
      stdout: '',
      stderr: 'git merge-base timed out',
    });
    await expect(recordLeftCommittedMerge(f.db, 't')).rejects.toThrow('timed out');
    expect(f.events).toHaveLength(1);
  });
});

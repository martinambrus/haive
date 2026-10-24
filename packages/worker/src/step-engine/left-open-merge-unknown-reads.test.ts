import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { failGit } from '../../test/support/fake-git.js';

vi.mock('./merge-dir-claim.js', () => ({
  inMergeDirLock: async (db: unknown, _dir: string, fn: (tx: unknown) => unknown) => fn(db),
  liveClaimHolder: async () => null,
}));
vi.mock('../repo/worktree-claims.js', () => ({ findWorktreePathClaimant: async () => null }));
vi.mock('../queues/cli-exec/secret-mask.js', () => ({ taskSecretMaskPolicy: async () => ({}) }));

import { abortLeftMerge, peekOpenMerge, recordLeftOpenMerges } from './left-open-merge.js';

const exec = promisify(execFile);
const IDENTITY = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const MERGE_HEAD = ['rev-parse', '-q', '--verify', 'MERGE_HEAD'];
const FAILED = /^git rev-parse MERGE_HEAD failed in .+: fatal: simulated failure/;

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: { ...process.env, ...IDENTITY } });
  return stdout.toString();
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5 });
});

async function conflictOpen(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lom-unknown-'));
  dirs.push(dir);
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'gc.auto', '0']);
  await writeFile(path.join(dir, 'base.txt'), 'base\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'init']);
  await git(dir, ['checkout', '-q', '-b', 'feature/x']);
  await writeFile(path.join(dir, 'base.txt'), 'feature\n');
  await git(dir, ['commit', '-qam', 'feature']);
  await git(dir, ['checkout', '-q', 'main']);
  await writeFile(path.join(dir, 'base.txt'), 'main\n');
  await git(dir, ['commit', '-qam', 'main']);
  await git(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']).catch(() => undefined);
  return dir;
}
const gone = () => path.join(tmpdir(), `lom-unknown-not-there-${process.pid}`);

/** A query builder whose every chained call resolves to the next queued result, in call order. */
function chainDb(queue: unknown[][], taskFind: unknown[] = []) {
  const inserted: { eventType?: string; payload?: { outcome?: string } }[] = [];
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop) => {
        if (prop === 'then') {
          const value = queue.shift() ?? [];
          return (resolve: (v: unknown) => void) => resolve(value);
        }
        return () => chain();
      },
    });
  const tx = {
    execute: async () => [{ ok: true }],
    select: () => chain(),
    insert: () => ({ values: async (v: never) => void inserted.push(v) }),
  };
  const finds = [...taskFind];
  const db = {
    query: { tasks: { findFirst: async () => finds.shift() ?? null } },
    select: () => chain(),
    transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    insert: tx.insert,
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  return { db: db as unknown as Database, inserted };
}

const ACTIVE_CONFLICT = {
  state: { activeConflict: 'ISS-1', fixInvocationId: 'inv-1', fixBaseline: null },
  stepId: 's1',
};
/** The reads recordLeftOpenMerges makes for one DAG level of a task whose worktree is `worktree`. */
const dagLevel = (worktree: string, branch: string) =>
  chainDb([
    [],
    [],
    [{ worktreePath: worktree }],
    [ACTIVE_CONFLICT],
    [{ branchName: branch }],
    [],
    [],
  ]);

describe('L1 peekOpenMerge', () => {
  it('L1a rejects on a failed read', async () => {
    const dir = await conflictOpen();
    const shim = await failGit(MERGE_HEAD);
    try {
      await expect(peekOpenMerge(dir)).rejects.toThrow(FAILED);
    } finally {
      await shim.restore();
    }
  });
  it('L1b GUARD names the open merge, and is null once it is aborted', async () => {
    const dir = await conflictOpen();
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    expect(await peekOpenMerge(dir)).toEqual({ head, mergeHead: expect.any(String) });
    await git(dir, ['merge', '--abort']);
    expect(await peekOpenMerge(dir)).toBeNull();
  });
  it('L1c GUARD is null for a directory that is not there', async () => {
    expect(await peekOpenMerge(gone())).toBeNull();
  });
});

describe('L2 recordLeftOpenMerges on the cancel path', () => {
  it('L2 GUARD a DAG level whose task worktree the cancel already removed is gone: it resolves with no report', async () => {
    const { db, inserted } = dagLevel(gone(), 'feature/x--ISS-1');
    await expect(recordLeftOpenMerges(db, 'task-1')).resolves.toBeUndefined();
    expect(inserted).toEqual([]);
  });
  it('L2b a present directory whose MERGE_HEAD git cannot read rejects, so the cancel is re-driven', async () => {
    const dir = await conflictOpen();
    const { db, inserted } = dagLevel(dir, 'feature/x');
    const shim = await failGit(MERGE_HEAD);
    try {
      await expect(recordLeftOpenMerges(db, 'task-1')).rejects.toThrow(FAILED);
    } finally {
      await shim.restore();
    }
    expect(inserted).toEqual([]);
  });
});

describe('L4 abortLeftMerge', () => {
  it('L4 a failed read settles refused (the report stays open), never moved', async () => {
    const dir = await conflictOpen();
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const mergeHead = (await git(dir, ['rev-parse', 'MERGE_HEAD'])).trim();
    const report = [
      { eventType: 'merge.left_open', payload: { dir, ref: 'feature/x', head, mergeHead } },
    ];
    const step = [
      {
        id: 'step-1',
        state: {
          phase: 'resolving',
          mergeDir: dir,
          featureBranch: 'feature/x',
          fixInvocationId: 'inv-1',
          fixBaseline: { head, mergeHead, tree: 't' },
        },
      },
    ];
    const { db, inserted } = chainDb(
      [report, step, [{ worktreePath: null }], [], [], report],
      [{ status: 'cancelled', repositoryId: null }],
    );
    const shim = await failGit(MERGE_HEAD);
    try {
      await abortLeftMerge(db, { taskId: 'task-1', userId: 'u', dir, mergeHead });
    } finally {
      await shim.restore();
    }
    const settled = inserted.filter((v) => v.eventType === 'merge.left_open_settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload!.outcome).toBe('refused');
    expect((await git(dir, ['rev-parse', 'MERGE_HEAD'])).trim()).toBe(mergeHead);
  });
});

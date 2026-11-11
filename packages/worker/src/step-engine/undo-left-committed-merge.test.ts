import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import * as subject from './left-committed-merge.js';
import * as gitMerge from './git-merge.js';
import * as gitPush from '../repo/git-push.js';

const h = vi.hoisted(() => ({
  holder: false,
  root: true,
  holding: 0,
  synced: true,
  sync: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@haive/database', async (original) => ({
  ...(await original<object>()),
  acquireRootClaim: async () => (h.root ? { release: h.release, lost: () => false } : null),
  lockRepositoryTasksKey: async () => undefined,
}));
let tail = Promise.resolve();
vi.mock('./merge-dir-claim.js', () => ({
  liveClaimHolder: async () => (h.holder ? { id: 'other', title: 'Other' } : null),
  inMergeDirLock: async (db: unknown, _dir: string, fn: (tx: unknown) => Promise<unknown>) => {
    const prev = tail;
    let release!: () => void;
    tail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn(db);
    } finally {
      release();
    }
  },
}));
vi.mock('../repo/refresh.js', () => ({ checkoutHoldingTasks: async () => h.holding }));
vi.mock('../repo/worktree-claims.js', () => ({ findWorktreePathClaimant: async () => null }));
vi.mock('../project-state/set-aside.js', () => ({
  resyncHaiveProjections: async (...args: unknown[]) => {
    h.sync(...args);
    return h.synced;
  },
}));
// Local bare remotes exercise real containment of a pushed commit. Production uses the guarded transport.
vi.mock('../repo/git-push.js', async (original) => {
  const actual = await original<typeof import('../repo/git-push.js')>();
  return {
    ...actual,
    detectOrigin: async (dir: string) =>
      (await actual.gitRun(dir, ['remote', 'get-url', 'origin'])).code === 0,
    originGitRun: async (dir: string, args: string[]) => {
      // The production runner forbids file transports. Only this fixture may talk to its local
      // bare remote; retain git's real exit status, including ls-remote's absent-branch code 2.
      try {
        return { ...(await exec('git', args, { cwd: dir, env })), code: 0 };
      } catch (error) {
        const result = error as { code?: number; stdout?: string; stderr?: string };
        return {
          code: result.code ?? -1,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        };
      }
    },
  };
});

const exec = promisify(execFile);
const dirs: string[] = [];
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@test.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@test.local',
};
const git = async (dir: string, ...args: string[]) =>
  (await exec('git', args, { cwd: dir, env })).stdout.trim();
beforeEach(() => {
  Object.assign(h, { holder: false, root: true, holding: 0, synced: true });
  h.sync.mockClear();
  h.release.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'e3-undo-'));
  dirs.push(root);
  const dir = path.join(root, 'repo');
  await mkdir(dir);
  await git(dir, 'init', '-b', 'main');
  await writeFile(path.join(dir, 'base'), 'base');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'base');
  const before = await git(dir, 'rev-parse', 'HEAD');
  await git(dir, 'switch', '-c', 'feature');
  await writeFile(path.join(dir, 'feature'), 'feature');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'feature');
  const feature = await git(dir, 'rev-parse', 'HEAD');
  await git(dir, 'switch', 'main');
  await git(dir, 'merge', '--no-ff', 'feature', '-m', 'merge');
  const after = await git(dir, 'rev-parse', 'HEAD');
  const payload = {
    repoPath: dir,
    dir,
    landedOn: 'main',
    baseShaBefore: before,
    baseShaAfter: after,
    landedAt: new Date().toISOString(),
    featureBranch: 'feature',
    featureSha: feature,
    mergeStage: 'feature',
  };
  const events: { eventType: string; payload: Record<string, unknown> }[] = [
    { eventType: 'merge.landed', payload },
    { eventType: 'merge.left_committed', payload },
  ];
  const db = {
    query: {
      taskSteps: { findFirst: async () => null },
      tasks: { findFirst: async () => ({ status: 'cancelled', userId: 'u', repositoryId: 'r' }) },
      repositories: { findFirst: async () => ({ storagePath: dir, localPath: null }) },
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          table === schema.mergeDirClaims
            ? { for: async () => [{ taskId: 'other' }] }
            : { orderBy: async () => events },
      }),
    }),
    insert: () => ({
      values: async (event: (typeof events)[number]) => {
        events.push(event);
      },
    }),
  } as unknown as Database;
  const job = { taskId: 't', userId: 'u', dir, baseShaAfter: after };
  const run = () =>
    (
      subject as unknown as { undoLeftMerge: (db: Database, payload: typeof job) => Promise<void> }
    ).undoLeftMerge(db, job);
  const settled = () => events.filter((e) => e.eventType === 'merge.left_committed_settled');
  return { root, dir, before, after, feature, payload, events, db, job, run, settled };
}

describe('explicit undo of a cancel-left committed merge', () => {
  it('settles a redirected merge directory as refused without following the link', async () => {
    const f = await fixture();
    await symlink('/etc', path.join(f.dir, 'redirect'));
    f.payload.dir = path.join(f.dir, 'redirect', 'inside');
    f.job.dir = f.payload.dir;
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(f.settled()[0]?.payload.outcome).toBe('refused');
  });
  it('refuses a known pushed report even if origin was removed afterwards', async () => {
    const f = await fixture();
    Object.assign(f.payload, { pushed: true });
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(f.settled()[0]?.payload.outcome).toBe('refused');
  });
  it.each([true, false])(
    'undoes with checked-out base=%s and settles once on redelivery',
    async (checkedOut) => {
      const f = await fixture();
      if (!checkedOut) await git(f.dir, 'switch', 'feature');
      await f.run();
      await f.run();
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
      expect(f.settled()).toMatchObject([
        { payload: { dir: f.dir, baseShaAfter: f.after, outcome: 'undone' } },
      ]);
      expect(f.settled()).toHaveLength(1);
      expect(await git(f.dir, 'rev-parse', f.after)).toBe(f.after);
      expect(h.sync).toHaveBeenCalled();
    },
  );
  it('does not drop another commit appended since landing', async () => {
    const f = await fixture();
    await git(f.dir, 'commit', '--allow-empty', '-m', 'other');
    const tip = await git(f.dir, 'rev-parse', 'main');
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(tip);
    expect(f.settled()[0]?.payload.outcome).toBe('moved');
  });
  it('refuses a re-entry that reported a later tip as the landing itself', async () => {
    const f = await fixture();
    await git(f.dir, 'commit', '--allow-empty', '-m', 'other');
    f.payload.baseShaAfter = await git(f.dir, 'rev-parse', 'HEAD');
    f.job.baseShaAfter = f.payload.baseShaAfter;
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.payload.baseShaAfter);
    expect(f.settled()[0]?.payload.outcome).toBe('refused');
  });
  it('accepts only a squash with the original task merge parents and identical tree', async () => {
    const f = await fixture();
    await git(f.dir, 'reset', '--soft', f.before);
    await git(f.dir, 'commit', '-m', 'squash');
    f.payload.baseShaAfter = await git(f.dir, 'rev-parse', 'HEAD');
    f.job.baseShaAfter = f.payload.baseShaAfter;
    Object.assign(f.payload, { squashMergeSha: f.after });
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
    expect(f.settled()[0]?.payload.outcome).toBe('undone');
  });
  it('refuses a host checkout without changing git', async () => {
    const f = await fixture();
    vi.spyOn(gitMerge, 'isHostCheckout').mockReturnValue(true);
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(f.settled()[0]?.payload.outcome).toBe('refused');
  });
  it('refuses unknown remote state rather than assuming it was not pushed', async () => {
    const f = await fixture();
    vi.spyOn(gitPush, 'detectOrigin').mockRejectedValueOnce(new Error('unreadable'));
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(f.settled()[0]?.payload.outcome).toBe('refused');
  });
  it('refuses older events without immutable feature evidence', async () => {
    const f = await fixture();
    Object.assign(f.payload, { featureSha: undefined });
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(f.settled()[0]?.payload.outcome).toBe('refused');
  });
  it('refuses a base-sync landing that incorporates upstream commits', async () => {
    const f = await fixture();
    await git(f.dir, 'switch', '-c', 'upstream', f.before);
    await git(f.dir, 'commit', '--allow-empty', '-m', 'upstream');
    await git(f.dir, 'switch', 'main');
    await git(f.dir, 'merge', '--no-ff', 'upstream', '-m', 'sync');
    f.payload.baseShaAfter = await git(f.dir, 'rev-parse', 'HEAD');
    f.payload.mergeStage = 'base-sync';
    f.job.baseShaAfter = f.payload.baseShaAfter;
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.payload.baseShaAfter);
    expect(f.settled()[0]?.payload.outcome).toBe('refused');
  });
  it.each(['holder', 'root', 'holding'])('refuses a live %s', async (kind) => {
    const f = await fixture();
    if (kind === 'holder') h.holder = true;
    else if (kind === 'root') h.root = false;
    else h.holding = 1;
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(f.settled()[0]?.payload.outcome).toBe('refused');
  });
  it('keeps conflicting local changes and the index untouched', async () => {
    const f = await fixture();
    await writeFile(path.join(f.dir, 'feature'), 'local edit');
    const status = await git(f.dir, 'status', '--porcelain');
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(await git(f.dir, 'status', '--porcelain')).toBe(status);
    expect(await readFile(path.join(f.dir, 'feature'), 'utf8')).toBe('local edit');
    expect(f.settled()[0]?.payload.outcome).toBe('refused');
  });
  it('refuses a pushed merge even if the tracking ref is stale', async () => {
    const f = await fixture();
    const remote = path.join(f.root, 'remote.git');
    await mkdir(remote);
    await git(remote, 'init', '--bare');
    await git(f.dir, 'remote', 'add', 'origin', remote);
    await git(f.dir, 'push', 'origin', 'main');
    await git(f.dir, 'update-ref', 'refs/remotes/origin/main', f.before);
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(f.settled()[0]?.payload).toMatchObject({
      outcome: 'refused',
      reason: expect.stringContaining('contains this merge'),
    });
  });
  it('allows an origin whose base branch does not exist yet', async () => {
    const f = await fixture();
    const remote = path.join(f.root, 'empty.git');
    await mkdir(remote);
    await git(remote, 'init', '--bare');
    await git(f.dir, 'remote', 'add', 'origin', remote);
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
    expect(f.settled()[0]?.payload.outcome).toBe('undone');
  });
  it('serializes concurrent clicks into one settled event', async () => {
    const f = await fixture();
    await Promise.all([f.run(), f.run()]);
    expect(f.settled()).toHaveLength(1);
    expect(f.settled()[0]?.payload.outcome).toBe('undone');
  });
  it.each([true, false])('recreates a deleted feature branch, existing=%s', async (existing) => {
    const f = await fixture();
    if (!existing) await git(f.dir, 'branch', '-D', 'feature');
    else await git(f.dir, 'update-ref', 'refs/heads/feature', f.before);
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'feature')).toBe(existing ? f.before : f.feature);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
  });
  it('recovers a git move whose audit transaction failed, without a second reset', async () => {
    const f = await fixture();
    await git(f.dir, 'update-ref', `refs/haive/undo-left-merge/t/${f.after}`, f.after);
    await git(f.dir, 'reset', '--keep', f.before);
    await git(f.dir, 'branch', '-D', 'feature');
    await f.run();
    await f.run();
    expect(f.settled()).toHaveLength(1);
    expect(f.settled()[0]?.payload.outcome).toBe('moved');
    expect(await git(f.dir, 'rev-parse', 'feature')).toBe(f.feature);
    expect(h.sync).toHaveBeenCalled();
  });
  it('retries projection recovery without resetting or settling again', async () => {
    const f = await fixture();
    h.synced = false;
    await expect(f.run()).rejects.toThrow(/re-sync/);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
    h.synced = true;
    await f.run();
    expect(f.settled()).toHaveLength(1);
  });
});

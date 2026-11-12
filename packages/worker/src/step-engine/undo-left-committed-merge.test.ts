import { execFile } from 'node:child_process';
import * as processes from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { undoLeftMerge, recordUndoFailure } from './undo-left-merge.js';
import { leftCommittedMerges } from '@haive/shared/merge-left-open';
import { worktreeDirPaths, worktreeDirName } from '../repo/worktree-paths.js';
import * as gitMerge from './git-merge.js';
import * as gitPush from '../repo/git-push.js';
import * as gitWorkspace from '../repo/git-workspace.js';
import * as gitExec from '../repo/git-exec.js';

const h = vi.hoisted(() => ({
  holder: false,
  root: true,
  claimError: null as Error | null,
  liveClaimError: null as Error | null,
  holding: 0,
  synced: true,
  sync: vi.fn(),
  release: vi.fn(),
  duringPrep: null as null | (() => Promise<void>),
  aside: vi.fn(async () => ({ outcome: 'clean' })),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('@haive/database', async (original) => ({
  ...(await original<object>()),
  acquireRootClaim: async () => {
    if (h.claimError) throw h.claimError;
    return h.root ? { release: h.release, lost: () => false } : null;
  },
  lockRepositoryTasksKey: async () => undefined,
}));
let tail = Promise.resolve();
vi.mock('./merge-dir-claim.js', () => ({
  liveClaimHolder: async () => {
    if (h.liveClaimError) throw h.liveClaimError;
    return h.holder ? { id: 'other', title: 'Other' } : null;
  },
  otherLiveClaim: async () => (h.holder ? { id: 'other', title: 'Other' } : null),
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
  setAsideHaiveProjections: h.aside,
  restoreProjectionsInTx: async () => {
    await h.duringPrep?.();
    return { outcome: 'clean' };
  },
  putBackProjections: async () => undefined,
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
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(processes.spawn).mockImplementation(actual.spawn);
  Object.assign(h, {
    holder: false,
    root: true,
    holding: 0,
    synced: true,
    duringPrep: null,
    claimError: null,
    liveClaimError: null,
  });
  h.sync.mockClear();
  h.release.mockClear();
  h.aside.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(changeBase = false) {
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
  if (changeBase) await writeFile(path.join(dir, 'base'), 'merged base');
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
    { eventType: 'task.cancel_finished', payload: {} },
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
  const run = () => undoLeftMerge(db, job);
  const settled = () => events.filter((e) => e.eventType === 'merge.left_committed_settled');
  return { root, dir, before, after, feature, payload, events, db, job, run, settled };
}

describe('explicit undo of a cancel-left committed merge', () => {
  it.each(['root', 'transient'] as const)(
    'refuses an empty open merge in the %s checkout and permits retry after abort',
    async (kind) => {
      const f = await fixture();
      let checkout = f.dir;
      if (kind === 'transient') {
        await git(f.dir, 'switch', 'feature');
        checkout = worktreeDirPaths(f.dir, '', `${worktreeDirName('main')}--base`).worktreePath;
        await git(f.dir, 'worktree', 'add', checkout, 'main');
        f.payload.dir = checkout;
        f.job.dir = checkout;
      }
      await git(checkout, 'switch', '-c', 'empty-divergent', f.before);
      await git(checkout, 'commit', '--allow-empty', '-m', 'empty divergent commit');
      await git(checkout, 'switch', 'main');
      await git(checkout, 'merge', '--no-ff', '--no-commit', 'empty-divergent');
      expect(await git(checkout, 'diff', '--cached', '--name-only')).toBe('');
      const mergeHead = await git(checkout, 'rev-parse', 'MERGE_HEAD');
      await f.run();
      expect(await git(checkout, 'rev-parse', 'main')).toBe(f.after);
      expect(await git(checkout, 'rev-parse', 'MERGE_HEAD')).toBe(mergeHead);
      expect(leftCommittedMerges(f.events)[0]).toMatchObject({
        settled: null,
        refused: { reason: expect.stringMatching(/operation.*in progress/i) },
      });
      expect(h.aside).not.toHaveBeenCalled();
      await git(checkout, 'merge', '--abort');
      await f.run();
      expect(await git(checkout, 'rev-parse', 'main')).toBe(f.before);
    },
  );

  async function interruptAfterCheckoutMove(f: Awaited<ReturnType<typeof fixture>>) {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let interrupted = false;
    vi.mocked(processes.spawn).mockImplementation((...args: Parameters<typeof processes.spawn>) => {
      const child = actual.spawn(...args);
      if ((args[1] as string[]).includes('--stdin')) {
        const write = child.stdin!.write.bind(child.stdin);
        vi.spyOn(child.stdin!, 'write').mockImplementation((chunk, ...rest) => {
          if (chunk === 'commit\n' && !interrupted) {
            interrupted = true;
            // EOF/abort after read-tree, before the ref commit, leaves the same real git state.
            return write('abort\n', ...rest);
          }
          return write(chunk, ...rest);
        });
      }
      return child;
    });
    await f.run();
    expect(interrupted).toBe(true);
    expect(await git(f.dir, 'rev-parse', 'HEAD')).toBe(f.after);
    expect(await git(f.dir, 'write-tree')).toBe(
      await git(f.dir, 'rev-parse', `${f.before}^{tree}`),
    );
    expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
    vi.mocked(processes.spawn).mockImplementation(actual.spawn);
  }

  it('finishes an interrupted checkout move on redelivery without rewriting local bytes', async () => {
    const f = await fixture();
    await interruptAfterCheckoutMove(f);
    await writeFile(path.join(f.dir, 'base'), 'unrelated local edit');
    const actual = gitPush.gitRun;
    const calls = vi.spyOn(gitPush, 'gitRun').mockImplementation(actual);
    h.aside.mockClear();
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
    expect(await readFile(path.join(f.dir, 'base'), 'utf8')).toBe('unrelated local edit');
    expect(await git(f.dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(leftCommittedMerges(f.events)[0]?.settled?.outcome).toBe('undone');
    expect(calls.mock.calls.some(([, args]) => args[0] === 'read-tree')).toBe(false);
    expect(h.aside).not.toHaveBeenCalled();
  });

  it('refuses unrelated staged work after an interrupted checkout move', async () => {
    const f = await fixture();
    await interruptAfterCheckoutMove(f);
    await writeFile(path.join(f.dir, 'base'), 'person staged this');
    await git(f.dir, 'add', 'base');
    const index = await git(f.dir, 'write-tree');
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(await git(f.dir, 'write-tree')).toBe(index);
    expect(await readFile(path.join(f.dir, 'base'), 'utf8')).toBe('person staged this');
    expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
  });

  it('refuses new bytes on a path removed by an interrupted checkout move', async () => {
    const f = await fixture();
    await interruptAfterCheckoutMove(f);
    await writeFile(path.join(f.dir, 'feature'), 'person recreated this');
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(await readFile(path.join(f.dir, 'feature'), 'utf8')).toBe('person recreated this');
    expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
  });

  it('refuses unstaged edits on a tracked path touched by an interrupted checkout move', async () => {
    const f = await fixture(true);
    await interruptAfterCheckoutMove(f);
    await writeFile(path.join(f.dir, 'base'), 'person edited the restored base');
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(await readFile(path.join(f.dir, 'base'), 'utf8')).toBe(
      'person edited the restored base',
    );
    expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
  });

  it('rechecks the interrupted index while the ref lock is held', async () => {
    const f = await fixture();
    await interruptAfterCheckoutMove(f);
    const actual = gitWorkspace.worktreesHoldingBranch;
    let reads = 0;
    vi.spyOn(gitWorkspace, 'worktreesHoldingBranch').mockImplementation(async (...args) => {
      const holders = await actual(...args);
      if (++reads === 2) {
        await writeFile(path.join(f.dir, 'base'), 'staged during prepare');
        await git(f.dir, 'add', 'base');
      }
      return holders;
    });
    await f.run();
    expect(reads).toBe(2);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(await git(f.dir, 'show', ':base')).toBe('staged during prepare');
    expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
  });

  it('refuses a pre-merge staged tree without evidence of an admitted Undo', async () => {
    const f = await fixture();
    await git(f.dir, 'read-tree', '-m', '-u', f.after, f.before);
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
  });

  it('refuses Undo before cancellation teardown finishes', async () => {
    const f = await fixture();
    f.events.splice(0, 1);
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
    f.events.push({ eventType: 'task.cancel_finished', payload: {} });
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
  });
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
  it('keeps a commit landing after the final HEAD check and before the move', async () => {
    const f = await fixture();
    const actual = gitPush.gitRun;
    let tip = '';
    vi.spyOn(gitPush, 'gitRun').mockImplementation(async (dir, args, ...rest) => {
      const result = await actual(dir, args, ...rest);
      if (args[0] === 'diff' && args.includes('--cached') && result.code === 0) {
        await git(f.dir, 'commit', '--allow-empty', '-m', 'person after HEAD check');
        tip = await git(f.dir, 'rev-parse', 'main');
      }
      return result;
    });
    await f.run();
    expect(tip).not.toBe('');
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(tip);
    expect(await git(f.dir, 'rev-parse', `${tip}^`)).toBe(f.after);
    expect(leftCommittedMerges(f.events)[0]).toMatchObject({
      settled: null,
      refused: { count: 1 },
    });
    expect(h.sync).not.toHaveBeenCalled();
  });
  it('holds the branch lock while moving the checkout and releases it afterwards', async () => {
    const f = await fixture();
    const actual = gitPush.gitRun;
    let tried = false;
    vi.spyOn(gitPush, 'gitRun').mockImplementation(async (dir, args, ...rest) => {
      if (args[0] === 'read-tree') {
        tried = true;
        await expect(
          git(f.dir, 'commit', '--allow-empty', '-m', 'competing commit'),
        ).rejects.toThrow();
        expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
      }
      return actual(dir, args, ...rest);
    });
    await f.run();
    expect(tried).toBe(true);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
    expect(await git(f.dir, 'status', '--porcelain')).toBe('');
    await git(f.dir, 'commit', '--allow-empty', '-m', 'lock released');
  });
  it.each(['git version 2.26.3', 'unrecognized version'])(
    'does not use the git version banner %s to decide transaction support',
    async (stdout) => {
      const f = await fixture();
      const actual = gitPush.gitRun;
      vi.spyOn(gitPush, 'gitRun').mockImplementation(async (dir, args, ...rest) =>
        args[0] === '--version' ? { code: 0, stdout, stderr: '' } : actual(dir, args, ...rest),
      );
      await f.run();
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
      expect(leftCommittedMerges(f.events)[0]?.settled?.outcome).toBe('undone');
    },
  );
  it.each(['fatal: unknown command', 'Fehler: unbekannter Befehl'])(
    'refuses unsupported ref transactions before set-aside regardless of stderr: %s',
    async (stderr) => {
      const f = await fixture();
      const actual =
        await vi.importActual<typeof import('node:child_process')>('node:child_process');
      vi.spyOn(processes, 'spawn').mockImplementation(
        (...args: Parameters<typeof processes.spawn>) => {
          if (!(args[1] as string[]).includes('--stdin')) return actual.spawn(...args);
          const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            exitCode: null,
            signalCode: null,
            kill: vi.fn(),
          });
          child.stdin.once('data', () => {
            child.stderr.write(stderr);
            child.stdout.end();
            child.emit('close', 128);
          });
          return child as unknown as ReturnType<typeof processes.spawn>;
        },
      );
      const actualGit = gitPush.gitRun;
      const calls = vi.spyOn(gitPush, 'gitRun').mockImplementation(actualGit);
      await f.run();
      expect(leftCommittedMerges(f.events)[0]).toMatchObject({
        settled: null,
        refused: { count: 1, reason: expect.stringContaining('requires Git 2.27 or newer') },
      });
      expect(h.aside).not.toHaveBeenCalled();
      expect(
        calls.mock.calls.some(([, args]) =>
          ['--version', 'update-index', 'read-tree'].includes(args[0]!),
        ),
      ).toBe(false);
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
      expect(await readFile(path.join(f.dir, 'feature'), 'utf8')).toBe('feature');
    },
  );
  it.each(['unrelated edit', 'unrelated deletion', 'untracked file'])(
    'keeps reset --keep local behaviour for %s',
    async (kind) => {
      const f = await fixture();
      if (kind === 'unrelated edit') await writeFile(path.join(f.dir, 'base'), 'mine');
      if (kind === 'unrelated deletion') await rm(path.join(f.dir, 'base'));
      if (kind === 'untracked file') {
        await writeFile(path.join(f.dir, 'untracked'), 'mine');
      }
      const status = await git(f.dir, 'status', '--porcelain');
      await f.run();
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
      expect(await git(f.dir, 'status', '--porcelain')).toBe(status);
      await git(f.dir, 'commit', '--allow-empty', '-m', 'lock released');
    },
  );
  it('never drops a commit made in the checkout while Undo prepares', async () => {
    const f = await fixture();
    h.duringPrep = async () => {
      await writeFile(path.join(f.dir, 'person.txt'), 'mine');
      await git(f.dir, 'add', 'person.txt');
      await git(f.dir, 'commit', '-m', 'person');
    };
    const mine = async () => git(f.dir, 'rev-parse', 'main');
    await f.run();
    const tip = await mine();
    expect(tip).not.toBe(f.before);
    expect(tip).not.toBe(f.after);
    expect(await git(f.dir, 'rev-parse', `${tip}^`)).toBe(f.after);
    expect(f.settled()[0]?.payload.outcome).toBe('moved');
  });
  it.each(['other', '--detach'])(
    'never resets a checkout switched to %s at the same commit while Undo prepares',
    async (target) => {
      const f = await fixture();
      await git(f.dir, 'branch', 'other');
      h.duringPrep = async () => {
        await git(f.dir, 'switch', target);
      };
      await f.run();
      expect(await git(f.dir, 'rev-parse', 'HEAD')).toBe(f.after);
      expect(await git(f.dir, 'rev-parse', 'other')).toBe(f.after);
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
      expect(f.settled()[0]?.payload.outcome).toBe('refused');
      expect(leftCommittedMerges(f.events)[0]).toMatchObject({
        settled: null,
        refused: { count: 1, reason: expect.stringMatching(/checkout.*branch/i) },
      });
      expect(h.sync).not.toHaveBeenCalled();
      const reason = leftCommittedMerges(f.events)[0]?.refused?.reason;
      expect(reason).not.toContain('Switch it back');
      expect(reason).toContain('Retry Undo');
      h.duringPrep = null;
      await f.run();
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
      expect(await git(f.dir, 'rev-parse', 'HEAD')).toBe(f.after);
      expect(leftCommittedMerges(f.events)[0]?.settled?.outcome).toBe('undone');
    },
  );
  it.each(['personal', 'unrecorded-base'])(
    'refuses a base checked out in another %s worktree without changing its index',
    async (kind) => {
      const f = await fixture();
      await git(f.dir, 'switch', 'feature');
      const linked =
        kind === 'personal'
          ? path.join(f.root, 'personal tree')
          : worktreeDirPaths(f.dir, '', `${worktreeDirName('main')}--base`).worktreePath;
      await git(f.dir, 'worktree', 'add', linked, 'main');
      const status = await git(linked, 'status', '--porcelain');
      await f.run();
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
      expect(await git(linked, 'status', '--porcelain')).toBe(status);
      expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
      await git(f.dir, 'worktree', 'remove', linked);
      await f.run();
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
    },
  );
  it('refuses a worktree acquiring the branch after the first holder check', async () => {
    const f = await fixture();
    await git(f.dir, 'switch', 'feature');
    const linked = path.join(f.root, 'late checkout');
    const actual = gitWorkspace.worktreesHoldingBranch;
    let reads = 0;
    vi.spyOn(gitWorkspace, 'worktreesHoldingBranch').mockImplementation(async (...args) => {
      const holders = await actual(...args);
      if (++reads === 1) await git(f.dir, 'worktree', 'add', linked, 'main');
      if (reads === 2) {
        // The second list must run while the branch CAS lock is held.
        await expect(
          git(f.dir, 'update-ref', 'refs/heads/main', f.before, f.after),
        ).rejects.toThrow();
      }
      return holders;
    });
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(await git(linked, 'status', '--porcelain')).toBe('');
    expect(leftCommittedMerges(f.events)[0]).toMatchObject({
      settled: null,
      refused: { count: 1, reason: expect.stringMatching(/worktree/i) },
    });
    expect(reads).toBe(2);
    expect(h.sync).not.toHaveBeenCalled();
    await git(f.dir, 'worktree', 'remove', linked);
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
  });
  it('resets the recorded transient base worktree and leaves its index clean', async () => {
    const f = await fixture();
    await git(f.dir, 'switch', 'feature');
    const linked = worktreeDirPaths(f.dir, '', `${worktreeDirName('main')}--base`).worktreePath;
    await git(f.dir, 'worktree', 'add', linked, 'main');
    f.payload.dir = linked;
    f.job.dir = linked;
    await f.run();
    expect(await git(linked, 'rev-parse', 'HEAD')).toBe(f.before);
    expect(await git(linked, 'status', '--porcelain')).toBe('');
    expect(await readFile(path.join(f.dir, 'feature'), 'utf8')).toBe('feature');
    expect(f.settled()[0]?.payload.outcome).toBe('undone');
  });
  it('refuses a staged submodule pointer that a configured ignore would hide', async () => {
    const f = await fixture();
    await git(f.dir, 'config', 'diff.ignoreSubmodules', 'all');
    await git(f.dir, 'update-index', '--add', '--cacheinfo', `160000,${f.before},vendored`);
    const staged = await git(f.dir, 'ls-files', '--stage', '--', 'vendored');

    await f.run();

    expect(await git(f.dir, 'ls-files', '--stage', '--', 'vendored')).toBe(staged);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(f.settled()[0]?.payload).toMatchObject({
      outcome: 'refused',
      reason: expect.stringMatching(/commit or unstage/i),
    });
  });
  it.each(['repository', 'transient base'])(
    'refuses partially staged unrelated work in the %s checkout and allows retry after unstaging',
    async (kind) => {
      const f = await fixture();
      let checkout = f.dir;
      if (kind === 'transient base') {
        await git(f.dir, 'switch', 'feature');
        checkout = worktreeDirPaths(f.dir, '', `${worktreeDirName('main')}--base`).worktreePath;
        await git(f.dir, 'worktree', 'add', checkout, 'main');
        f.payload.dir = checkout;
        f.job.dir = checkout;
      }
      await writeFile(path.join(checkout, 'base'), 'staged version\n');
      await git(checkout, 'add', 'base');
      const staged = await git(checkout, 'ls-files', '--stage', '--', 'base');
      await writeFile(path.join(checkout, 'base'), 'working version\n');
      const working = await readFile(path.join(checkout, 'base'));

      await f.run();

      expect.soft(await git(checkout, 'ls-files', '--stage', '--', 'base')).toBe(staged);
      expect.soft(await readFile(path.join(checkout, 'base'))).toEqual(working);
      expect.soft(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
      expect.soft(f.settled()[0]?.payload).toMatchObject({
        outcome: 'refused',
        reason: expect.stringMatching(/commit or unstage/i),
      });
      expect.soft(leftCommittedMerges(f.events)[0]).toMatchObject({
        settled: null,
        refused: { count: 1 },
      });
      expect.soft(h.sync).not.toHaveBeenCalled();

      await git(checkout, 'reset', '--', 'base');
      await f.run();
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
      expect(await readFile(path.join(checkout, 'base'))).toEqual(working);
      expect(leftCommittedMerges(f.events)[0]?.settled?.outcome).toBe('undone');
    },
  );
  it.each([128, 124, -1])(
    'records an index diff failure with exit %s as retryable without resetting',
    async (code) => {
      const f = await fixture();
      const actual = gitPush.gitRun;
      vi.spyOn(gitPush, 'gitRun').mockImplementation(async (dir, args, ...rest) =>
        args[0] === 'diff' && args.includes('--cached')
          ? { code, stdout: '', stderr: 'cannot read index' }
          : actual(dir, args, ...rest),
      );

      await expect(f.run()).resolves.toBeUndefined();

      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
      expect(leftCommittedMerges(f.events)[0]).toMatchObject({
        settled: null,
        refused: { count: 1, reason: expect.stringMatching(/could not read.*index/i) },
      });
      expect(h.sync).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      await f.run();
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
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
    expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
  });
  it('keeps remote failure detail while removing paths and URL credentials', async () => {
    const f = await fixture();
    await git(f.dir, 'remote', 'add', 'origin', 'https://example.test/repo.git');
    vi.spyOn(gitPush, 'originGitRun').mockResolvedValue({
      code: 128,
      stdout: '',
      stderr: `fatal: connection refused for https://user:private-token@example.test/repo.git in ${f.dir}`,
    });
    await f.run();
    const reason = leftCommittedMerges(f.events)[0]?.refused?.reason;
    expect(reason).toContain('connection refused');
    expect(reason).not.toContain('.:');
    expect(reason).toContain('[path]');
    expect(reason).not.toContain(f.dir);
    expect(reason).not.toContain('private-token');
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
  });
  it.each(['list', 'fetch', 'throw'])(
    'scrubs a standalone credential echoed by the remote during %s',
    async (failure) => {
      const f = await fixture();
      const token = 'standalone-private-credential';
      await git(f.dir, 'remote', 'add', 'origin', 'https://example.test/repo.git');
      vi.spyOn(f.db.query.taskSteps, 'findFirst').mockResolvedValue({
        formValues: { credentialId: 'credential' },
      } as never);
      vi.spyOn(gitPush, 'buildCredentialHelper').mockResolvedValue({
        argv: [],
        env: {},
        secret: token,
      });
      vi.spyOn(gitPush, 'originGitRun').mockImplementation(async (_dir, args) => {
        if (failure === 'throw') throw new Error(`remote echoed ${token}`);
        if (failure === 'fetch' && args.includes('ls-remote'))
          return { code: 0, stdout: `${f.after}\trefs/heads/main\n`, stderr: '' };
        return { code: 128, stdout: '', stderr: `remote echoed ${token}` };
      });
      await f.run();
      const reason = leftCommittedMerges(f.events)[0]?.refused?.reason;
      expect(reason).toContain('remote echoed ***');
      expect(reason).not.toContain(token);
      expect(JSON.stringify(f.settled())).not.toContain(token);
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    },
  );
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
    expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
    Object.assign(h, { holder: false, root: true, holding: 0 });
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
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
    expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
    await git(f.dir, 'restore', 'feature');
    await f.run();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
  });
  it.each(['url', 'pushurl'])(
    'refuses multiple origin %s destinations when only the second contains the merge',
    async (key) => {
      const f = await fixture();
      const remotes = [path.join(f.root, 'first.git'), path.join(f.root, 'second.git')];
      for (const remote of remotes) {
        await mkdir(remote);
        await git(remote, 'init', '--bare');
      }
      await git(f.dir, 'remote', 'add', 'origin', remotes[0]!);
      if (key === 'pushurl')
        await git(f.dir, 'config', '--add', 'remote.origin.pushurl', remotes[0]!);
      await git(f.dir, 'config', '--add', `remote.origin.${key}`, remotes[1]!);
      await git(f.dir, 'push', remotes[1]!, 'main');
      expect(await git(remotes[0]!, 'for-each-ref', 'refs/heads/main')).toBe('');
      expect(await git(remotes[1]!, 'rev-parse', 'main')).toBe(f.after);

      await f.run();
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
      expect(f.settled()[0]?.payload).toMatchObject({ outcome: 'refused' });
      expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
      expect(h.sync).not.toHaveBeenCalled();

      // A person can clear the configuration refusal; the remaining destination is checked.
      await git(f.dir, 'config', '--unset-all', `remote.origin.${key}`);
      await git(f.dir, 'config', '--replace-all', 'remote.origin.url', remotes[1]!);
      await f.run();
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
      expect(leftCommittedMerges(f.events)[0]?.settled?.outcome).toBe('refused');
      expect(f.settled()[1]?.payload.permanent).toBe(true);
    },
  );
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
  it('keeps an exhausted failed job retryable and fails if its audit cannot be written', async () => {
    const f = await fixture();
    await recordUndoFailure(f.db, f.job, new Error('failed operation'));
    expect(leftCommittedMerges(f.events)[0]).toMatchObject({
      settled: null,
      refused: { count: 1 },
    });
    vi.spyOn(f.db, 'insert').mockImplementationOnce(
      () =>
        ({
          values: async () => {
            throw new Error('audit failed');
          },
        }) as never,
    );
    await expect(recordUndoFailure(f.db, f.job, new Error('failure'))).rejects.toThrow(
      'audit failed',
    );
  });
  it.each([1, 3])(
    'keeps bounded path-free detail when worktree-list read %s fails',
    async (failedRead) => {
      const f = await fixture();
      const actual = gitExec.gitRun;
      let reads = 0;
      vi.spyOn(gitExec, 'gitRun').mockImplementation(async (dir, args, ...rest) =>
        args[0] === 'worktree' && args[1] === 'list' && ++reads === failedRead
          ? {
              code: 128,
              stdout: '',
              stderr: `fatal: permission denied in ${f.dir}/.git/worktrees; ${'detail '.repeat(200)}`,
            }
          : actual(dir, args, ...rest),
      );
      await expect(f.run()).resolves.toBeUndefined();
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
      const reason = leftCommittedMerges(f.events)[0]?.refused?.reason;
      expect(reason).toContain('permission denied');
      expect(reason).toContain('[path]');
      expect(reason).not.toContain(f.dir);
      expect(reason).not.toContain('Git refused the undo');
      expect(reason!.length).toBeLessThan(650);
      expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
      expect(h.sync).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      await f.run();
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
    },
  );
  it('keeps the git refusal detail when conflicting local bytes prevent the move', async () => {
    const f = await fixture();
    await writeFile(path.join(f.dir, 'feature'), 'mine');
    await f.run();
    const reason = leftCommittedMerges(f.events)[0]?.refused?.reason;
    // Git's detail may be translated; require a nonempty excerpt after our own refusal copy.
    expect(reason).toMatch(
      /^Git refused the undo; local changes or a changed branch were kept: \S/,
    );
    expect(reason).not.toContain(f.dir);
    expect(await readFile(path.join(f.dir, 'feature'), 'utf8')).toBe('mine');
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
  });
  it('propagates a settlement database failure inside the prepared transaction for queue retry', async () => {
    const f = await fixture();
    const failure = new Error('audit database unavailable');
    await writeFile(path.join(f.dir, 'feature'), 'mine');
    vi.spyOn(f.db, 'insert').mockImplementationOnce(
      () =>
        ({
          values: async () => {
            throw failure;
          },
        }) as never,
    );
    await expect(f.run()).rejects.toBe(failure);
    expect(f.settled()).toHaveLength(0);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    expect(await readFile(path.join(f.dir, 'feature'), 'utf8')).toBe('mine');
    await git(f.dir, 'commit', '--allow-empty', '-m', 'lock released');
  });
  it('records a git read failure as a retryable attempt immediately', async () => {
    const f = await fixture();
    const actual = gitPush.gitRun;
    vi.spyOn(gitPush, 'gitRun').mockImplementation(async (dir, args, ...rest) =>
      args[0] === 'rev-list'
        ? { code: 128, stdout: '', stderr: 'fatal: unreadable object' }
        : actual(dir, args, ...rest),
    );
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.settled()[0]?.payload.outcome).toBe('refused');
    expect(leftCommittedMerges(f.events)[0]?.refused?.reason).toContain('unreadable object');
    expect(leftCommittedMerges(f.events)[0]?.settled).toBeNull();
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    vi.restoreAllMocks();
    await f.run();
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
    expect(f.settled()[0]?.payload.outcome).toBe('undone');
    expect(await git(f.dir, 'rev-parse', 'feature')).toBe(f.feature);
    expect(h.sync).toHaveBeenCalled();
  });
  it.each(['holder', 'root', 'holding', 'claim-error', 'holder-error'])(
    'leaves redelivered Undo recovery pending behind a live %s fence',
    async (kind) => {
      const f = await fixture();
      h.synced = false;
      await expect(f.run()).rejects.toThrow(/re-sync/);
      expect(f.settled()[0]?.payload.outcome).toBe('undone');
      await git(f.dir, 'branch', '-D', 'feature');
      h.synced = true;
      h.sync.mockClear();
      h.release.mockClear();
      if (kind === 'holder') h.holder = true;
      else if (kind === 'root') h.root = false;
      else if (kind === 'holding') h.holding = 1;
      else if (kind === 'claim-error') h.claimError = new Error('root claim failed');
      else h.liveClaimError = new Error('live claim failed');

      await expect(f.run()).rejects.toThrow(/pending|claim failed/);
      expect(h.sync).not.toHaveBeenCalled();
      expect(await git(f.dir, 'branch', '--list', 'feature')).toBe('');
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
      expect(f.settled()).toHaveLength(1);
      expect(leftCommittedMerges(f.events)[0]?.settled?.outcome).toBe('undone');
      expect(h.release).toHaveBeenCalledTimes(kind === 'holding' ? 1 : 0);

      Object.assign(h, {
        holder: false,
        root: true,
        holding: 0,
        synced: true,
        claimError: null,
        liveClaimError: null,
      });
      await f.run();
      expect(h.sync).toHaveBeenCalledTimes(1);
      expect(await git(f.dir, 'rev-parse', 'feature')).toBe(f.feature);
      expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.before);
      expect(f.settled()).toHaveLength(1);
    },
  );
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

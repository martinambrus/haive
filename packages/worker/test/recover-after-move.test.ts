import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { gitTimeoutLimits } from '../src/repo/git-exec.js';
import { failGit, noGit, type FakeGit } from './support/fake-git.js';

const h = vi.hoisted(() => ({ resynced: 0 }));
vi.mock('../src/project-state/sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/project-state/sync.js')>()),
  syncProjectStateFromCheckout: async () => {
    h.resynced += 1;
    return { outcome: 'unchanged' };
  },
}));
vi.mock('../src/project-state/refresh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/project-state/refresh.js')>()),
  refreshProjectState: async () => true,
}));
vi.mock('../src/plan/sync-checkout.js', () => ({ syncPlanFromCheckout: async () => undefined }));
vi.mock('../src/plan/mirror.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/plan/mirror.js')>()),
  flushPlanMirrorForRepository: async () => ({ files: [], repoPath: '/repo' }),
}));

const { recoverAfterMoveFailure } = await import('../src/project-state/set-aside.js');
type KeptFiles = Parameters<typeof recoverAfterMoveFailure>[3];

const PLAN = '.haive-data/plan.json';
const OLD = 'OLD-HEAD-PLAN\n';
const INCOMING = 'INCOMING-PLAN-FROM-OTHER-INSTALL\n';
const PENDING = 'PENDING-LOCAL-PLAN\n';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** Stands in for the move's transaction: the put-back only needs a handle to take its locks on. */
const section = ((fn: (tx: unknown) => Promise<unknown>) =>
  fn({ execute: async () => undefined })) as never;
const db = {} as unknown as Database;

const dirs: string[] = [];
let shim: FakeGit | null = null;
const savedShort = gitTimeoutLimits.short;

beforeEach(() => {
  h.resynced = 0;
});
afterEach(async () => {
  await shim?.restore();
  shim = null;
  gitTimeoutLimits.short = savedShort;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A checkout whose plan.json is set aside at HEAD's bytes, with the local bytes kept for the put-back. */
async function setAside() {
  const dir = await mkdtemp(path.join(tmpdir(), 'recover-after-move-'));
  dirs.push(dir);
  await mkdir(path.join(dir, '.haive-data'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'gc.auto', '0');
  await writeFile(path.join(dir, PLAN), OLD);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'old');
  const before = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'incoming');
  await writeFile(path.join(dir, PLAN), INCOMING);
  git(dir, 'commit', '-q', '-am', 'incoming');
  git(dir, 'checkout', '-q', 'main');
  const index = git(dir, 'ls-files', '-s', '--', PLAN).replace(/^(\d+) ([0-9a-f]+) 0\t.*/, '$1 $2');
  const kept: KeptFiles = new Map([
    [
      PLAN,
      {
        bytes: Buffer.from(PENDING),
        index,
        mode: 0o644,
        owner: { uid: process.getuid!(), gid: process.getgid!() },
        untracked: false,
      },
    ],
  ]);
  return { dir, before, kept, land: () => git(dir, 'merge', '-q', '--ff-only', 'incoming') };
}

/** What the caller sees: the error it passed in, and the one recovery threw. */
async function recover(dir: string, kept: KeptFiles, before: string) {
  const err = new Error('the move threw');
  const thrown = await recoverAfterMoveFailure(db, 'repo-1', dir, kept, before, err, section).then(
    () => null,
    (e: unknown) => e,
  );
  return { err, thrown };
}

const onDisk = (dir: string) => readFile(path.join(dir, PLAN), 'utf8');

describe('recoverAfterMoveFailure reads HEAD to learn whether the move landed', () => {
  it('puts the bytes back while HEAD is still where the move started', async () => {
    const { dir, before, kept } = await setAside();
    const { err, thrown } = await recover(dir, kept, before);
    expect(await onDisk(dir)).toBe(PENDING);
    expect(h.resynced).toBe(0);
    expect(thrown).toBe(err);
  });

  it('re-syncs instead of putting the old bytes over a move that landed', async () => {
    const { dir, before, kept, land } = await setAside();
    land();
    const { err, thrown } = await recover(dir, kept, before);
    expect(await onDisk(dir)).toBe(INCOMING);
    expect(h.resynced).toBe(1);
    expect(thrown).toBe(err);
  });

  it('re-syncs and keeps the checkout as it is when the read fails and HEAD did not move', async () => {
    const { dir, before, kept } = await setAside();
    shim = await failGit(['rev-parse', 'HEAD']);
    const { err, thrown } = await recover(dir, kept, before);
    await shim.restore();
    shim = null;
    expect(await onDisk(dir)).toBe(OLD);
    expect(h.resynced).toBe(1);
    expect(thrown).toBe(err);
  });

  describe.each([
    ['exits 128', () => failGit(['rev-parse', 'HEAD']), 1],
    [
      'times out',
      () => {
        gitTimeoutLimits.short = 300;
        return failGit(['rev-parse', 'HEAD'], { hang: true });
      },
      1,
    ],
    // With no git at all the re-sync itself finds git unreadable and answers false before reading anything.
    ['cannot start', () => noGit(), 0],
  ])('when the read %s after the move landed', (_how, start, resyncs) => {
    it('leaves the incoming bytes in the tree and re-syncs', async () => {
      const { dir, before, kept, land } = await setAside();
      land();
      shim = await start();
      const { err, thrown } = await recover(dir, kept, before);
      await shim.restore();
      shim = null;
      expect(await onDisk(dir)).toBe(INCOMING);
      expect(git(dir, 'show', `HEAD:${PLAN}`)).toBe(INCOMING.trim());
      expect(h.resynced).toBe(resyncs);
      expect(thrown).toBe(err);
    });
  });
});

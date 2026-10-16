import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormSchema } from '@haive/shared';
import { syncBaseStep } from './00a-sync-base.js';
import { resolveMergePhase } from '../../merge-resolver.js';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { claimFake } from '../../../../test/merge-dir-claim-fake.js';
import { StepSupersededError } from '../../step-ownership.js';

const projections = vi.hoisted(() => ({
  setAside: vi.fn(),
  resync: vi.fn(),
  putBack: vi.fn(),
  restore: vi.fn(),
  seed: vi.fn(),
}));
vi.mock('@haive/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/database')>()),
  lockRepositoryTasksKey: async () => undefined,
}));
vi.mock('../../../plan/mirror.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../plan/mirror.js')>()),
  seedPlanBaseFromCheckout: projections.seed,
}));
vi.mock('../../../project-state/set-aside.js', () => ({
  setAsideHaiveProjections: projections.setAside,
  resyncHaiveProjections: projections.resync,
  putBackProjections: projections.putBack,
  putBackAfterFailure: async (...args: unknown[]) => {
    await projections.putBack(...args.slice(0, 4));
    throw args[4];
  },
  recoverAfterMoveFailure: async (...args: unknown[]) => {
    await projections.putBack(...args.slice(0, 4));
    throw args[5];
  },
  restoreKeptMetadata: async () => undefined,
  restoreProjectionsInTx: projections.restore,
  MOVE_ATTEMPTS: 3,
}));
// As the root worker, which the hand-back after a move is for: every path reads as the worker's own,
// and a hand-back is recorded instead of made.
const handBack = vi.hoisted(() => ({ asRoot: false, chowned: [] as string[] }));
vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    lstatNoFollow: async (...args: Parameters<typeof real.lstatNoFollow>) => {
      const info = await real.lstatNoFollow(...args);
      return handBack.asRoot && info ? { ...info, stats: { ...info.stats, uid: 0 } } : info;
    },
    chownNoFollow: async (...args: Parameters<typeof real.chownNoFollow>) => {
      if (handBack.asRoot) handBack.chowned.push(args[1]);
      else await real.chownNoFollow(...args);
    },
  };
});
vi.mock('../../merge-dir-claim.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../merge-dir-claim.js')>()),
  ...(await import('../../../../test/merge-dir-claim-fake.js')).mergeDirClaimOverrides(),
}));
const leftOpen = vi.hoisted(() => ({ takeKept: vi.fn() }));
vi.mock('../../left-open-merge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../left-open-merge.js')>()),
  relocateLeftOpenFixers: async () => null,
  noteAbortedByNext: async (_db: unknown, row: unknown) => row,
  takeLeftOpenKept: leftOpen.takeKept,
}));
beforeEach(() => {
  handBack.asRoot = false;
  handBack.chowned = [];
  claimFake.reset();
  projections.setAside.mockReset();
  projections.resync.mockReset();
  projections.resync.mockResolvedValue(true);
  projections.putBack.mockReset();
  projections.restore.mockReset();
  projections.seed.mockReset();
  projections.seed.mockResolvedValue(undefined);
  projections.restore.mockResolvedValue({ outcome: 'clean' });
  leftOpen.takeKept.mockReset();
  leftOpen.takeKept.mockResolvedValue({});
});

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'gc.auto=0', ...args], { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}
async function gitCode(dir: string, args: string[]): Promise<number> {
  try {
    await exec('git', ['-c', 'gc.auto=0', ...args], { cwd: dir, env: GIT_ENV });
    return 0;
  } catch (e) {
    return (e as { code?: number }).code ?? 1;
  }
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** ctx whose db stubs the credential lookup detect does (no bound credential → a
 *  plain fetch, which works against a file:// origin). */
function mkCtx(
  repoPath: string,
  repositoryId: string | null = null,
  otherCheckoutTasks: { id: string }[] = [],
): StepContext {
  const db = {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
    execute: async () => [{ ok: true }],
    query: {
      tasks: {
        findFirst: async () => ({ repositoryId }),
        findMany: async () => otherCheckoutTasks,
      },
      repositories: { findFirst: async () => null },
    },
  };
  return {
    repoPath,
    sandboxWorkdir: repoPath,
    userId: 'u1',
    taskId: 't1',
    taskStepId: 'step1',
    db,
    logger,
  } as unknown as StepContext;
}
function applyArgs(detected: unknown, formValues: Record<string, unknown>): never {
  return { detected, formValues, iteration: 0, previousIterations: [] } as never;
}

/** A bare origin on `main` with one commit, plus a seed working clone to advance it. */
async function seedOrigin(): Promise<{ bare: string; seed: string }> {
  const bare = await mkdtemp(path.join(tmpdir(), 'sync-bare-'));
  await git(bare, ['init', '--bare', '-b', 'main']);
  const seed = await mkdtemp(path.join(tmpdir(), 'sync-seed-'));
  await git(seed, ['init', '-b', 'main']);
  await git(seed, ['remote', 'add', 'origin', `file://${bare}`]);
  await writeFile(path.join(seed, 'a.txt'), '1\n', 'utf8');
  await git(seed, ['add', '-A']);
  await git(seed, ['commit', '-m', 'c1']);
  await git(seed, ['push', '-u', 'origin', 'main']);
  return { bare, seed };
}
async function cloneLocal(bare: string): Promise<string> {
  const local = await mkdtemp(path.join(tmpdir(), 'sync-local-'));
  await git(local, ['clone', `file://${bare}`, '.']);
  return local;
}
async function advanceOrigin(seed: string, file: string): Promise<void> {
  await writeFile(path.join(seed, file), 'x\n', 'utf8');
  await git(seed, ['add', '-A']);
  await git(seed, ['commit', '-m', `add ${file}`]);
  await git(seed, ['push', 'origin', 'main']);
}

describe('00a-sync-base detect + apply (real git)', () => {
  it('behind origin → detect counts it; apply fast-forwards the local base', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare); // local at c1
    await advanceOrigin(seed, 'b.txt'); // origin at c2
    try {
      const ctx = mkCtx(local);
      const d = await syncBaseStep.detect!(ctx);
      expect(d.hasOrigin).toBe(true);
      expect(d.fetchOk).toBe(true);
      expect(d.behindBy).toBe(1);
      expect(d.diverged).toBe(false);
      // Shape resolveMergePhase reads (merge origin/<base> into <base>).
      expect(d.branchName).toBe('origin/main');
      expect(d.baseBranch).toBe('main');
      expect(d.parentBranch).toBe('main');

      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: true, base: 'main', strategy: 'ff' });
      expect(await gitCode(local, ['show', 'main:b.txt'])).toBe(0); // ff brought c2 in
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('sets Haive projections aside before the fast-forward and re-syncs after it', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await advanceOrigin(seed, 'b.txt');
    try {
      const head = async () => (await git(local, ['rev-parse', 'HEAD'])).trim();
      const before = await head();
      let atAside: string | null = null;
      let atResync: string | null = null;
      projections.setAside.mockImplementation(async () => {
        atAside = await head();
        return { outcome: 'set-aside', paths: [], kept: new Map() };
      });
      projections.resync.mockImplementation(async () => {
        atResync = await head();
      });
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: true, strategy: 'ff' });
      expect(projections.setAside).toHaveBeenCalledWith(
        ctx.db,
        'repo-1',
        local,
        expect.any(Function),
        { restore: expect.any(Function), putBack: expect.any(Function) },
      );
      expect(atAside).toBe(before);
      expect(projections.resync).toHaveBeenCalledWith(ctx.db, 'repo-1', local);
      expect(atResync).not.toBe(before);
      expect(atResync).toBe(await head());
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('hands what the fast-forward wrote to the sandbox user, as the root worker', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await mkdir(path.join(seed, 'dir', 'sub'), { recursive: true });
    await writeFile(path.join(seed, 'dir', 'sub', 'c.txt'), 'c\n', 'utf8');
    await advanceOrigin(seed, 'b.txt');
    const asRoot = vi.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      handBack.asRoot = true;
      const ctx = mkCtx(local);
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: true, base: 'main', strategy: 'ff' });
      expect([...handBack.chowned].sort()).toEqual(['b.txt', 'dir', 'dir/sub', 'dir/sub/c.txt']);
    } finally {
      asRoot.mockRestore();
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('seeds the plan base from the checkout before the set-aside and the fast-forward', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await advanceOrigin(seed, 'b.txt');
    try {
      const before = (await git(local, ['rev-parse', 'HEAD'])).trim();
      let atSeed: string | null = null;
      projections.seed.mockImplementation(async () => {
        atSeed = (await git(local, ['rev-parse', 'HEAD'])).trim();
      });
      projections.setAside.mockResolvedValue({ outcome: 'clean' });
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: true, strategy: 'ff' });
      expect(projections.seed).toHaveBeenCalledWith(ctx.db, 'repo-1', local);
      expect(atSeed).toBe(before);
      expect(projections.seed.mock.invocationCallOrder[0]).toBeLessThan(
        projections.setAside.mock.invocationCallOrder[0]!,
      );
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('a plan base that cannot be seeded leaves the base where it is', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await advanceOrigin(seed, 'b.txt');
    try {
      const before = (await git(local, ['rev-parse', 'HEAD'])).trim();
      projections.seed.mockRejectedValue(new Error('plan.json unreadable'));
      projections.setAside.mockResolvedValue({ outcome: 'clean' });
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: false, strategy: 'skipped' });
      expect(out.reason).toContain('plan.json unreadable');
      expect(projections.setAside).not.toHaveBeenCalled();
      expect((await git(local, ['rev-parse', 'HEAD'])).trim()).toBe(before);
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('another task working in the checkout holds the set-aside, and the base is not moved', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await advanceOrigin(seed, 'b.txt');
    try {
      const before = (await git(local, ['rev-parse', 'HEAD'])).trim();
      projections.setAside.mockResolvedValue({ outcome: 'held', holding: 1 });
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: false, strategy: 'skipped' });
      expect(out.reason).toContain('working in this checkout');
      expect(typeof projections.setAside.mock.calls[0]?.[3]).toBe('function');
      expect((await git(local, ['rev-parse', 'HEAD'])).trim()).toBe(before);
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('a task that starts working in the checkout before the move holds the fast-forward', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await advanceOrigin(seed, 'b.txt');
    try {
      const before = (await git(local, ['rev-parse', 'HEAD'])).trim();
      projections.setAside.mockResolvedValue({ outcome: 'clean' });
      const ctx = mkCtx(local, 'repo-1', [{ id: 'other' }]);
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: false, strategy: 'skipped' });
      expect(out.reason).toContain('working in this checkout');
      expect((await git(local, ['rev-parse', 'HEAD'])).trim()).toBe(before);
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('another task merging in this checkout holds the fast-forward, and the base is not moved', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await advanceOrigin(seed, 'b.txt');
    try {
      const before = (await git(local, ['rev-parse', 'HEAD'])).trim();
      projections.setAside.mockResolvedValue({ outcome: 'clean' });
      claimFake.claims.set(local, { taskId: 'cleanup-task', stepId: 'step-12', title: 'cleanup' });
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: false, strategy: 'skipped' });
      expect(out.reason).toContain('is merging in this checkout');
      expect((await git(local, ['rev-parse', 'HEAD'])).trim()).toBe(before);
    } finally {
      claimFake.reset();
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('a task cancelled during the set-aside is refused before the move, and the files go back', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await advanceOrigin(seed, 'b.txt');
    try {
      const before = (await git(local, ['rev-parse', 'HEAD'])).trim();
      projections.setAside.mockImplementation(async () => {
        claimFake.fenced = true;
        return { outcome: 'set-aside', paths: [], kept: new Map([['p', { index: null }]]) };
      });
      projections.restore.mockResolvedValue({ outcome: 'clean' });
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      await expect(syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }))).rejects.toThrow(
        StepSupersededError,
      );
      expect((await git(local, ['rev-parse', 'HEAD'])).trim()).toBe(before);
      expect(projections.putBack).toHaveBeenCalledTimes(1);
    } finally {
      claimFake.reset();
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('a claim release that fails after a moved base fails the step rather than leaving the claim', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await advanceOrigin(seed, 'b.txt');
    try {
      projections.setAside.mockResolvedValue({ outcome: 'clean' });
      projections.restore.mockResolvedValue({ outcome: 'clean' });
      claimFake.releaseError = new Error('connection lost');
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      await expect(syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }))).rejects.toThrow(
        'connection lost',
      );
    } finally {
      claimFake.reset();
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('a claim the step left behind is released even when the base needs no move', async () => {
    const { bare } = await seedOrigin();
    const local = await cloneLocal(bare);
    try {
      claimFake.claims.set(local, { taskId: 't1', stepId: 'step1', title: '' });
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ strategy: 'noop' });
      expect(claimFake.claims.has(local)).toBe(false);
    } finally {
      claimFake.reset();
      await rm(bare, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('a projection file Haive did not write refuses the fast-forward, naming the file', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await advanceOrigin(seed, 'b.txt');
    try {
      const before = (await git(local, ['rev-parse', 'HEAD'])).trim();
      projections.setAside.mockResolvedValue({
        outcome: 'refused',
        file: '.haive-data/state/project/render.json',
        reason: '.haive-data/state/project/render.json holds changes Haive did not write',
      });
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: false, strategy: 'skipped' });
      expect(out.reason).toContain('.haive-data/state/project/render.json');
      expect((await git(local, ['rev-parse', 'HEAD'])).trim()).toBe(before);
      expect(projections.resync).not.toHaveBeenCalled();
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('a file the restore under the locks refuses stops the fast-forward, naming the file', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await advanceOrigin(seed, 'b.txt');
    try {
      const before = (await git(local, ['rev-parse', 'HEAD'])).trim();
      projections.setAside.mockResolvedValue({ outcome: 'clean' });
      projections.restore.mockResolvedValue({
        outcome: 'refused',
        file: '.haive-data/state/project/render.json',
        reason: '.haive-data/state/project/render.json holds changes Haive did not write',
      });
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: false, strategy: 'skipped' });
      expect(out.reason).toContain('.haive-data/state/project/render.json');
      expect((await git(local, ['rev-parse', 'HEAD'])).trim()).toBe(before);
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('a file found rewritten under the locks sets aside again, then the fast-forward lands', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await advanceOrigin(seed, 'b.txt');
    try {
      projections.setAside.mockResolvedValue({ outcome: 'set-aside', paths: [], kept: new Map() });
      projections.restore.mockResolvedValueOnce({ outcome: 'retry' });
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: true, strategy: 'ff' });
      expect(projections.setAside).toHaveBeenCalledTimes(2);
      expect(projections.restore).toHaveBeenCalledTimes(2);
      expect(projections.resync).toHaveBeenCalledTimes(1);
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('a file rewritten on every attempt stops the fast-forward unmoved after three', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await advanceOrigin(seed, 'b.txt');
    try {
      const before = (await git(local, ['rev-parse', 'HEAD'])).trim();
      projections.setAside.mockResolvedValue({ outcome: 'set-aside', paths: [], kept: new Map() });
      projections.restore.mockResolvedValue({ outcome: 'retry' });
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: false, strategy: 'skipped' });
      expect(out.reason).toContain('kept changing');
      expect((await git(local, ['rev-parse', 'HEAD'])).trim()).toBe(before);
      expect(projections.setAside).toHaveBeenCalledTimes(3);
      expect(projections.putBack).toHaveBeenCalledTimes(1);
      expect(projections.resync).not.toHaveBeenCalled();
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('a base that is not the checked-out branch moves a ref only, so nothing is set aside', async () => {
    const { bare, seed } = await seedOrigin();
    await git(seed, ['checkout', '-b', 'dev']);
    await git(seed, ['push', 'origin', 'dev']);
    const local = await cloneLocal(bare);
    await git(local, ['branch', 'dev', 'origin/dev']);
    await writeFile(path.join(seed, 'dev.txt'), 'x\n', 'utf8');
    await git(seed, ['add', '-A']);
    await git(seed, ['commit', '-m', 'dev work']);
    await git(seed, ['push', 'origin', 'dev']);
    try {
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'dev' }));
      expect(out).toMatchObject({ synced: true, base: 'dev', strategy: 'ff' });
      expect(projections.setAside).not.toHaveBeenCalled();
      expect(projections.resync).not.toHaveBeenCalled();
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('up to date with origin → noop', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    try {
      const ctx = mkCtx(local);
      const d = await syncBaseStep.detect!(ctx);
      expect(d.behindBy).toBe(0);
      expect(d.diverged).toBe(false);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: true, strategy: 'noop' });
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('up to date on the current branch → re-syncs Haive projections, since a fast-forward may have landed unrecorded', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    try {
      const ctx = mkCtx(local, 'repo-1');
      const d = await syncBaseStep.detect!(ctx);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: true, strategy: 'noop' });
      expect(projections.setAside).not.toHaveBeenCalled();
      expect(projections.resync).toHaveBeenCalledWith(ctx.db, 'repo-1', local);
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('no origin remote → skipped, base still recorded for 01', async () => {
    const local = await mkdtemp(path.join(tmpdir(), 'sync-noremote-'));
    await git(local, ['init', '-b', 'main']);
    await writeFile(path.join(local, 'a.txt'), '1\n', 'utf8');
    await git(local, ['add', '-A']);
    await git(local, ['commit', '-m', 'c1']);
    try {
      const ctx = mkCtx(local);
      const d = await syncBaseStep.detect!(ctx);
      expect(d.hasOrigin).toBe(false);
      const out = await syncBaseStep.apply(ctx, applyArgs(d, { base: 'main' }));
      expect(out).toMatchObject({ synced: false, base: 'main', strategy: 'skipped' });
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  });
});

// In-memory db backing merge_resolve_state for the divergence merge (mirrors the
// 12-worktree-cleanup test's stub, trimmed to the clean-merge path).
function makeMergeDb(repositoryId: string | null = null, initial: unknown = null) {
  let mergeState: unknown = initial;
  const setPatch = (patch: Record<string, unknown>) => {
    if ('mergeResolveState' in patch) mergeState = patch.mergeResolveState;
  };
  const db = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    // resolveGitEnv walks tasks -> repositories before users; an unlinked task means
    // the merge commit uses merge-resolver's FALLBACK_GIT_IDENTITY, as before.
    query: {
      tasks: { findFirst: async () => ({ repositoryId }) },
      repositories: { findFirst: async () => undefined },
      users: { findFirst: async () => undefined },
      taskSteps: { findFirst: async () => ({ mergeResolveState: mergeState }) },
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            setPatch(patch);
            return [{ id: 'step1', status: 'running', errorMessage: null }];
          },
          then: (resolve: (v: unknown) => void) => {
            setPatch(patch);
            resolve(undefined);
          },
        }),
      }),
    }),
  };
  return {
    db,
    getState: () =>
      mergeState as { merged?: boolean; phase?: string; keptMetadata?: unknown } | null,
  };
}

const KEPT_FILE = '.haive-data/state/project/render.json';

/** A clean divergence merge over a set-aside that kept `KEPT_FILE`'s owner and mode, with a re-sync answering `synced`: the state it ends in. */
async function mergeOverKeptFile(synced: boolean) {
  const { bare, seed } = await seedOrigin();
  const local = await cloneLocal(bare);
  await writeFile(path.join(local, 'local.txt'), 'L\n', 'utf8');
  await git(local, ['add', '-A']);
  await git(local, ['commit', '-m', 'local work']);
  await advanceOrigin(seed, 'origin.txt');
  try {
    const kept = { bytes: Buffer.from('{}\n'), index: null, mode: 0o600, untracked: true };
    projections.setAside.mockResolvedValue({
      outcome: 'set-aside',
      paths: [KEPT_FILE],
      kept: new Map([[KEPT_FILE, { ...kept, owner: { uid: 0, gid: 0 } }]]),
    });
    projections.resync.mockResolvedValue(synced);
    const d = await syncBaseStep.detect!(mkCtx(local));
    const h = makeMergeDb('repo-1');
    const step = syncBaseStep as unknown as StepDefinition;
    const current = {
      id: 'step1',
      detectOutput: d,
      formValues: { base: 'main', syncAction: 'merge' },
      mergeResolveState: null,
      status: 'running',
    } as never;
    const params = {
      db: h.db,
      taskId: 't1',
      userId: 'u1',
      repoPath: '',
      workspacePath: '',
      cliProviderId: null,
      ignoreSavedStepClis: false,
      stepDef: step,
    } as never;
    const merge = await resolveMergePhase(h.db as never, step, current, mkCtx(local), params);
    expect(merge.resolved).toBe(true);
    return h.getState();
  } finally {
    await rm(bare, { recursive: true, force: true });
    await rm(seed, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
}

describe('00a-sync-base divergence (real git + merge phase)', () => {
  it('diverged → the merge phase seeds the plan base from the checkout before it merges', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    await writeFile(path.join(local, 'local.txt'), 'L\n', 'utf8');
    await git(local, ['add', '-A']);
    await git(local, ['commit', '-m', 'local work']);
    await advanceOrigin(seed, 'origin.txt');
    try {
      const before = (await git(local, ['rev-parse', 'HEAD'])).trim();
      let atSeed: string | null = null;
      projections.seed.mockImplementation(async () => {
        atSeed = (await git(local, ['rev-parse', 'HEAD'])).trim();
      });
      projections.setAside.mockResolvedValue({ outcome: 'clean' });
      const d = await syncBaseStep.detect!(mkCtx(local));
      const h = makeMergeDb('repo-1');
      const step = syncBaseStep as unknown as StepDefinition;
      const current = {
        id: 'step1',
        detectOutput: d,
        formValues: { base: 'main', syncAction: 'merge' },
        mergeResolveState: null,
        status: 'running',
      } as never;
      const params = {
        db: h.db,
        taskId: 't1',
        userId: 'u1',
        repoPath: '',
        workspacePath: '',
        cliProviderId: null,
        ignoreSavedStepClis: false,
        stepDef: step,
      } as never;
      const merge = await resolveMergePhase(h.db as never, step, current, mkCtx(local), params);
      expect(merge.resolved).toBe(true);
      expect(projections.seed).toHaveBeenCalledWith(h.db, 'repo-1', local);
      expect(atSeed).toBe(before);
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('diverged → the reused merge phase merges origin/main into main (clean)', async () => {
    const { bare, seed } = await seedOrigin();
    const local = await cloneLocal(bare);
    // local diverges with its own commit on main...
    await writeFile(path.join(local, 'local.txt'), 'L\n', 'utf8');
    await git(local, ['add', '-A']);
    await git(local, ['commit', '-m', 'local work']);
    // ...while origin advances on a different file → genuine divergence, clean merge.
    await advanceOrigin(seed, 'origin.txt');
    try {
      const ctx = mkCtx(local);
      const d = await syncBaseStep.detect!(ctx);
      expect(d.diverged).toBe(true);

      const h = makeMergeDb();
      const step = syncBaseStep as unknown as StepDefinition;
      const current = {
        id: 'step1',
        detectOutput: d,
        formValues: { base: 'main', syncAction: 'merge' },
        mergeResolveState: null,
        status: 'running',
      } as never;
      const params = {
        db: h.db,
        taskId: 't1',
        userId: 'u1',
        repoPath: '',
        workspacePath: '',
        cliProviderId: null,
        ignoreSavedStepClis: false,
        stepDef: step,
      } as never;
      const merge = await resolveMergePhase(h.db as never, step, current, mkCtx(local), params);
      expect(merge.resolved).toBe(true);
      expect(h.getState()?.merged).toBe(true);
      // Both sides are now on local main.
      expect(await gitCode(local, ['show', 'main:origin.txt'])).toBe(0);
      expect(await gitCode(local, ['show', 'main:local.txt'])).toBe(0);

      const out = await syncBaseStep.apply(
        ctx,
        applyArgs(d, { base: 'main', syncAction: 'merge' }),
      );
      expect(out).toMatchObject({ synced: true, strategy: 'merge' });
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });

  it('a merge that lands past a re-sync restores the owner and mode its set-aside kept, and drops the record', async () => {
    const state = await mergeOverKeptFile(true);
    expect(state).toMatchObject({ phase: 'done', merged: true });
    expect(state?.keptMetadata).toBeUndefined();
  });

  it('a merge that lands past a re-sync that did not succeed keeps the record for a later settle', async () => {
    const state = await mergeOverKeptFile(false);
    expect(state).toMatchObject({ phase: 'done', merged: true });
    expect(state?.keptMetadata).toEqual({
      [KEPT_FILE]: { owner: { uid: 0, gid: 0 }, mode: 0o600 },
    });
  });
});

const STALE_KEPT = { [KEPT_FILE]: { mode: 0o600 } };

/** A diverged checkout with another ref's merge left open in it, and a pass in `phase` that dies
 *  right after clearing that merge: what the step saved, and whether that merge was still open when
 *  what its task kept was taken. */
async function clearStaleMergeThenDie(phase: 'pending' | 'resolving') {
  const { bare, seed } = await seedOrigin();
  const local = await cloneLocal(bare);
  await git(local, ['checkout', '-b', 'other']);
  await writeFile(path.join(local, 'conflict.txt'), 'other\n', 'utf8');
  await git(local, ['add', '-A']);
  await git(local, ['commit', '-m', 'other side']);
  await git(local, ['checkout', 'main']);
  await writeFile(path.join(local, 'conflict.txt'), 'main\n', 'utf8');
  await git(local, ['add', '-A']);
  await git(local, ['commit', '-m', 'local work']);
  await advanceOrigin(seed, 'origin.txt');
  try {
    const d = await syncBaseStep.detect!(mkCtx(local));
    expect(await gitCode(local, ['merge', 'other'])).not.toBe(0);
    const staleHead = (await git(local, ['rev-parse', 'MERGE_HEAD'])).trim();
    let takenWhileOpen = false;
    leftOpen.takeKept.mockImplementation(
      async (
        _db: unknown,
        _taskId: string,
        dir: string,
        open: { mergeHead: string },
        save: (kept: unknown) => Promise<void>,
      ) => {
        const head = (await git(dir, ['rev-parse', 'MERGE_HEAD'])).trim();
        takenWhileOpen = open.mergeHead === staleHead && head === staleHead;
        await save(STALE_KEPT);
        return STALE_KEPT;
      },
    );
    projections.restore.mockRejectedValue(new Error('worker died'));
    const resolving =
      phase === 'resolving'
        ? {
            mode: 'same-branch',
            phase: 'resolving',
            baseBranch: 'main',
            featureBranch: 'origin/main',
            mergeDir: local,
            sandboxMergeDir: local,
            fixInvocationId: null,
            conflictRetries: 0,
            pendingQuestion: null,
            pushAfterMerge: false,
            squashAfterMerge: false,
            merged: false,
            skipReason: null,
            pushed: false,
            mergeStage: 'feature',
            baseSyncRounds: 0,
          }
        : null;
    if (resolving) claimFake.claims.set(local, { taskId: 't1', stepId: 'step1', title: '' });
    const h = makeMergeDb('repo-1', resolving);
    const step = syncBaseStep as unknown as StepDefinition;
    const current = {
      id: 'step1',
      detectOutput: d,
      formValues: { base: 'main', syncAction: 'merge' },
      mergeResolveState: resolving,
      status: 'running',
    } as never;
    const params = {
      db: h.db,
      taskId: 't1',
      userId: 'u1',
      repoPath: '',
      workspacePath: '',
      cliProviderId: null,
      ignoreSavedStepClis: false,
      stepDef: step,
      providers: [{}],
      deps: {},
    } as never;
    await expect(
      resolveMergePhase(h.db as never, step, current, mkCtx(local), params),
    ).rejects.toThrow('worker died');
    const staleGone = (await gitCode(local, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) !== 0;
    return { takenWhileOpen, staleGone, state: h.getState() };
  } finally {
    await rm(bare, { recursive: true, force: true });
    await rm(seed, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
}

describe('a merge a cancelled task left open in the checkout', () => {
  it.each(['pending', 'resolving'] as const)(
    'has what that task kept saved into this step before it is aborted (%s)',
    async (phase) => {
      const out = await clearStaleMergeThenDie(phase);
      expect(out.staleGone).toBe(true);
      expect(out.takenWhileOpen).toBe(true);
      expect(out.state?.keptMetadata).toEqual(STALE_KEPT);
    },
  );
});

// Pure form / predicate tests (detect stubs — no git).
function det(over: Record<string, unknown> = {}) {
  return {
    hasGit: true,
    currentBranch: 'main',
    hasOrigin: true,
    fetchOk: true,
    fetchError: null,
    behindBy: 0,
    aheadBy: 0,
    diverged: false,
    branchName: 'origin/main',
    baseBranch: 'main',
    parentBranch: 'main',
    ...over,
  };
}
const fctx = { logger } as unknown as StepContext;
function formOf(over: Record<string, unknown> = {}): FormSchema {
  return syncBaseStep.form!(fctx, det(over) as never) as FormSchema;
}
const ids = (s: FormSchema) => s.fields.map((f) => f.id);

describe('00a-sync-base form', () => {
  it('no git branch → autoSubmit pass-through, no fields', () => {
    const s = formOf({ hasGit: false, baseBranch: null });
    expect(s.autoSubmit).toBe(true);
    expect(s.fields).toHaveLength(0);
  });

  it('always offers the base picker when there is a branch', () => {
    expect(ids(formOf({ behindBy: 2 }))).toContain('base');
    expect(ids(formOf({ diverged: true, behindBy: 2, aheadBy: 1 }))).toContain('base');
  });

  it('auto-submits a clean sync but gates on divergence / fetch failure', () => {
    expect(formOf({ behindBy: 2 }).autoSubmit).toBe(true); // clean fast-forward
    expect(formOf().autoSubmit).toBe(true); // up to date
    expect(formOf({ hasOrigin: false }).autoSubmit).toBe(true); // no origin, nothing to sync
    expect(formOf({ diverged: true, behindBy: 2, aheadBy: 1 }).autoSubmit).toBeUndefined();
    expect(formOf({ fetchOk: false, fetchError: 'x' }).autoSubmit).toBeUndefined();
  });

  it('shows the merge/skip choice ONLY when diverged', () => {
    expect(ids(formOf({ diverged: true, behindBy: 2, aheadBy: 1 }))).toContain('syncAction');
    expect(ids(formOf({ behindBy: 2 }))).not.toContain('syncAction');
    expect(ids(formOf())).not.toContain('syncAction');
  });

  it('warns and still lets the user continue when the fetch failed', () => {
    const s = formOf({ fetchOk: false, fetchError: 'network is unreachable' });
    const note = s.fields.find((f) => f.id === 'fetchFailed') as { variant?: string } | undefined;
    expect(note?.variant).toBe('warning');
    expect(ids(s)).toContain('base');
  });
});

describe('00a-sync-base mergeResolve.selectedMerge', () => {
  it('engages only when the user kept the merge action', () => {
    expect(syncBaseStep.mergeResolve!.selectedMerge({ syncAction: 'merge' })).toBe(true);
    expect(syncBaseStep.mergeResolve!.selectedMerge({ syncAction: 'skip' })).toBe(false);
    expect(syncBaseStep.mergeResolve!.selectedMerge({})).toBe(false);
  });
});

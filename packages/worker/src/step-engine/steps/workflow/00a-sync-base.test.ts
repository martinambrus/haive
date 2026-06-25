import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { FormSchema } from '@haive/shared';
import { syncBaseStep } from './00a-sync-base.js';
import { resolveMergePhase } from '../../merge-resolver.js';
import type { StepContext, StepDefinition } from '../../step-definition.js';

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

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** ctx whose db stubs the credential lookup detect does (no bound credential → a
 *  plain fetch, which works against a file:// origin). */
function mkCtx(repoPath: string): StepContext {
  return {
    repoPath,
    sandboxWorkdir: repoPath,
    userId: 'u1',
    taskId: 't1',
    taskStepId: 'step1',
    db: {
      query: {
        tasks: { findFirst: async () => ({ repositoryId: null }) },
        repositories: { findFirst: async () => null },
      },
    },
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
function makeMergeDb() {
  let mergeState: unknown = null;
  const setPatch = (patch: Record<string, unknown>) => {
    if ('mergeResolveState' in patch) mergeState = patch.mergeResolveState;
  };
  const db = {
    query: { users: { findFirst: async () => undefined } },
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
  return { db, getState: () => mergeState as { merged?: boolean; phase?: string } | null };
}

describe('00a-sync-base divergence (real git + merge phase)', () => {
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

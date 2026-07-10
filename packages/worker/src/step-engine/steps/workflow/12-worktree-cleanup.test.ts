import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import type { MergeResolveState } from '@haive/database';
import { MERGE_CLARIFICATION_ANSWERED_EVENT, MERGE_CLARIFICATION_ASKED_EVENT } from '@haive/shared';
import { worktreeCleanupStep } from './12-worktree-cleanup.js';
import { loadOutstandingMergeGuidance, resolveMergePhase } from '../../merge-resolver.js';
import type { StepContext, StepApplyArgs, StepDefinition } from '../../step-definition.js';

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

/** A parent repo on `main` with a `feature/x` worktree that has one commit ahead. */
async function setupWorktree(): Promise<{ parent: string; wt: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'wt-parent-'));
  await git(parent, ['init', '-b', 'main']);
  await writeFile(path.join(parent, 'base.txt'), 'base\n', 'utf8');
  await git(parent, ['add', '-A']);
  await git(parent, ['commit', '-m', 'initial']);
  const wt = path.join(parent, '.haive', 'worktrees', 'feature-x');
  await mkdir(path.dirname(wt), { recursive: true });
  await git(parent, ['worktree', 'add', '-b', 'feature/x', wt, 'main']);
  await writeFile(path.join(wt, 'feature.txt'), 'feature\n', 'utf8');
  await git(wt, ['add', '-A']);
  await git(wt, ['commit', '-m', 'feature work']);
  return { parent, wt };
}

/** Diverge base.txt on both branches so a feature->main merge conflicts. */
async function divergeBase(parent: string, wt: string): Promise<void> {
  await writeFile(path.join(wt, 'base.txt'), 'feature-edit\n', 'utf8');
  await git(wt, ['commit', '-am', 'edit base on feature']);
  await writeFile(path.join(parent, 'base.txt'), 'main-edit\n', 'utf8');
  await git(parent, ['commit', '-am', 'edit base on main']);
}

/** Give `parent` an `origin` (a fresh bare) and push its current `main`. */
async function pushParentMainToOrigin(parent: string): Promise<string> {
  const bare = await mkdtemp(path.join(tmpdir(), 'wt-origin-'));
  await git(bare, ['init', '--bare', '-b', 'main']);
  await git(parent, ['remote', 'add', 'origin', `file://${bare}`]);
  await git(parent, ['push', '-u', 'origin', 'main']);
  return bare;
}

/** Advance origin's `main` by one commit (via an ephemeral clone) so the parent's
 *  remote-tracking ref goes stale until it next fetches. */
async function advanceOrigin(bare: string, file: string, content: string): Promise<void> {
  const seed = await mkdtemp(path.join(tmpdir(), 'wt-seed-'));
  try {
    await git(seed, ['clone', `file://${bare}`, '.']);
    await writeFile(path.join(seed, file), content, 'utf8');
    await git(seed, ['add', '-A']);
    await git(seed, ['commit', '-m', `origin: ${file}`]);
    await git(seed, ['push', 'origin', 'main']);
  } finally {
    await rm(seed, { recursive: true, force: true });
  }
}

type Det = {
  mode: 'worktree' | 'inplace' | 'no-git' | 'unknown';
  worktreePath: string | null;
  branchName: string | null;
  baseBranch: string | null;
  parentBranch: string | null;
  repositoryId: string | null;
  hasOrigin: boolean;
  originUrl: string | null;
  boundCredentialId: string | null;
  credentials: { id: string; label: string; host: string }[];
};
function det(wt: string, over: Partial<Det> = {}): Det {
  return {
    mode: 'worktree',
    worktreePath: wt,
    branchName: 'feature/x',
    baseBranch: 'main',
    parentBranch: 'main',
    repositoryId: 'r1',
    hasOrigin: false,
    originUrl: null,
    boundCredentialId: null,
    credentials: [],
    ...over,
  };
}

const logger = { info: () => {}, warn: () => {}, error: () => {} };

// In-memory stub db backing task_steps.merge_resolve_state, shared by
// resolveMergePhase (writes) and apply (reads). resolveGitEnv reads users
// (undefined -> fallback identity).
function makeDb(
  opts: { invocation?: { id: string; endedAt: Date | null; rawOutput?: string } } = {},
) {
  let mergeState: MergeResolveState | null = null;
  let status = 'running';
  let errorMessage: string | null = null;
  const applyPatch = (patch: Record<string, unknown>) => {
    if ('mergeResolveState' in patch) mergeState = patch.mergeResolveState as MergeResolveState;
    if ('status' in patch) status = patch.status as string;
    if ('errorMessage' in patch) errorMessage = (patch.errorMessage as string | null) ?? null;
  };
  const db = {
    query: {
      users: { findFirst: async () => undefined },
      taskSteps: { findFirst: async () => ({ id: 'step1', mergeResolveState: mergeState }) },
      cliInvocations: { findFirst: async () => opts.invocation ?? undefined },
      userStepCliRolePreferences: { findFirst: async () => undefined },
      userStepCliPreferences: { findFirst: async () => undefined },
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            applyPatch(patch);
            return [{ id: 'step1', status, errorMessage }];
          },
          then: (resolve: (v: unknown) => void) => {
            applyPatch(patch);
            resolve(undefined);
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => [{ id: 'inv1' }],
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      }),
    }),
  };
  return { db, getState: () => mergeState };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const step = worktreeCleanupStep as unknown as StepDefinition;
function mkCtx(parent: string, db: unknown): StepContext {
  return {
    repoPath: parent,
    sandboxWorkdir: parent,
    userId: 'u1',
    taskStepId: 'step1',
    db,
    logger,
  } as unknown as StepContext;
}
function mkCurrent(
  detected: Det,
  formValues: Record<string, unknown>,
  state: MergeResolveState | null = null,
) {
  return {
    id: 'step1',
    detectOutput: detected,
    formValues,
    mergeResolveState: state,
    status: 'running',
  } as never;
}
function mkParams(db: unknown, over: Record<string, unknown> = {}) {
  return {
    db,
    taskId: 't1',
    userId: 'u1',
    repoPath: '',
    workspacePath: '',
    cliProviderId: null,
    ignoreSavedStepClis: false,
    stepDef: step,
    ...over,
  } as never;
}
function applyArgs(detected: Det, formValues: Record<string, unknown>): StepApplyArgs<Det> {
  return { detected, formValues, iteration: 0, previousIterations: [] };
}

/** Run the merge phase, then apply (only when the phase resolved). */
async function mergeThenApply(
  parent: string,
  detected: Det,
  formValues: Record<string, unknown>,
  paramsOver: Record<string, unknown> = {},
) {
  const h = makeDb();
  const ctx = mkCtx(parent, h.db);
  const merge = await resolveMergePhase(
    h.db as never,
    step,
    mkCurrent(detected, formValues),
    ctx,
    mkParams(h.db, paramsOver),
  );
  const applyOut = merge.resolved
    ? await worktreeCleanupStep.apply(ctx, applyArgs(detected, formValues))
    : null;
  return { merge, applyOut, state: h.getState() };
}

describe('12 merge phase + apply (real git)', () => {
  it('same-branch clean merge: phase merges, apply removes the worktree + safe-deletes', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const { merge, applyOut, state } = await mergeThenApply(parent, det(wt), {
        action: 'merge_remove',
        deleteBranch: true,
      });
      expect(merge.resolved).toBe(true);
      expect(state?.merged).toBe(true);
      expect(applyOut?.merged).toBe(true);
      expect(applyOut?.removed).toBe(true);
      expect(applyOut?.branchDeleted).toBe(true);
      expect(await gitCode(parent, ['show', 'main:feature.txt'])).toBe(0);
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x'])).not.toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('falls back to the parent current branch when no base was recorded (older task)', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const { applyOut, state } = await mergeThenApply(parent, det(wt, { baseBranch: null }), {
        action: 'merge_remove',
      });
      expect(state?.merged).toBe(true);
      expect(applyOut?.merged).toBe(true);
      expect(await gitCode(parent, ['show', 'main:feature.txt'])).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('cross-branch: merges via a base worktree, parent checkout untouched, base worktree removed', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      // Move the parent checkout OFF the base branch so `main` is free for a worktree.
      await git(parent, ['checkout', '-b', 'develop']);
      const { merge, applyOut, state } = await mergeThenApply(
        parent,
        det(wt, { parentBranch: 'develop' }),
        { action: 'merge_remove' },
      );
      expect(merge.resolved).toBe(true);
      expect(state?.mode).toBe('cross-branch');
      expect(state?.merged).toBe(true);
      // The feature commit landed on main...
      expect(await gitCode(parent, ['show', 'main:feature.txt'])).toBe(0);
      // ...the parent checkout stayed on develop...
      expect((await git(parent, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('develop');
      // ...and the transient base worktree was torn down.
      expect(await git(parent, ['worktree', 'list', '--porcelain'])).not.toContain('main--base');
      expect(applyOut?.merged).toBe(true);
      expect(applyOut?.removed).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('conflict with no CLI provider: phase halts (failed), aborts the merge, keeps the worktree', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      const h = makeDb();
      const ctx = mkCtx(parent, h.db);
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }),
        ctx,
        mkParams(h.db), // no providers / deps
      );
      expect(merge.resolved).toBe(false);
      if (!merge.resolved) expect(merge.result.status).toBe('failed');
      // The merge was aborted (no MERGE_HEAD) and the branch + worktree survive.
      expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).not.toBe(0);
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x'])).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('ingests a completed fix agent: host completes the resolved mid-merge', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      // Live mid-merge, then simulate the agent resolving the file.
      await gitCode(parent, ['merge', '--no-ff', 'feature/x', '-m', 'Merge feature/x']);
      await writeFile(path.join(parent, 'base.txt'), 'resolved\n', 'utf8');
      const seeded: MergeResolveState = {
        mode: 'same-branch',
        phase: 'resolving',
        baseBranch: 'main',
        featureBranch: 'feature/x',
        mergeDir: parent,
        sandboxMergeDir: parent,
        fixInvocationId: 'inv1',
        conflictRetries: 1,
        pendingQuestion: null,
        pushAfterMerge: false,
        merged: false,
        skipReason: null,
        pushed: false,
      };
      const h = makeDb({ invocation: { id: 'inv1', endedAt: new Date() } });
      const ctx = mkCtx(parent, h.db);
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }, seeded),
        ctx,
        mkParams(h.db, { providers: [], deps: { enqueueCliInvocation: async () => {} } }),
      );
      expect(merge.resolved).toBe(true);
      expect(h.getState()?.merged).toBe(true);
      expect(await readFile(path.join(parent, 'base.txt'), 'utf8')).toBe('resolved\n');
      // Merge committed → MERGE_HEAD gone.
      expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).not.toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('pushBase pushes the integrated base branch to origin', async () => {
    const { parent, wt } = await setupWorktree();
    const bare = await mkdtemp(path.join(tmpdir(), 'wt-bare-'));
    try {
      await git(bare, ['init', '--bare', '-b', 'main']);
      await git(parent, ['remote', 'add', 'origin', `file://${bare}`]);
      const { merge, state } = await mergeThenApply(parent, det(wt, { hasOrigin: true }), {
        action: 'merge_remove',
        pushBase: true,
        setUpstream: true,
      });
      expect(merge.resolved).toBe(true);
      expect(state?.merged).toBe(true);
      expect(state?.pushed).toBe(true);
      // The merged base (with the feature commit) reached the origin.
      expect(await gitCode(bare, ['show', 'main:feature.txt'])).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('push failure halts but preserves the local merge', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await git(parent, ['remote', 'add', 'origin', 'file:///nonexistent/repo.git']);
      const h = makeDb();
      const ctx = mkCtx(parent, h.db);
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt, { hasOrigin: true }), { action: 'merge_remove', pushBase: true }),
        ctx,
        mkParams(h.db),
      );
      expect(merge.resolved).toBe(false);
      if (!merge.resolved) expect(merge.result.status).toBe('failed');
      // The merge committed locally even though the push failed.
      expect(await gitCode(parent, ['show', 'main:feature.txt'])).toBe(0);
      expect(h.getState()?.merged).toBe(true);
      expect(h.getState()?.pushed).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('12 pre-push base sync (origin advanced after 00a)', () => {
  it('(d) origin not advanced → pushes directly, no base-sync round', async () => {
    const { parent, wt } = await setupWorktree();
    const bare = await pushParentMainToOrigin(parent);
    try {
      const { merge, state } = await mergeThenApply(parent, det(wt, { hasOrigin: true }), {
        action: 'merge_remove',
        pushBase: true,
        setUpstream: true,
      });
      expect(merge.resolved).toBe(true);
      expect(state?.pushed).toBe(true);
      expect(state?.mergeStage).toBe('feature'); // never entered a base-sync round
      expect(state?.baseSyncRounds ?? 0).toBe(0);
      expect(await gitCode(bare, ['show', 'main:feature.txt'])).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('(a) origin advanced on a different file → auto-integrated, push carries both', async () => {
    const { parent, wt } = await setupWorktree();
    const bare = await pushParentMainToOrigin(parent);
    await advanceOrigin(bare, 'origin-new.txt', 'origin\n'); // non-conflicting
    try {
      const { merge, state } = await mergeThenApply(parent, det(wt, { hasOrigin: true }), {
        action: 'merge_remove',
        pushBase: true,
      });
      expect(merge.resolved).toBe(true);
      expect(state?.pushed).toBe(true);
      expect(state?.mergeStage).toBe('base-sync'); // a base-sync round ran
      expect(state?.baseSyncRounds).toBe(1);
      // Both the feature commit and origin's new commit reached origin.
      expect(await gitCode(bare, ['show', 'main:feature.txt'])).toBe(0);
      expect(await gitCode(bare, ['show', 'main:origin-new.txt'])).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('(b) origin advanced conflicting + resolved fix agent → resolved, then pushed', async () => {
    const { parent, wt } = await setupWorktree();
    // The feature also edits base.txt so the base-sync merge (origin/main -> main)
    // conflicts while the feature -> main merge stays clean.
    await writeFile(path.join(wt, 'base.txt'), 'feature-edit\n', 'utf8');
    await git(wt, ['commit', '-am', 'edit base on feature']);
    const bare = await pushParentMainToOrigin(parent);
    await advanceOrigin(bare, 'base.txt', 'origin-edit\n');
    try {
      // Pre-stage: land the clean feature merge, then open the conflicting base-sync
      // merge live and have the "agent" resolve base.txt (mirrors the feature fix test).
      await gitCode(parent, ['merge', '--no-ff', 'feature/x', '-m', 'Merge feature/x']);
      await git(parent, ['fetch', 'origin', 'main']);
      await gitCode(parent, ['merge', '--no-ff', 'origin/main', '-m', 'Merge origin/main']);
      await writeFile(path.join(parent, 'base.txt'), 'resolved\n', 'utf8');
      const seeded: MergeResolveState = {
        mode: 'same-branch',
        phase: 'resolving',
        baseBranch: 'main',
        featureBranch: 'origin/main',
        mergeDir: parent,
        sandboxMergeDir: parent,
        fixInvocationId: 'inv1',
        conflictRetries: 1,
        pendingQuestion: null,
        pushAfterMerge: true,
        merged: false,
        skipReason: null,
        pushed: false,
        mergeStage: 'base-sync',
        baseSyncRounds: 1,
      };
      const h = makeDb({ invocation: { id: 'inv1', endedAt: new Date() } });
      const ctx = mkCtx(parent, h.db);
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt, { hasOrigin: true }), { action: 'merge_remove', pushBase: true }, seeded),
        ctx,
        mkParams(h.db, { providers: [], deps: { enqueueCliInvocation: async () => {} } }),
      );
      expect(merge.resolved).toBe(true);
      expect(h.getState()?.merged).toBe(true);
      expect(h.getState()?.pushed).toBe(true);
      // The resolved base.txt and the feature commit reached origin.
      expect(await gitCode(bare, ['show', 'main:feature.txt'])).toBe(0);
      expect((await git(bare, ['show', 'main:base.txt'])).trim()).toBe('resolved');
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('(c) origin advanced conflicting + no CLI provider → halts, feature merge kept, nothing pushed', async () => {
    const { parent, wt } = await setupWorktree();
    await writeFile(path.join(wt, 'base.txt'), 'feature-edit\n', 'utf8');
    await git(wt, ['commit', '-am', 'edit base on feature']);
    const bare = await pushParentMainToOrigin(parent);
    await advanceOrigin(bare, 'base.txt', 'origin-edit\n');
    try {
      const h = makeDb();
      const ctx = mkCtx(parent, h.db);
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt, { hasOrigin: true }), { action: 'merge_remove', pushBase: true }),
        ctx,
        mkParams(h.db), // no providers
      );
      expect(merge.resolved).toBe(false);
      if (!merge.resolved) expect(merge.result.status).toBe('failed');
      expect(h.getState()?.pushed).toBe(false);
      // The clean feature merge survives on local main; the base-sync merge was aborted.
      expect(await gitCode(parent, ['show', 'main:feature.txt'])).toBe(0);
      expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).not.toBe(0);
      // Nothing reached origin.
      expect(await gitCode(bare, ['show', 'main:feature.txt'])).not.toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('12 worktree cleanup apply (non-merge actions)', () => {
  const stubCtx = (parent: string) =>
    ({
      repoPath: parent,
      userId: 'u1',
      taskStepId: 'step1',
      db: { query: { users: { findFirst: async () => undefined } } },
      logger,
    }) as unknown as StepContext;

  it('remove_only removes the worktree but keeps the branch', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const out = await worktreeCleanupStep.apply(
        stubCtx(parent),
        applyArgs(det(wt), { action: 'remove_only' }),
      );
      expect(out.removed).toBe(true);
      expect(out.merged).toBe(false);
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x'])).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('keep leaves the worktree in place', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const out = await worktreeCleanupStep.apply(
        stubCtx(parent),
        applyArgs(det(wt), { action: 'keep' }),
      );
      expect(out.removed).toBe(false);
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x'])).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('12 worktree cleanup form', () => {
  const stubCtx = (parent: string) =>
    ({ repoPath: parent, userId: 'u1', db: {}, logger }) as unknown as StepContext;

  it('defaults to merge_remove and offers branch-delete + the remove-only terminal note', () => {
    const schema = worktreeCleanupStep.form!(stubCtx(''), det('/ws/.haive/worktrees/feature-x'));
    const action = schema.fields.find((f) => f.id === 'action') as { default?: string };
    expect(action.default).toBe('merge_remove');
    const note = schema.fields.find((f) => f.id === 'removeOnlyNote') as { body?: string };
    expect(note.body).toContain('/repos/r1/terminal');
    expect(note.body).toContain('git branch -D feature/x');
    expect(schema.fields.some((f) => f.id === 'deleteBranch')).toBe(true);
  });

  it('passes straight through (auto-submit, no fields) when there is no worktree', () => {
    const schema = worktreeCleanupStep.form!(
      stubCtx(''),
      det('', { mode: 'inplace', worktreePath: null }),
    );
    expect(schema.autoSubmit).toBe(true);
    expect(schema.fields).toHaveLength(0);
  });
});

describe('12 worktree cleanup form (push gating)', () => {
  const fctx = { repoPath: '', userId: 'u1', db: {}, logger } as unknown as StepContext;

  it('hides the push fields when there is no origin', () => {
    const schema = worktreeCleanupStep.form!(fctx, det('/ws/wt', { hasOrigin: false }));
    expect(schema.fields.some((f) => f.id === 'pushBase')).toBe(false);
    expect(schema.fields.some((f) => f.id === 'credentialId')).toBe(false);
    expect(schema.fields.some((f) => f.id === 'setUpstream')).toBe(false);
  });

  it('offers the push fields (with the credential picker) when an origin exists', () => {
    const schema = worktreeCleanupStep.form!(
      fctx,
      det('/ws/wt', {
        hasOrigin: true,
        originUrl: 'https://x/y.git',
        credentials: [{ id: 'c1', label: 'gh', host: 'github.com' }],
      }),
    );
    expect(schema.fields.some((f) => f.id === 'pushBase')).toBe(true);
    const cred = schema.fields.find((f) => f.id === 'credentialId') as {
      options?: { value: string }[];
    };
    expect(cred.options?.some((o) => o.value === 'c1')).toBe(true);
  });

  it('cross-branch + no origin warns that the merge stays local', () => {
    const schema = worktreeCleanupStep.form!(
      fctx,
      det('/ws/wt', { parentBranch: 'develop', hasOrigin: false }),
    );
    const note = schema.fields.find((f) => f.id === 'branchMismatchNote') as {
      body?: string;
      variant?: string;
    };
    expect(note.variant).toBe('warning');
    expect(note.body).toContain('cannot be pushed');
  });

  it('cross-branch + origin shows the cross-branch info note', () => {
    const schema = worktreeCleanupStep.form!(
      fctx,
      det('/ws/wt', { parentBranch: 'develop', hasOrigin: true }),
    );
    const note = schema.fields.find((f) => f.id === 'branchMismatchNote') as { variant?: string };
    expect(note.variant).toBe('info');
  });
});

describe('12 merge clarification', () => {
  it('agent uncertainty parks the step for user guidance', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      await gitCode(parent, ['merge', '--no-ff', 'feature/x', '-m', 'Merge feature/x']);
      const seeded: MergeResolveState = {
        mode: 'same-branch',
        phase: 'resolving',
        baseBranch: 'main',
        featureBranch: 'feature/x',
        mergeDir: parent,
        sandboxMergeDir: parent,
        fixInvocationId: 'inv1',
        conflictRetries: 1,
        pendingQuestion: null,
        pushAfterMerge: false,
        merged: false,
        skipReason: null,
        pushed: false,
      };
      const h = makeDb({
        invocation: {
          id: 'inv1',
          endedAt: new Date(),
          rawOutput: '{"status":"uncertain","question":"Which side wins for base.txt?"}',
        },
      });
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }, seeded),
        mkCtx(parent, h.db),
        mkParams(h.db, { providers: [], deps: { enqueueCliInvocation: async () => {} } }),
      );
      expect(merge.resolved).toBe(false);
      if (!merge.resolved) {
        expect(merge.result.status).toBe('waiting_form');
        const fs = (
          merge.result as { formSchema?: { submitAction?: string; fields: { id: string }[] } }
        ).formSchema;
        expect(fs?.submitAction).toBe('clarify');
        expect(fs?.fields.some((f) => f.id === 'mergeGuidance')).toBe(true);
      }
      expect(h.getState()?.phase).toBe('awaiting-guidance');
      expect(h.getState()?.pendingQuestion?.uncertainty).toContain('base.txt');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  function eventsDb(rows: { eventType: string; payload: unknown }[]) {
    // rows are pre-sorted newest-first; the helper limit(1) takes the head.
    return {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async (n: number) => rows.slice(0, n) }) }),
        }),
      }),
    } as never;
  }

  it('loadOutstandingMergeGuidance returns the latest answer, or empty once re-asked', async () => {
    const answered = eventsDb([
      { eventType: MERGE_CLARIFICATION_ANSWERED_EVENT, payload: { answer: 'prefer feature side' } },
    ]);
    expect(await loadOutstandingMergeGuidance(answered, 't1')).toBe('prefer feature side');
    const reAsked = eventsDb([
      { eventType: MERGE_CLARIFICATION_ASKED_EVENT, payload: { uncertainty: '?' } },
    ]);
    expect(await loadOutstandingMergeGuidance(reAsked, 't1')).toBe('');
  });
});

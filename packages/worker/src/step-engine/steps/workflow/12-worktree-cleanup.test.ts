import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect, vi } from 'vitest';
import { schema, type MergeResolveState } from '@haive/database';
import { MERGE_CLARIFICATION_ANSWERED_EVENT, MERGE_CLARIFICATION_ASKED_EVENT } from '@haive/shared';
import { worktreeCleanupStep } from './12-worktree-cleanup.js';
import { loadOutstandingMergeGuidance, resolveMergePhase } from '../../merge-resolver.js';
import { StepSupersededError } from '../../step-ownership.js';
import { resolveTaskDispatch } from '../../../orchestrator/dispatcher.js';
import type { StepContext, StepApplyArgs, StepDefinition } from '../../step-definition.js';

// Pre-existing tests pass no providers, which this answers with skip as the real
// dispatcher does; the real one needs ConfigService and the adapter registry.
vi.mock('../../../orchestrator/dispatcher.js', () => ({
  resolveTaskDispatch: vi.fn(
    async (_db: unknown, _taskId: string, opts: { providers: unknown[] }) =>
      opts.providers && opts.providers.length > 0
        ? {
            mode: 'cli',
            providerId: 'p1',
            providerName: 'p1',
            adapter: null,
            provider: null,
            invocation: { kind: 'cli', spec: {} },
            effectivePrompt: undefined,
            effort: null,
            reason: 'test stub',
          }
        : {
            mode: 'skip',
            providerId: null,
            providerName: null,
            adapter: null,
            provider: null,
            invocation: null,
            reason: 'no providers',
          },
  ),
}));

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

// Derived from the step rather than copied: a hand-written copy of this shape went
// stale as the step grew PR-workflow fields, and nothing type-checked the test.
type Det = Parameters<NonNullable<typeof worktreeCleanupStep.form>>[1];
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
    prWorkflowAvailable: false,
    taskTitle: '',
    taskDescription: '',
    ...over,
  };
}

// The form is nullable by contract; every case that reads one expects one, so a null
// fails at its first read instead of each line asserting it.
const formOf = (...args: Parameters<NonNullable<typeof worktreeCleanupStep.form>>) =>
  worktreeCleanupStep.form!(...args)!;

const logger = { info: () => {}, warn: () => {}, error: () => {} };

// In-memory stub db backing task_steps.merge_resolve_state, shared by
// resolveMergePhase (writes) and apply (reads). resolveGitEnv reads users
// (undefined -> fallback identity).
function makeDb(
  opts: {
    invocation?: {
      id: string;
      endedAt: Date | null;
      exitCode?: number | null;
      errorMessage?: string | null;
      rawOutput?: string;
      /** Set by a Retry that superseded this run before it ever started. */
      supersededAt?: Date | null;
    };
    /** Row findWorktreePathClaimant sees: another live task holding the same worktree. */
    worktreeSharer?: { id: string; title: string; status: string };
    /** Rows buildSquashCommitMessage lists in the squash commit's body. */
    dagIssues?: { issueKey: string; title: string }[];
    /** A Retry reset the row while the pass ran: a write carrying the ownership guard matches
     *  nothing. */
    rowTaken?: boolean;
    /** Rejects the fix-agent invocation insert, as the one-live-per-step unique index does
     *  when a concurrent advance already dispatched one. */
    insertRejects?: unknown;
  } = {},
) {
  let mergeState: MergeResolveState | null = null;
  let status = opts.rowTaken ? 'pending' : 'running';
  let errorMessage: string | null = null;
  let warningMessage: string | null = null;
  const events: { eventType: string; payload: unknown }[] = [];
  const applyPatch = (patch: Record<string, unknown>) => {
    if ('mergeResolveState' in patch) mergeState = patch.mergeResolveState as MergeResolveState;
    if ('status' in patch) status = patch.status as string;
    if ('errorMessage' in patch) errorMessage = (patch.errorMessage as string | null) ?? null;
    if ('warningMessage' in patch) warningMessage = (patch.warningMessage as string | null) ?? null;
  };
  const db = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    query: {
      users: { findFirst: async () => undefined },
      tasks: { findFirst: async () => opts.worktreeSharer ?? undefined },
      taskSteps: { findFirst: async () => ({ id: 'step1', mergeResolveState: mergeState }) },
      cliInvocations: { findFirst: async () => opts.invocation ?? undefined },
      userStepCliRolePreferences: { findFirst: async () => undefined },
      userStepCliPreferences: { findFirst: async () => undefined },
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond: unknown) => ({
          returning: async () => {
            const values = conditionValues(cond);
            const guarded = values.includes('pending') && values.includes('skipped');
            if (guarded && (status === 'pending' || status === 'skipped')) return [];
            applyPatch(patch);
            return [{ id: 'step1', status, errorMessage, warningMessage }];
          },
          then: (resolve: (v: unknown) => void) => {
            applyPatch(patch);
            resolve(undefined);
          },
        }),
      }),
    }),
    insert: (table?: unknown) => ({
      values: (v: { eventType: string; payload: unknown }) => {
        if (table === schema.taskEvents) events.push(v);
        return {
          returning: async () => {
            if (opts.insertRejects) throw opts.insertRejects;
            return [{ id: 'inv1' }];
          },
          then: (resolve: (v: unknown) => void) => resolve(undefined),
        };
      },
    }),
    // One chain answers both shapes: buildSquashCommitMessage awaits orderBy directly,
    // loadOutstandingMergeGuidance continues to limit(1). lockOwnedStep's ownership probe
    // (select({id}).from(taskSteps).where(owned(id)).for('update')) is a third, distinguished
    // by its columns argument, and honours the same ownership guard as the update mock above.
    select: (cols?: unknown) => ({
      from: (table?: unknown) => {
        if (table === schema.taskSteps && cols && typeof cols === 'object' && 'id' in cols) {
          return {
            where: () => ({
              for: async () =>
                status === 'pending' || status === 'skipped' || status === 'failed'
                  ? []
                  : [{ id: 'step1' }],
            }),
          };
        }
        return {
          where: () => ({
            orderBy: () => ({
              limit: async () => [],
              then: (resolve: (v: unknown) => void) => resolve(opts.dagIssues ?? []),
            }),
          }),
        };
      },
    }),
  };
  return {
    db,
    getState: () => mergeState,
    getStatus: () => status,
    getWarning: () => warningMessage,
    events,
  };
}

/** Values a drizzle condition binds, in order. */
function conditionValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) conditionValues(item, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) acc.push(obj.value);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionValues(c, acc);
  return acc;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const step = worktreeCleanupStep as unknown as StepDefinition;
function mkCtx(parent: string, db: unknown): StepContext {
  return {
    repoPath: parent,
    sandboxWorkdir: parent,
    userId: 'u1',
    taskId: 't1',
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
  dbOpts: Parameters<typeof makeDb>[0] = {},
) {
  const h = makeDb(dbOpts);
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

  it('conflict on a row a Retry reset meanwhile: the merge is aborted and nothing is written', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      const h = makeDb({ rowTaken: true });
      const ctx = mkCtx(parent, h.db);
      await expect(
        resolveMergePhase(
          h.db as never,
          step,
          mkCurrent(det(wt), { action: 'merge_remove' }),
          ctx,
          mkParams(h.db),
        ),
      ).rejects.toBeInstanceOf(StepSupersededError);
      expect(h.getStatus()).toBe('pending');
      expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).not.toBe(0);
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
      const h = makeDb({ invocation: { id: 'inv1', endedAt: new Date(), exitCode: 0 } });
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

  it('commits nothing a fixer left when it did not finish cleanly', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      // The agent removed the markers, then exited 1 without saying whether it was done.
      await gitCode(parent, ['merge', '--no-ff', 'feature/x', '-m', 'Merge feature/x']);
      await writeFile(path.join(parent, 'base.txt'), 'half-resolved\n', 'utf8');
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
        invocation: { id: 'inv1', endedAt: new Date(), exitCode: 1, errorMessage: 'exited 1' },
      });
      const ctx = mkCtx(parent, h.db);
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }, seeded),
        ctx,
        mkParams(h.db, { providers: [], deps: { enqueueCliInvocation: async () => {} } }),
      );
      expect(merge.resolved).toBe(false);
      expect(h.getState()?.merged).toBe(false);
      // Nothing it left reached main, and the attempt it was charged stays spent.
      expect(await git(parent, ['show', 'main:base.txt'])).not.toBe('half-resolved');
      expect(h.getState()?.conflictRetries).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('a superseded fixer whose fix result parsed as resolved still takes the completion path', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      // Live mid-merge; the agent resolved the file and answered right as it was superseded.
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
      const h = makeDb({
        invocation: {
          id: 'inv1',
          endedAt: new Date(),
          supersededAt: new Date(),
          rawOutput: '{"status":"resolved"}',
        },
      });
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

describe('12 merge fix-agent dispatch', () => {
  // A working provider for the mocked dispatcher above: opts.providers.length > 0 is
  // its whole test for "dispatch a cli invocation" vs. "skip, no provider".
  const withProvider = { providers: [{ id: 'p1', enabled: true }] };
  const dispatching = { ...withProvider, deps: { enqueueCliInvocation: async () => {} } };
  const resolving = (parent: string, over: Partial<MergeResolveState> = {}): MergeResolveState => ({
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
    ...over,
  });

  it('a never-answered fixer that edited a file the merge staged: the next fixer starts from a fresh merge', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      await gitCode(parent, ['merge', '--no-ff', 'feature/x', '-m', 'Merge feature/x']);
      // feature.txt merged cleanly and is staged, and the fixer edited it anyway, which is
      // exactly what makes `git merge --abort` refuse.
      await writeFile(path.join(parent, 'feature.txt'), 'fixer edit\n', 'utf8');
      await writeFile(path.join(parent, 'base.txt'), 'half-resolved\n', 'utf8');
      const h = makeDb({ invocation: { id: 'inv1', endedAt: null, supersededAt: new Date() } });
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }, resolving(parent)),
        mkCtx(parent, h.db),
        mkParams(h.db, dispatching),
      );
      expect(merge.resolved).toBe(false);
      if (!merge.resolved) expect(merge.result.status).toBe('waiting_cli');
      expect(await readFile(path.join(parent, 'feature.txt'), 'utf8')).toBe('feature\n');
      expect(await readFile(path.join(parent, 'base.txt'), 'utf8')).toContain('<<<<<<<');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('an abort git refuses halts, is recorded, and sends no fixer into the half merge', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      await gitCode(parent, ['merge', '--no-ff', 'feature/x', '-m', 'Merge feature/x']);
      await writeFile(path.join(parent, 'base.txt'), 'half-resolved\n', 'utf8');
      // A lock git cannot take: the abort fails whatever is edited.
      await writeFile(path.join(parent, '.git', 'index.lock'), '', 'utf8');
      const h = makeDb({ invocation: { id: 'inv1', endedAt: null, supersededAt: new Date() } });
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }, resolving(parent)),
        mkCtx(parent, h.db),
        mkParams(h.db, dispatching),
      );
      expect(merge.resolved).toBe(false);
      if (!merge.resolved) {
        expect(merge.result.status).toBe('failed');
        expect((merge.result as { error?: string }).error).toContain('could not be aborted');
      }
      expect(h.getState()?.fixInvocationId).toBeNull();
      expect(h.events.map((e) => e.eventType)).toEqual(['merge.abort_failed']);
      expect(await readFile(path.join(parent, 'base.txt'), 'utf8')).toBe('half-resolved\n');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('a merge git refused halts with its reason and sends no fixer', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      // An untracked file where the feature branch adds one: git refuses the merge outright.
      await writeFile(path.join(parent, 'feature.txt'), 'mine\n', 'utf8');
      const h = makeDb();
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }),
        mkCtx(parent, h.db),
        mkParams(h.db, dispatching),
      );
      expect(merge.resolved).toBe(false);
      if (!merge.resolved) {
        expect(merge.result.status).toBe('failed');
        expect((merge.result as { error?: string }).error).toContain(
          'git refused to merge feature/x into main',
        );
      }
      expect(h.getState()?.fixInvocationId).toBeNull();
      expect(await readFile(path.join(parent, 'feature.txt'), 'utf8')).toBe('mine\n');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('a merge finished by hand after the fix budget ran out finishes the step', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      await gitCode(parent, ['merge', '--no-ff', 'feature/x', '-m', 'Merge feature/x']);
      await writeFile(path.join(parent, 'base.txt'), 'by hand\n', 'utf8');
      await git(parent, ['commit', '-am', 'merged by hand']);
      const h = makeDb();
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(
          det(wt),
          { action: 'merge_remove' },
          resolving(parent, { fixInvocationId: null, conflictRetries: 4 }),
        ),
        mkCtx(parent, h.db),
        mkParams(h.db),
      );
      expect(merge.resolved).toBe(true);
      expect(h.getState()?.merged).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  /** Send a fixer in, let `fix` do what it did in the merge dir, end its run as `run` says, and
   *  ingest it. */
  async function fixerRound(
    parent: string,
    detected: Det,
    fix: (mergeDir: string) => Promise<void>,
    run: { endedAt: Date | null; exitCode?: number; supersededAt?: Date | null },
  ) {
    const dbOpts: NonNullable<Parameters<typeof makeDb>[0]> = {};
    const h = makeDb(dbOpts);
    const ctx = mkCtx(parent, h.db);
    const form = { action: 'merge_remove' };
    const first = await resolveMergePhase(
      h.db as never,
      step,
      mkCurrent(detected, form),
      ctx,
      mkParams(h.db, dispatching),
    );
    expect(first.resolved).toBe(false);
    const sent = h.getState()!;
    await fix(sent.mergeDir);
    dbOpts.invocation = { id: 'inv1', ...run };
    const second = await resolveMergePhase(
      h.db as never,
      step,
      mkCurrent(detected, form, sent),
      ctx,
      mkParams(h.db, dispatching),
    );
    return { h, second };
  }

  it("a fixer's changes outside the conflict are moved aside, and the merge commit holds only the merge", async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      const { h, second } = await fixerRound(
        parent,
        det(wt),
        async (dir) => {
          await writeFile(path.join(dir, 'base.txt'), 'resolved\n', 'utf8');
          await writeFile(path.join(dir, 'feature.txt'), 'fixer edit\n', 'utf8');
          await writeFile(path.join(dir, 'notes.txt'), 'scratch\n', 'utf8');
        },
        { endedAt: new Date(), exitCode: 0 },
      );
      expect(second.resolved).toBe(true);
      expect(await git(parent, ['show', 'HEAD:base.txt'])).toBe('resolved\n');
      expect(await git(parent, ['show', 'HEAD:feature.txt'])).toBe('feature\n');
      expect(await gitCode(parent, ['cat-file', '-e', 'HEAD:notes.txt'])).not.toBe(0);
      const folder = path.join(parent, '.haive', 'merge-leftovers', 't1', 'inv1');
      expect(await readFile(path.join(folder, 'files', 'notes.txt'), 'utf8')).toBe('scratch\n');
      expect(await readFile(path.join(folder, 'files', 'feature.txt'), 'utf8')).toBe(
        'fixer edit\n',
      );
      expect(h.events.map((e) => e.eventType)).toContain('merge.fixer_leftovers');
      expect(h.getWarning()).toContain('.haive/merge-leftovers/t1/');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("a never-answered fixer's changes outside the conflict are gone before the next fixer starts", async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await writeFile(path.join(parent, 'untouched.txt'), 'untouched\n', 'utf8');
      await git(parent, ['add', 'untouched.txt']);
      await git(parent, ['commit', '-m', 'main only']);
      await divergeBase(parent, wt);
      const { h, second } = await fixerRound(
        parent,
        det(wt),
        async (dir) => {
          await writeFile(path.join(dir, 'base.txt'), 'half-resolved\n', 'utf8');
          await writeFile(path.join(dir, 'untouched.txt'), 'fixer edit\n', 'utf8');
          await writeFile(path.join(dir, 'junk.txt'), 'junk\n', 'utf8');
        },
        { endedAt: null, supersededAt: new Date() },
      );
      expect(second.resolved).toBe(false);
      if (!second.resolved) expect(second.result.status).toBe('waiting_cli');
      expect(await readFile(path.join(parent, 'untouched.txt'), 'utf8')).toBe('untouched\n');
      await expect(readFile(path.join(parent, 'junk.txt'), 'utf8')).rejects.toThrow();
      expect(await readFile(path.join(parent, 'base.txt'), 'utf8')).toContain('<<<<<<<');
      const files = path.join(parent, '.haive', 'merge-leftovers', 't1', 'inv1', 'files');
      expect(await readFile(path.join(files, 'junk.txt'), 'utf8')).toBe('junk\n');
      expect(await readFile(path.join(files, 'untouched.txt'), 'utf8')).toBe('fixer edit\n');
      expect(h.getState()?.fixBaseline).toBeTruthy();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('cross-branch: a base worktree holding a change that could not be moved is kept and reported', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      await git(parent, ['checkout', '-b', 'develop']);
      const { h, second } = await fixerRound(
        parent,
        det(wt, { parentBranch: 'develop' }),
        async (dir) => {
          await writeFile(path.join(dir, 'base.txt'), 'resolved\n', 'utf8');
          await symlink('base.txt', path.join(dir, 'link-stray'));
        },
        { endedAt: new Date(), exitCode: 0 },
      );
      expect(second.resolved).toBe(true);
      expect(await git(parent, ['show', 'main:base.txt'])).toBe('resolved\n');
      expect(await gitCode(parent, ['cat-file', '-e', 'main:link-stray'])).not.toBe(0);
      const base = path.join(parent, '.haive', 'worktrees', 'main--base');
      expect((await lstat(path.join(base, 'link-stray'))).isSymbolicLink()).toBe(true);
      expect(await git(parent, ['worktree', 'list', '--porcelain'])).toContain('main--base');
      expect(h.getWarning()).toContain('was kept');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('a fix invocation superseded before it ever started no longer waits forever', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      // Live mid-merge; the fix agent dispatched into it was superseded before it ever
      // started, so endedAt is still null, the shape a merely-slow run also has.
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
      const h = makeDb({ invocation: { id: 'inv1', endedAt: null, supersededAt: new Date() } });
      const ctx = mkCtx(parent, h.db);
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }, seeded),
        ctx,
        // No provider, so once the stale run is recognised as over the retry halts
        // instead of looping.
        mkParams(h.db),
      );
      expect(merge.resolved).toBe(false);
      if (!merge.resolved) {
        expect(merge.result.status).toBe('failed');
        expect((merge.result as { error?: string }).error).toContain('CLI provider');
      }
      // The stale mid-merge was aborted rather than left open forever.
      expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).not.toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('a fixer that started, was superseded and produced no fix result: aborts, refunds the attempt, and dispatches again', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      await gitCode(parent, ['merge', '--no-ff', 'feature/x', '-m', 'Merge feature/x']);
      // A superseded fixer that removed the conflict markers but never finished:
      // the abort must discard this half-resolved edit, not let it pass as resolved.
      await writeFile(path.join(parent, 'base.txt'), 'half-resolved\n', 'utf8');
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
      const h = makeDb({ invocation: { id: 'inv1', endedAt: null, supersededAt: new Date() } });
      const ctx = mkCtx(parent, h.db);
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }, seeded),
        ctx,
        mkParams(h.db, { ...withProvider, deps: { enqueueCliInvocation: async () => {} } }),
      );
      expect(merge.resolved).toBe(false);
      if (!merge.resolved) expect(merge.result.status).toBe('waiting_cli');
      // Re-opened for the fresh fixer, never committed — completeMergeHostSide's path
      // did not run.
      expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(0);
      // A fresh fixer was dispatched...
      expect(h.getState()?.fixInvocationId).not.toBeNull();
      // ...and the refund (onIngest) plus the recharge (onInserted) net to the same
      // conflictRetries the never-answered fixer was itself dispatched at.
      expect(h.getState()?.conflictRetries).toBe(1);
      // The half-resolved edit never reached completeMergeHostSide, so the merge
      // did not land.
      expect(h.getState()?.merged).not.toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('a run superseded by a Retry that already reset the step row: rejects without dispatching, aborting or touching merge state', async () => {
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
        invocation: { id: 'inv1', endedAt: null, supersededAt: new Date() },
        rowTaken: true,
      });
      const ctx = mkCtx(parent, h.db);
      await expect(
        resolveMergePhase(
          h.db as never,
          step,
          mkCurrent(det(wt), { action: 'merge_remove' }, seeded),
          ctx,
          mkParams(h.db, { ...withProvider, deps: { enqueueCliInvocation: async () => {} } }),
        ),
      ).rejects.toBeInstanceOf(StepSupersededError);
      // The Retry already reset the row before this pass reached it, so nothing here may
      // act on the merge: the abort, the dispatch and the state write all sit after the check.
      expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(0);
      expect(h.getState()).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('asks the fixer to say whether it resolved the conflict or is unsure', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      const h = makeDb();
      await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }),
        mkCtx(parent, h.db),
        mkParams(h.db, { ...withProvider, deps: { enqueueCliInvocation: async () => {} } }),
      );
      const call = vi.mocked(resolveTaskDispatch).mock.calls.at(-1);
      const prompt = (call?.[2] as { input: { prompt: string } }).input.prompt;
      expect(prompt).toContain('{"status": "resolved"}');
      expect(prompt).toContain('{"status": "uncertain", "question":');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('names the invocation in the saved state before enqueuing it, not after', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      const h = makeDb();
      const ctx = mkCtx(parent, h.db);
      const failingDeps = {
        enqueueCliInvocation: async () => {
          throw new Error('queue unavailable');
        },
      };
      await expect(
        resolveMergePhase(
          h.db as never,
          step,
          mkCurrent(det(wt), { action: 'merge_remove' }),
          ctx,
          mkParams(h.db, { ...withProvider, deps: failingDeps }),
        ),
      ).rejects.toThrow('queue unavailable');
      // The invocation id was recorded in the persisted state BEFORE the enqueue that
      // failed, so a crash right there still leaves the run tracked rather than orphaned.
      expect(h.getState()?.fixInvocationId).toBe('inv1');
      expect(h.getState()?.phase).toBe('resolving');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('a concurrent dispatch parks on the winner instead of failing the step', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await divergeBase(parent, wt);
      // The one-live-per-step unique index rejects our insert: a concurrent advance
      // already dispatched a fix agent for this step.
      const conflict = Object.assign(new Error('duplicate key value violates unique constraint'), {
        cause: Object.assign(new Error('duplicate'), { code: '23505' }),
      });
      const h = makeDb({ insertRejects: conflict });
      const ctx = mkCtx(parent, h.db);
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }),
        ctx,
        mkParams(h.db, { ...withProvider, deps: { enqueueCliInvocation: async () => {} } }),
      );
      expect(merge.resolved).toBe(false);
      if (!merge.resolved) expect(merge.result.status).toBe('waiting_cli');
      // Neither aborted the winner's live merge...
      expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(0);
      // ...nor overwrote the state the winner is expected to have saved (still naming no
      // fix invocation of our own).
      expect(h.getState()?.fixInvocationId).toBeNull();
      expect(h.getState()?.phase).toBe('resolving');
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
      const h = makeDb({ invocation: { id: 'inv1', endedAt: new Date(), exitCode: 0 } });
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
  const stubCtx = (parent: string, sharer?: { id: string; title: string; status: string }) =>
    ({
      repoPath: parent,
      userId: 'u1',
      taskId: 'task1',
      taskStepId: 'step1',
      db: {
        query: {
          users: { findFirst: async () => undefined },
          // findWorktreePathClaimant: no sharer unless the test supplies one.
          tasks: { findFirst: async () => sharer },
        },
      },
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

  it('leaves the worktree alone when another live task is still working in it', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const out = await worktreeCleanupStep.apply(
        stubCtx(parent, { id: 'task2', title: 'Other task', status: 'waiting_user' }),
        applyArgs(det(wt), { action: 'remove_only' }),
      );
      expect(out.removed).toBe(false);
      expect(out.message).toContain('task2');
      // The directory and its branch both survive.
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x'])).toBe(0);
      expect(await gitCode(wt, ['rev-parse', '--git-dir'])).toBe(0);
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
    const schema = formOf(stubCtx(''), det('/ws/.haive/worktrees/feature-x'));
    const action = schema.fields.find((f) => f.id === 'action') as { default?: string };
    expect(action.default).toBe('merge_remove');
    const note = schema.fields.find((f) => f.id === 'removeOnlyNote') as { body?: string };
    expect(note.body).toContain('/repos/r1/terminal');
    expect(note.body).toContain('git branch -D feature/x');
    expect(schema.fields.some((f) => f.id === 'deleteBranch')).toBe(true);
  });

  it('offers the squash checkbox ticked by default, scoped to merge_remove', () => {
    const schema = formOf(stubCtx(''), det('/ws/.haive/worktrees/feature-x'));
    const squash = schema.fields.find((f) => f.id === 'squashMerge') as {
      default?: boolean;
      visibleWhen?: { field: string; equals: unknown };
    };
    expect(squash.default).toBe(true);
    expect(squash.visibleWhen).toEqual({ field: 'action', equals: 'merge_remove' });
  });

  it('passes straight through (auto-submit, no fields) when there is no worktree', () => {
    const schema = formOf(stubCtx(''), det('', { mode: 'inplace', worktreePath: null }));
    expect(schema.autoSubmit).toBe(true);
    expect(schema.fields).toHaveLength(0);
  });
});

describe('12 worktree cleanup form (push gating)', () => {
  const fctx = { repoPath: '', userId: 'u1', db: {}, logger } as unknown as StepContext;

  it('hides the push fields when there is no origin', () => {
    const schema = formOf(fctx, det('/ws/wt', { hasOrigin: false }));
    expect(schema.fields.some((f) => f.id === 'pushBase')).toBe(false);
    expect(schema.fields.some((f) => f.id === 'credentialId')).toBe(false);
    expect(schema.fields.some((f) => f.id === 'setUpstream')).toBe(false);
  });

  it('offers the push fields (with the credential picker) when an origin exists', () => {
    const schema = formOf(
      fctx,
      det('/ws/wt', {
        hasOrigin: true,
        originUrl: 'https://x/y.git',
        credentials: [{ id: 'c1', label: 'gh', host: 'github.com', provider: null }],
      }),
    );
    expect(schema.fields.some((f) => f.id === 'pushBase')).toBe(true);
    const cred = schema.fields.find((f) => f.id === 'credentialId') as {
      options?: { value: string }[];
    };
    expect(cred.options?.some((o) => o.value === 'c1')).toBe(true);
  });

  it('cross-branch + no origin warns that the merge stays local', () => {
    const schema = formOf(fctx, det('/ws/wt', { parentBranch: 'develop', hasOrigin: false }));
    const note = schema.fields.find((f) => f.id === 'branchMismatchNote') as {
      body?: string;
      variant?: string;
    };
    expect(note.variant).toBe('warning');
    expect(note.body).toContain('cannot be pushed');
  });

  it('cross-branch + origin shows the cross-branch info note', () => {
    const schema = formOf(fctx, det('/ws/wt', { parentBranch: 'develop', hasOrigin: true }));
    const note = schema.fields.find((f) => f.id === 'branchMismatchNote') as { variant?: string };
    expect(note.variant).toBe('info');
  });
});

describe('12 merge clarification', () => {
  it("reads the fixer's answer past JSON it quoted from a conflicted file", async () => {
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
          exitCode: 0,
          rawOutput: [
            'Both sides of package.json read:',
            '```json',
            '{"name": "app", "version": "1.2.0"}',
            '```',
            '```json',
            '{"status": "uncertain", "question": "Which version wins for package.json?"}',
            '```',
          ].join('\n'),
        },
      });
      await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }, seeded),
        mkCtx(parent, h.db),
        mkParams(h.db, { providers: [], deps: { enqueueCliInvocation: async () => {} } }),
      );
      expect(h.getState()?.phase).toBe('awaiting-guidance');
      expect(h.getState()?.pendingQuestion?.uncertainty).toContain('package.json');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

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
          exitCode: 0,
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

describe('12 squash merge (real git)', () => {
  const issues = [
    { issueKey: 'ISS-1', title: 'feature work' },
    { issueKey: 'ISS-2', title: 'more work' },
  ];
  /** Second commit on the feature branch, so a collapse is observable. */
  async function secondFeatureCommit(wt: string): Promise<void> {
    await writeFile(path.join(wt, 'more.txt'), 'more\n', 'utf8');
    await git(wt, ['add', '-A']);
    await git(wt, ['commit', '-m', 'ISS-2: more work']);
  }

  it('collapses the merge into ONE commit on base, carrying the whole changeset', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await secondFeatureCommit(wt);
      const before = (await git(parent, ['rev-parse', 'main'])).trim();
      // No squashMerge key at all — the default (ticked) must opt in.
      const { applyOut, state } = await mergeThenApply(
        parent,
        det(wt),
        { action: 'merge_remove' },
        {},
        { dagIssues: issues },
      );
      expect(state?.merged).toBe(true);
      expect(state?.squashCommitSha).toBeTruthy();
      expect(state?.baseShaBefore).toBe(before);
      // Exactly one new commit, parented on the pre-merge base tip.
      expect((await git(parent, ['rev-list', '--count', `${before}..main`])).trim()).toBe('1');
      expect((await git(parent, ['rev-parse', 'main^'])).trim()).toBe(before);
      // ...and it carries every file the merge would have brought in.
      expect(await gitCode(parent, ['show', 'main:feature.txt'])).toBe(0);
      expect(await gitCode(parent, ['show', 'main:more.txt'])).toBe(0);
      const body = await git(parent, ['log', '-1', '--format=%B', 'main']);
      expect(body).toContain('- ISS-1: feature work');
      expect(body).toContain('- ISS-2: more work');
      expect(body).toContain('Task: t1');
      expect(applyOut?.message).toContain('squashed commit');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('keeps the merge commit and the full history when the box is unticked', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await secondFeatureCommit(wt);
      const before = (await git(parent, ['rev-parse', 'main'])).trim();
      const { state } = await mergeThenApply(parent, det(wt), {
        action: 'merge_remove',
        squashMerge: false,
      });
      expect(state?.merged).toBe(true);
      expect(state?.squashCommitSha).toBeFalsy();
      // Both feature commits plus the merge commit.
      expect((await git(parent, ['rev-list', '--count', `${before}..main`])).trim()).toBe('3');
      expect((await git(parent, ['log', '-1', '--format=%s', 'main'])).trim()).toBe(
        'Merge feature/x',
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('still deletes merged DAG issue branches, and still keeps an unmerged one', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      // One issue branch folded into the feature branch, one left behind (the shape a
      // failed_unrecoverable issue leaves): only the first may be deleted.
      await git(wt, ['checkout', '-b', 'feature/x--iss-1']);
      await writeFile(path.join(wt, 'iss1.txt'), '1\n', 'utf8');
      await git(wt, ['add', '-A']);
      await git(wt, ['commit', '-m', 'ISS-1: work']);
      await git(wt, ['checkout', 'feature/x']);
      await git(wt, ['merge', '--no-ff', '--no-edit', 'feature/x--iss-1']);
      await git(wt, ['checkout', '-b', 'feature/x--iss-2']);
      await writeFile(path.join(wt, 'iss2.txt'), '2\n', 'utf8');
      await git(wt, ['add', '-A']);
      await git(wt, ['commit', '-m', 'ISS-2: abandoned']);
      await git(wt, ['checkout', 'feature/x']);

      const { applyOut, state } = await mergeThenApply(parent, det(wt), {
        action: 'merge_remove',
        deleteBranch: true,
      });
      expect(state?.squashCommitSha).toBeTruthy();
      expect(applyOut?.branchDeleted).toBe(true);
      expect(applyOut?.message).toContain('1 merged DAG issue branch');
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x'])).not.toBe(0);
      expect(
        await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x--iss-1']),
      ).not.toBe(0);
      // Unmerged work is never force-deleted, squash or no squash.
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x--iss-2'])).toBe(
        0,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

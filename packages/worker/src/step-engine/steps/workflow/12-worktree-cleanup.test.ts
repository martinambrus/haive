import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { schema, type MergeResolveState } from '@haive/database';
import {
  KB_DIR,
  LEARNINGS_DIR,
  MERGE_CLARIFICATION_ANSWERED_EVENT,
  MERGE_CLARIFICATION_ASKED_EVENT,
  configService,
  extractFormDefaults,
  validateFormValues,
  type PlanMirror,
} from '@haive/shared';
import { renderPlanMarkdownFromMirror, serializePlanMirror } from '@haive/shared/plan';
import {
  PROJECT_STATE_DIR,
  emptyProjectState,
  normalizeProjectState,
  renderProjectState,
  type ProjectRender,
} from '@haive/shared/project-state';
import { worktreeCleanupStep } from './12-worktree-cleanup.js';
import { loadOutstandingMergeGuidance, resolveMergePhase } from '../../merge-resolver.js';
import { HAIVE_OWN_FILES_LINE } from '../../git-merge.js';
import { StepSupersededError } from '../../step-ownership.js';
import { resolveTaskDispatch } from '../../../orchestrator/dispatcher.js';
import { OUTPUT_TRUNCATION_HEADLINE } from '../../../queues/cli-exec/failure-class.js';
import { TRUNCATION_RETRY_NOTICE } from '../../step-runner.js';
import type { StepContext, StepApplyArgs, StepDefinition } from '../../step-definition.js';
import { claimFake } from '../../../../test/merge-dir-claim-fake.js';
import { syncBaseStep } from './00a-sync-base.js';
import { onboardingPushStep } from '../onboarding/13-onboarding-push.js';
import { syncProjectStateFromCheckout } from '../../../project-state/sync.js';
import { createFakeDb } from '@haive/database/testing';

// create_pr pushes with a stored credential and opens the PR on the forge; neither is the subject here.
vi.mock('../../../repo/credentials.js', () => ({
  getDecryptedCredentials: vi.fn(async () => ({ username: 'u', secret: 's', host: 'github.com' })),
}));
vi.mock('../../../forge/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../forge/index.js')>()),
  resolveForgeContext: vi.fn(async () => ({ provider: 'github' })),
  resolveForgeProvider: vi.fn(() => ({
    openPullRequest: async () => ({ url: 'https://forge.test/pr/1', number: 1 }),
  })),
}));

vi.mock('../../merge-dir-claim.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../merge-dir-claim.js')>()),
  ...(await import('../../../../test/merge-dir-claim-fake.js')).mergeDirClaimOverrides(),
}));
beforeEach(() => claimFake.reset());

// Pre-existing tests pass no providers, which this answers with skip as the real
// dispatcher does; the real one needs ConfigService and the adapter registry.
vi.mock('../../../queues/cli-exec/secret-mask.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../queues/cli-exec/secret-mask.js')>()),
  taskSecretMaskPolicy: async () => null,
}));
// A relocation whose index cannot be restored, while the index itself stays usable for the commit.
const relocation = vi.hoisted(() => ({ holdIndex: false }));
vi.mock('../../git-merge.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../git-merge.js')>();
  return {
    ...real,
    relocateFixerChanges: async (...args: Parameters<typeof real.relocateFixerChanges>) => {
      const out = await real.relocateFixerChanges(...args);
      return relocation.holdIndex && out ? { ...out, indexHeld: 'index.lock held' } : out;
    },
  };
});
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

const PUT_BACK_EVENT = 'branch.projections_put_back';
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

async function writeIn(dir: string, files: Record<string, string>): Promise<void> {
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), body, 'utf8');
  }
}

/** A parent repo on `main` with a `feature/x` worktree that has one commit ahead. */
async function setupWorktree(
  seed: Record<string, string> = {},
): Promise<{ parent: string; wt: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'wt-parent-'));
  await git(parent, ['init', '-b', 'main']);
  await git(parent, ['config', 'gc.auto', '0']);
  await writeFile(path.join(parent, 'base.txt'), 'base\n', 'utf8');
  await writeIn(parent, seed);
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

/** Two changes no commit holds: an edited tracked file and an untracked one, its name with a space. */
async function leaveUncommitted(wt: string): Promise<void> {
  await writeIn(wt, { 'feature.txt': 'feature, edited\n', 'learning notes.md': 'not committed\n' });
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
    uncommitted: { count: 0, paths: [] },
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
      prompt?: string;
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
    /** A cancelled task's `merge.left_open` report, as the lookup for the merge this pass clears finds it. */
    leftOpen?: {
      owner: { taskId: string; title: string };
      events: unknown[];
      ownerSteps?: unknown[];
    };
  } = {},
) {
  let mergeState: MergeResolveState | null = null;
  let status = opts.rowTaken ? 'pending' : 'running';
  let errorMessage: string | null = null;
  let warningMessage: string | null = null;
  const events: { eventType: string; payload: unknown }[] = [];
  const invocationInserts: { prompt?: string; truncationRetry?: boolean }[] = [];
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
      taskSteps: {
        findFirst: async () => ({ id: 'step1', mergeResolveState: mergeState, warningMessage }),
      },
      cliInvocations: { findFirst: async () => opts.invocation ?? undefined },
      userStepCliRolePreferences: { findFirst: async () => undefined },
      userStepCliPreferences: { findFirst: async () => undefined },
      taskStepCliChoices: { findFirst: async () => undefined },
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
        if (table === schema.cliInvocations)
          invocationInserts.push(v as { prompt?: string; truncationRetry?: boolean });
        return {
          returning: async () => {
            if (opts.insertRejects) throw opts.insertRejects;
            return [{ id: 'inv1' }];
          },
          then: (resolve: (v: unknown) => void) => resolve(undefined),
        };
      },
    }),
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({ where: async () => (opts.leftOpen ? [opts.leftOpen.owner] : []) }),
      }),
    }),
    // One chain answers both shapes: buildSquashCommitMessage awaits orderBy directly,
    // loadOutstandingMergeGuidance continues to limit(1). lockOwnedStep's ownership probe
    // (select({id}).from(taskSteps).where(owned(id)).for('update')) is a third, distinguished
    // by its columns argument, and honours the same ownership guard as the update mock above.
    select: (cols?: unknown) => ({
      from: (table?: unknown) => {
        if (table === schema.taskSteps && cols && typeof cols === 'object' && 'state' in cols) {
          return { where: async () => opts.leftOpen?.ownerSteps ?? [] };
        }
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
        if (table === schema.tasks && cols && typeof cols === 'object' && 'worktreePath' in cols) {
          return { where: async () => [{ worktreePath: null }] };
        }
        if (
          table === schema.taskEvents &&
          cols &&
          typeof cols === 'object' &&
          'eventType' in cols
        ) {
          return { where: () => ({ orderBy: async () => opts.leftOpen?.events ?? [] }) };
        }
        // What the pass recorded of the branch's Haive files it put back, as the warning is re-derived.
        if (table === schema.taskEvents && cols && typeof cols === 'object' && 'payload' in cols) {
          return {
            where: () => ({
              orderBy: async () =>
                events
                  .filter((e) => e.eventType === PUT_BACK_EVENT)
                  .map((e) => ({ payload: e.payload })),
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
    /** A Retry clears the step's warning. */
    clearWarning: () => {
      warningMessage = null;
    },
    events,
    invocationInserts,
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
/** A ctx whose db answers detect's reads: 01-worktree-setup put a task with no repository in `wt`. */
function detectCtx(parent: string, wt: string): StepContext {
  const setup = {
    detectOutput: null,
    output: { mode: 'worktree', worktreePath: wt, branchName: 'feature/x', baseBranch: 'main' },
    iterations: [],
  };
  return {
    repoPath: parent,
    userId: 'u1',
    taskId: 't1',
    taskStepId: 'step1',
    db: {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [setup] }) }) }),
      }),
      query: {
        tasks: { findFirst: async () => ({ repositoryId: null, title: 'Task', description: '' }) },
        repoCredentials: { findMany: async () => [] },
      },
    },
    logger,
  } as unknown as StepContext;
}
function mkCurrent(
  detected: Det,
  formValues: Record<string, unknown>,
  state: MergeResolveState | null = null,
) {
  // A merge a step recorded as open or landed holds its dir, as the claim it took before it began.
  if (state && state.phase !== 'pending' && state.phase !== 'done') {
    claimFake.claims.set(state.mergeDir, { taskId: 't1', stepId: 'step1', title: '' });
  }
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

  describe('cross-branch: a merge another task left open in the shared base worktree', () => {
    /** `main--base` holds an open, conflicted merge of `feature/other`, as another task's fixer leaves it. */
    async function openOtherMerge(parent: string, wt: string): Promise<string> {
      await divergeBase(parent, wt);
      const tmp = path.join(parent, '.haive', 'worktrees', 'other-src');
      await git(parent, ['worktree', 'add', '-b', 'feature/other', tmp, 'main~1']);
      await writeFile(path.join(tmp, 'base.txt'), 'other-edit\n', 'utf8');
      await git(tmp, ['commit', '-am', 'edit base on other']);
      await git(parent, ['worktree', 'remove', '--force', tmp]);
      await git(parent, ['checkout', '-b', 'develop']);
      const base = path.join(parent, '.haive', 'worktrees', 'main--base');
      await git(parent, ['worktree', 'add', base, 'main']);
      expect(await gitCode(base, ['merge', '--no-ff', 'feature/other', '-m', 'other'])).not.toBe(0);
      return base;
    }
    /** `main--base` holds a merge of `feature/other` that landed clean on `main`, which its task
     *  has yet to squash or push: the base-sync round between two of its sections. */
    async function landOtherMerge(parent: string): Promise<string> {
      const tmp = path.join(parent, '.haive', 'worktrees', 'other-src');
      await git(parent, ['worktree', 'add', '-b', 'feature/other', tmp, 'main']);
      await writeFile(path.join(tmp, 'other.txt'), 'other\n', 'utf8');
      await git(tmp, ['add', '-A']);
      await git(tmp, ['commit', '-m', 'other work']);
      await git(parent, ['worktree', 'remove', '--force', tmp]);
      await git(parent, ['checkout', '-b', 'develop']);
      const base = path.join(parent, '.haive', 'worktrees', 'main--base');
      await git(parent, ['worktree', 'add', base, 'main']);
      await git(base, ['merge', '--no-ff', 'feature/other', '-m', 'other']);
      return base;
    }
    const claimedBy = (mergeDir: string, over: { taskId?: string; stepId?: string } = {}) =>
      claimFake.claims.set(mergeDir, {
        taskId: 'other-task',
        stepId: 'other-step',
        title: 'Other feature',
        ...over,
      });
    const runB = async (parent: string, wt: string) => {
      const h = makeDb();
      const merge = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt, { parentBranch: 'develop' }), { action: 'merge_remove' }),
        mkCtx(parent, h.db),
        mkParams(h.db),
      );
      return { h, merge };
    };

    it('a task holding the claim there is not aborted; this task halts naming it', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        const base = await openOtherMerge(parent, wt);
        claimedBy(base);
        const { h, merge } = await runB(parent, wt);
        expect(merge.resolved).toBe(false);
        if (!merge.resolved) {
          expect(merge.result.status).toBe('failed');
          const err = (merge.result as { error: string }).error;
          expect(err).toContain('Other feature');
          expect(err).toContain('other-task');
          expect(err).toContain('retry once it finishes');
        }
        expect(h.getStatus()).toBe('failed');
        expect(await gitCode(base, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(0);
        expect(await git(base, ['diff', '--name-only', '--diff-filter=U'])).toContain('base.txt');
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("a task's merge that landed clean, between its sections, is not merged over", async () => {
      const { parent, wt } = await setupWorktree();
      try {
        const base = await landOtherMerge(parent);
        claimedBy(base);
        const tip = (await git(parent, ['rev-parse', 'main'])).trim();
        const { merge } = await runB(parent, wt);
        expect(merge.resolved).toBe(false);
        if (!merge.resolved) {
          expect((merge.result as { error: string }).error).toContain('retry once it finishes');
        }
        expect((await git(parent, ['rev-parse', 'main'])).trim()).toBe(tip);
        expect(await gitCode(parent, ['show', 'main:feature.txt'])).not.toBe(0);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it('a merge whose claim was released is cleaned up: its merge is aborted', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        const base = await openOtherMerge(parent, wt);
        const { merge } = await runB(parent, wt);
        expect(merge.resolved).toBe(false);
        if (!merge.resolved) {
          expect((merge.result as { error: string }).error).not.toContain('retry once it finishes');
        }
        expect(await gitCode(base, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).not.toBe(0);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("a cancelled task's reported merge is settled, and this step says it cleared it", async () => {
      const { parent, wt } = await setupWorktree();
      try {
        const base = await openOtherMerge(parent, wt);
        const report = {
          eventType: 'merge.left_open',
          payload: {
            dir: base,
            ref: 'feature/other',
            head: (await git(base, ['rev-parse', 'HEAD'])).trim(),
            mergeHead: (await git(base, ['rev-parse', 'MERGE_HEAD'])).trim(),
          },
        };
        const h = makeDb({
          leftOpen: { owner: { taskId: 'cancelled-task', title: 'Old feature' }, events: [report] },
        });
        await resolveMergePhase(
          h.db as never,
          step,
          mkCurrent(det(wt, { parentBranch: 'develop' }), { action: 'merge_remove' }),
          mkCtx(parent, h.db),
          mkParams(h.db),
        );
        expect(await gitCode(base, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).not.toBe(0);
        const settled = h.events.filter((e) => e.eventType === 'merge.left_open_settled');
        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatchObject({
          taskId: 'cancelled-task',
          payload: { dir: base, mergeHead: report.payload.mergeHead, outcome: 'aborted-by-next' },
        });
        expect(h.getWarning()).toContain('Old feature');
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it('a hold is retried into a base worktree the holder removed meanwhile', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        const base = await openOtherMerge(parent, wt);
        claimedBy(base);
        const first = await runB(parent, wt);
        expect(first.merge.resolved).toBe(false);
        await git(base, ['merge', '--abort']);
        await git(parent, ['worktree', 'remove', '--force', base]);
        claimFake.claims.clear();
        const h = makeDb();
        const ctx = mkCtx(parent, h.db);
        const retry = await resolveMergePhase(
          h.db as never,
          step,
          mkCurrent(
            det(wt, { parentBranch: 'develop' }),
            { action: 'merge_remove' },
            first.h.getState(),
          ),
          ctx,
          mkParams(h.db),
        );
        expect(retry.resolved).toBe(false);
        if (!retry.resolved) {
          expect((retry.result as { error: string }).error).toContain('requires a CLI provider');
        }
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("this task's own earlier attempt there is aborted as before", async () => {
      const { parent, wt } = await setupWorktree();
      try {
        const base = await openOtherMerge(parent, wt);
        claimedBy(base, { taskId: 't1', stepId: 'older-step' });
        const { merge } = await runB(parent, wt);
        expect(merge.resolved).toBe(false);
        if (!merge.resolved) {
          expect((merge.result as { error: string }).error).not.toContain('retry once it finishes');
        }
        expect(await gitCode(base, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).not.toBe(0);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it('a pass whose task was cancelled meanwhile writes nothing in the base worktree', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        await git(parent, ['checkout', '-b', 'develop']);
        claimFake.fenced = true;
        const h = makeDb();
        await expect(
          resolveMergePhase(
            h.db as never,
            step,
            mkCurrent(det(wt, { parentBranch: 'develop' }), { action: 'merge_remove' }),
            mkCtx(parent, h.db),
            mkParams(h.db),
          ),
        ).rejects.toBeInstanceOf(StepSupersededError);
        expect(await git(parent, ['worktree', 'list', '--porcelain'])).not.toContain('main--base');
        expect(await gitCode(parent, ['show', 'main:feature.txt'])).not.toBe(0);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it('a finished merge releases the claim in the section that records it done', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        await git(parent, ['checkout', '-b', 'develop']);
        const { h, merge } = await runB(parent, wt);
        expect(merge.resolved).toBe(true);
        expect(h.getState()?.phase).toBe('done');
        expect(claimFake.claims.size).toBe(0);
        expect(claimFake.released).toEqual([
          { mergeDir: expect.stringContaining('main--base'), inSection: true },
        ]);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it('a merge that halts keeps the claim for its Retry', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        await divergeBase(parent, wt);
        await git(parent, ['checkout', '-b', 'develop']);
        const { merge } = await runB(parent, wt);
        expect(merge.resolved).toBe(false);
        const held = [...claimFake.claims.values()];
        expect(held).toEqual([expect.objectContaining({ taskId: 't1', stepId: 'step1' })]);
        expect(claimFake.released).toEqual([]);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });
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

  describe('a pass whose task was cancelled or reset meanwhile', () => {
    const seed = (parent: string, over: Partial<MergeResolveState>): MergeResolveState => ({
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
    const run = async (parent: string, wt: string, state: MergeResolveState) => {
      claimFake.claims.set(parent, { taskId: 't1', stepId: 'step1', title: '' });
      claimFake.fenced = true;
      const h = makeDb({ invocation: { id: 'inv1', endedAt: new Date(), exitCode: 0 } });
      return resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), { action: 'merge_remove' }, state),
        mkCtx(parent, h.db),
        mkParams(h.db, { providers: [], deps: { enqueueCliInvocation: async () => {} } }),
      );
    };

    it("does not ingest a fixer's result: no commit, and the merge is still open", async () => {
      const { parent, wt } = await setupWorktree();
      try {
        await divergeBase(parent, wt);
        await gitCode(parent, ['merge', '--no-ff', 'feature/x', '-m', 'Merge feature/x']);
        await writeFile(path.join(parent, 'base.txt'), 'resolved\n', 'utf8');
        const tip = (await git(parent, ['rev-parse', 'main'])).trim();
        await expect(run(parent, wt, seed(parent, {}))).rejects.toBeInstanceOf(StepSupersededError);
        expect((await git(parent, ['rev-parse', 'main'])).trim()).toBe(tip);
        expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(0);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it('does not squash a landed merge: the base tip is not reset', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        const before = (await git(parent, ['rev-parse', 'main'])).trim();
        await git(parent, ['merge', '--no-ff', 'feature/x', '-m', 'Merge feature/x']);
        const tip = (await git(parent, ['rev-parse', 'main'])).trim();
        const state = seed(parent, {
          phase: 'squashing',
          fixInvocationId: null,
          squashAfterMerge: true,
          baseShaBefore: before,
          mergeStage: 'feature',
        });
        await expect(run(parent, wt, state)).rejects.toBeInstanceOf(StepSupersededError);
        expect((await git(parent, ['rev-parse', 'main'])).trim()).toBe(tip);
        expect((await git(parent, ['rev-parse', 'main^'])).trim()).toBe(before);
        expect(await git(parent, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });
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
    run: {
      endedAt: Date | null;
      exitCode?: number;
      errorMessage?: string | null;
      prompt?: string;
      supersededAt?: Date | null;
      truncationRetry?: boolean;
    },
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

  describe('a fixer cut at the output limit', () => {
    const cut = {
      endedAt: new Date(),
      exitCode: 1,
      errorMessage: `${OUTPUT_TRUNCATION_HEADLINE} — the response was cut off`,
    };
    const halfResolve = async (dir: string) => {
      await writeFile(path.join(dir, 'base.txt'), 'half-resolved\n', 'utf8');
    };

    it('is discarded without charging an attempt, and one fixer is sent with the notice', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        await divergeBase(parent, wt);
        const { h, second } = await fixerRound(parent, det(wt), halfResolve, {
          ...cut,
          prompt: 'resolve the merge',
        });
        expect(second.resolved).toBe(false);
        if (!second.resolved) expect(second.result.status).toBe('waiting_cli');
        expect(await readFile(path.join(parent, 'base.txt'), 'utf8')).toContain('<<<<<<<');
        expect(h.getState()?.conflictRetries).toBe(1);
        expect(h.getState()?.fixInvocationId).toBe('inv1');
        expect(h.invocationInserts).toHaveLength(2);
        expect(h.invocationInserts[1]!.prompt).toContain(TRUNCATION_RETRY_NOTICE);
        expect(h.invocationInserts[1]!.truncationRetry).toBe(true);
        expect(h.invocationInserts[0]!.truncationRetry).toBe(false);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it('whose prompt only quotes the notice is still retried once, smaller', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        await divergeBase(parent, wt);
        const { h, second } = await fixerRound(parent, det(wt), halfResolve, {
          ...cut,
          prompt: `resolve a diff that quotes:\n${TRUNCATION_RETRY_NOTICE}\nand goes on`,
        });
        expect(second.resolved).toBe(false);
        expect(h.getState()?.conflictRetries).toBe(1);
        expect(h.invocationInserts).toHaveLength(2);
        expect(h.invocationInserts[1]!.truncationRetry).toBe(true);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it('whose prompt already carried the notice, even wrapped, is a spent attempt and keeps the notice', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        await divergeBase(parent, wt);
        const { h, second } = await fixerRound(parent, det(wt), halfResolve, {
          ...cut,
          prompt: `resolve the merge\n\n${TRUNCATION_RETRY_NOTICE}\n\n## Boundary added at dispatch`,
          truncationRetry: true,
        });
        expect(second.resolved).toBe(false);
        expect(h.getState()?.conflictRetries).toBe(2);
        expect(h.invocationInserts).toHaveLength(2);
        expect(h.invocationInserts[1]!.prompt).toContain(TRUNCATION_RETRY_NOTICE);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it('a fixer that finished cleanly still commits its merge, with nothing re-sent', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        await divergeBase(parent, wt);
        const { h, second } = await fixerRound(
          parent,
          det(wt),
          async (dir) => {
            await writeFile(path.join(dir, 'base.txt'), 'resolved\n', 'utf8');
          },
          { endedAt: new Date(), exitCode: 0, errorMessage: null, prompt: 'resolve the merge' },
        );
        expect(second.resolved).toBe(true);
        expect(await git(parent, ['show', 'HEAD:base.txt'])).toBe('resolved\n');
        expect(h.invocationInserts).toHaveLength(1);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });
  });

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

  it('halts without committing, and keeps the recorded tree, while the index holds what a fixer staged', async () => {
    const { parent, wt } = await setupWorktree();
    relocation.holdIndex = true;
    try {
      await divergeBase(parent, wt);
      const { h, second } = await fixerRound(
        parent,
        det(wt),
        async (dir) => {
          await writeFile(path.join(dir, 'base.txt'), 'resolved\n', 'utf8');
          await writeFile(path.join(dir, 'notes.txt'), 'scratch\n', 'utf8');
        },
        { endedAt: new Date(), exitCode: 0 },
      );
      expect(second).toMatchObject({ resolved: false, result: { status: 'failed' } });
      expect(h.getStatus()).toBe('failed');
      expect(h.getState()?.fixBaseline).toBeTruthy();
      expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(0);
    } finally {
      relocation.holdIndex = false;
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

const ROOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PLAN_JSON = '.haive-data/plan.json';
const STATE_RENDER = `${PROJECT_STATE_DIR}/project/render.json`;

function planFiles(childTitle: string): Record<string, string> {
  const plan: PlanMirror = {
    schemaVersion: 2,
    nodes: (
      [
        [ROOT_ID, null, 'Product'],
        [CHILD_ID, ROOT_ID, childTitle],
      ] as const
    ).map(([id, parentId, title], ordinal) => ({
      id,
      parentId,
      ordinal,
      title,
      kind: 'component',
      body: null,
      status: 'todo',
      taskable: false,
    })),
    edges: [],
    codeLinks: [],
  };
  return {
    [PLAN_JSON]: serializePlanMirror(plan),
    '.haive-data/plan.md': renderPlanMarkdownFromMirror(plan),
  };
}

function stateFiles(
  render: Partial<ProjectRender>,
  settings: Record<string, unknown> = {},
): Record<string, string> {
  const record = {
    ...emptyProjectState(),
    render: {
      projectInfo: {},
      framework: null,
      acceptedAgentIds: [],
      customAgentSpecs: [],
      lspLanguages: [],
      ...render,
    },
    settings,
  };
  return Object.fromEntries(
    [...renderProjectState(record)].map(([rel, text]) => [`${PROJECT_STATE_DIR}/${rel}`, text]),
  );
}

async function commitIn(dir: string, files: Record<string, string>, message: string) {
  await writeIn(dir, files);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', message]);
}

const SYNC_USER = '00000000-0000-4000-8000-0000000000a1';
const SYNC_REPO = '00000000-0000-4000-8000-0000000000b1';
const BASE_RENDER: ProjectRender = {
  projectInfo: { name: 'acme', framework: 'drupal', docroot: 'web' },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  lspLanguages: ['css'],
};
const TEAM_RENDER: ProjectRender = {
  ...BASE_RENDER,
  framework: 'drupal11',
  acceptedAgentIds: ['code-reviewer', 'qa-lead'],
};
const PER_INSTALL = {
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
  rtkEnabled: false,
};

/** A jsonb value as Postgres hands it back: object keys by length, then bytes, so a row seeded with
 *  one reads the way a stored one does. */
function jsonb(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonb);
  if (value === null || typeof value !== 'object') return value;
  const byKey = ([a]: [string, unknown], [b]: [string, unknown]) =>
    a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(byKey)
      .map(([key, member]) => [key, jsonb(member)]),
  );
}

/** A repository this install last synced at `record`, in a database holding only what the sync reads. */
function syncFixture(record: { render: ProjectRender; settings: Record<string, unknown> }) {
  const t = schema;
  const fake = createFakeDb({
    repositories: t.repositories,
    projectStateSync: t.projectStateSync,
    projectStateOutbox: t.projectStateOutbox,
    projectStateConflicts: t.projectStateConflicts,
    tasks: t.tasks,
    taskSteps: t.taskSteps,
    onboardingArtifacts: t.onboardingArtifacts,
    cliProviders: t.cliProviders,
    customBundles: t.customBundles,
    customBundleItems: t.customBundleItems,
  });
  const synced = {
    ...emptyProjectState(),
    render: record.render,
    settings: Object.assign(Object.create(null) as Record<string, unknown>, record.settings),
  };
  fake.insert(t.repositories, {
    id: SYNC_REPO,
    userId: SYNC_USER,
    name: 'acme',
    source: 'blank',
    status: 'ready',
    updatedAt: new Date(1000),
    rtkEnabled: null,
    renderContext: jsonb({ ...record.render, ...PER_INSTALL, rtkChoiceRecorded: true }),
    scopeExcludeGlobs: record.settings['scope-exclude-globs'],
  });
  fake.insert(t.projectStateSync, {
    repositoryId: SYNC_REPO,
    baseSnapshot: jsonb(JSON.parse(JSON.stringify(normalizeProjectState(synced)))),
    lastError: null,
    updatedAt: new Date(0),
  });
  return { fake };
}

/** `origin/main` as a ref one commit past the fork that holds `files`: what a fetch brings, with no remote. */
async function originAhead(parent: string, files: Record<string, string>, message: string) {
  await git(parent, ['checkout', '-q', '-b', 'origin-side']);
  await commitIn(parent, files, message);
  await git(parent, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await git(parent, ['checkout', '-q', 'main']);
  await git(parent, ['branch', '-q', '-D', 'origin-side']);
}

// A task branch no longer brings its own edits to Haive's files into the merge (12 puts them back
// first), so the plan and state rules that settle a clash are driven where they still decide: the
// merge of origin/main into main that 00a and the pre-push base sync run.
describe("merge of origin/main: Haive's own files merge before any agent", () => {
  const dispatching = {
    providers: [{ id: 'p1', enabled: true }],
    deps: { enqueueCliInvocation: async () => {} },
  };
  const dispatches = () => vi.mocked(resolveTaskDispatch).mock.calls.length;
  const sync = syncBaseStep as unknown as StepDefinition;

  async function mergeOrigin(
    parent: string,
    over: Partial<StepDefinition> = {},
    state: MergeResolveState | null = null,
  ) {
    const h = makeDb();
    const before = dispatches();
    const out = await resolveMergePhase(
      h.db as never,
      { ...sync, ...over } as StepDefinition,
      mkCurrent(det('/unused', { branchName: 'origin/main' }), { syncAction: 'merge' }, state),
      mkCtx(parent, h.db),
      mkParams(h.db, dispatching),
    );
    return { out, h, dispatched: dispatches() - before };
  }

  it('a merge whose only conflict is plan.json commits with no fixer', async () => {
    const { parent } = await setupWorktree(planFiles('Base'));
    try {
      await originAhead(parent, planFiles('Theirs'), 'plan on origin');
      await commitIn(parent, planFiles('Ours'), 'plan on main');
      const { out, h, dispatched } = await mergeOrigin(parent);
      expect(out.resolved).toBe(true);
      expect(dispatched).toBe(0);
      expect(h.invocationInserts).toEqual([]);
      expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).not.toBe(0);
      expect(await git(parent, ['ls-files', '-u'])).toBe('');
      expect(await git(parent, ['show', `HEAD:${PLAN_JSON}`])).toContain('Theirs');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('a merge whose only conflict is under .haive-data/state/ commits with no fixer', async () => {
    const { parent } = await setupWorktree(stateFiles({}));
    try {
      await originAhead(
        parent,
        stateFiles({ customAgentSpecs: [{ id: 'agent-a', description: 'A' }] }),
        's',
      );
      await commitIn(parent, stateFiles({ framework: 'drupal' }), 'state on main');
      const { out, dispatched } = await mergeOrigin(parent);
      expect(out.resolved).toBe(true);
      expect(dispatched).toBe(0);
      expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).not.toBe(0);
      expect(await git(parent, ['ls-files', '-u'])).toBe('');
      const render = JSON.parse(await git(parent, ['show', `HEAD:${STATE_RENDER}`])) as {
        framework: string;
        customAgentSpecs: unknown[];
      };
      expect(render.framework).toBe('drupal');
      expect(render.customAgentSpecs).toHaveLength(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('a retry that reopens the merge settles plan.json the same way', async () => {
    const { parent } = await setupWorktree(planFiles('Base'));
    try {
      await originAhead(parent, planFiles('Theirs'), 'plan on origin');
      await commitIn(parent, planFiles('Ours'), 'plan on main');
      const state: MergeResolveState = {
        mode: 'same-branch',
        phase: 'resolving',
        baseBranch: 'main',
        featureBranch: 'origin/main',
        mergeDir: parent,
        sandboxMergeDir: parent,
        fixInvocationId: null,
        conflictRetries: 0,
        pendingQuestion: null,
        pushAfterMerge: false,
        merged: false,
        skipReason: null,
        pushed: false,
      };
      const { out, dispatched } = await mergeOrigin(parent, {}, state);
      expect(out.resolved).toBe(true);
      expect(dispatched).toBe(0);
      expect(await git(parent, ['show', `HEAD:${PLAN_JSON}`])).toContain('Theirs');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('a mixed conflict sends the fixer only the other file, with the leave-alone line', async () => {
    const { parent } = await setupWorktree(planFiles('Base'));
    try {
      await originAhead(parent, { ...planFiles('Theirs'), 'base.txt': 'feature-edit\n' }, 'origin');
      await commitIn(parent, { ...planFiles('Ours'), 'base.txt': 'main-edit\n' }, 'main');
      const buildFixPrompt = vi.fn(sync.mergeResolve!.buildFixPrompt);
      const { out, dispatched } = await mergeOrigin(parent, {
        mergeResolve: { ...sync.mergeResolve!, buildFixPrompt },
      });
      expect(out.resolved).toBe(false);
      expect(dispatched).toBe(1);
      expect(buildFixPrompt.mock.calls[0]![0].conflictFiles).toEqual(['base.txt']);
      const call = vi.mocked(resolveTaskDispatch).mock.calls.at(-1);
      const prompt = (call?.[2] as { input: { prompt: string } }).input.prompt;
      expect(prompt).toContain(HAIVE_OWN_FILES_LINE);
      expect(prompt).not.toContain('.haive-data/**');
      expect(await git(parent, ['show', ':3:base.txt'])).toBe('feature-edit\n');
      expect(await git(parent, ['show', `:${PLAN_JSON}`])).toContain('Theirs');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

const GLOBS = `${PROJECT_STATE_DIR}/settings/scope-exclude-globs.json`;
const RTK_VERSION = `${PROJECT_STATE_DIR}/settings/rtk-version.json`;
const REVIEW_DIMS = `${PROJECT_STATE_DIR}/settings/review-dimensions.json`;
const AT_FORK = { 'scope-exclude-globs': ['vendor/**'] };
const BY_AGENT = { 'scope-exclude-globs': ['vendor/**', 'dist/**'] };

/** What `rev` holds at `file`, or null when it holds nothing there. */
async function at(dir: string, rev: string, file: string): Promise<string | null> {
  try {
    return await git(dir, ['show', `${rev}:${file}`]);
  } catch {
    return null;
  }
}
const revOf = async (dir: string, rev = 'HEAD') => (await git(dir, ['rev-parse', rev])).trim();
const putBackEvents = (h: ReturnType<typeof makeDb>) =>
  h.events.filter((e) => e.eventType === PUT_BACK_EVENT);

describe('12 puts back the Haive files a task branch changed, before it lands or is left', () => {
  const dispatching = {
    providers: [{ id: 'p1', enabled: true }],
    deps: { enqueueCliInvocation: async () => {} },
  };

  async function mergePass(
    parent: string,
    wt: string,
    h = makeDb(),
    formValues: Record<string, unknown> = { action: 'merge_remove' },
  ) {
    const out = await resolveMergePhase(
      h.db as never,
      step,
      mkCurrent(det(wt), formValues),
      mkCtx(parent, h.db),
      mkParams(h.db, dispatching),
    );
    return { out, h };
  }
  const keepPass = (parent: string, wt: string, h = makeDb(), action = 'keep') =>
    worktreeCleanupStep.apply(mkCtx(parent, h.db), applyArgs(det(wt), { action }));

  it('C1 same-branch merge_remove: base holds the fork point, the branch carries the revert, the step warns', async () => {
    const { parent, wt } = await setupWorktree(stateFiles({}, AT_FORK));
    try {
      const forked = await revOf(parent);
      await commitIn(wt, stateFiles({}, BY_AGENT), 'agent edits a setting');
      const preRevert = await revOf(wt);
      const { out, h } = await mergePass(parent, wt);
      expect(out.resolved).toBe(true);
      expect(await at(parent, 'main', GLOBS)).toBe(await at(parent, forked, GLOBS));
      expect(await at(parent, 'main', 'feature.txt')).toBe('feature\n');
      expect(await git(parent, ['log', '-1', '--format=%s', 'feature/x'])).toContain('Put back');
      expect(await at(parent, 'feature/x', GLOBS)).toBe(await at(parent, forked, GLOBS));
      expect(h.getWarning()).toContain(GLOBS);
      const [event] = putBackEvents(h);
      expect(event?.payload).toMatchObject({
        paths: [GLOBS],
        preRevertSha: preRevert,
        mergeBase: forked,
        commit: await revOf(wt),
      });
      expect(await git(wt, ['status', '--porcelain'])).toBe('');
      expect(await readFile(path.join(wt, GLOBS), 'utf8')).toBe(await at(parent, forked, GLOBS));
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('C1 cross-branch merge_remove puts them back as well', async () => {
    const { parent, wt } = await setupWorktree(stateFiles({}, AT_FORK));
    try {
      const forked = await revOf(parent);
      await commitIn(wt, stateFiles({}, BY_AGENT), 'agent edits a setting');
      await git(parent, ['checkout', '-q', '-b', 'elsewhere']);
      const h = makeDb();
      const out = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt, { parentBranch: 'elsewhere' }), { action: 'merge_remove' }),
        mkCtx(parent, h.db),
        mkParams(h.db, dispatching),
      );
      expect(out.resolved).toBe(true);
      expect(await at(parent, 'main', GLOBS)).toBe(await at(parent, forked, GLOBS));
      expect(h.getWarning()).toContain(GLOBS);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('C2 base changed another unit of the same file after the fork: the merged file holds base only', async () => {
    const { parent, wt } = await setupWorktree(stateFiles({}));
    try {
      await commitIn(
        wt,
        stateFiles({ customAgentSpecs: [{ id: 'agent-a', description: 'A' }] }),
        'agent edits a unit',
      );
      await commitIn(parent, stateFiles({ framework: 'drupal' }), 'state on main');
      const { out } = await mergePass(parent, wt);
      expect(out.resolved).toBe(true);
      expect(await git(parent, ['ls-files', '-u'])).toBe('');
      const render = JSON.parse((await at(parent, 'main', STATE_RENDER))!) as {
        framework: string;
        customAgentSpecs: unknown[];
      };
      expect(render.framework).toBe('drupal');
      expect(render.customAgentSpecs).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('C3 create_pr: the branch is pushed with the files put back', async () => {
    const { parent, wt } = await setupWorktree(stateFiles({}, AT_FORK));
    const bare = await pushParentMainToOrigin(parent);
    try {
      const forked = await revOf(parent);
      await commitIn(wt, stateFiles({}, BY_AGENT), 'agent edits a setting');
      const h = makeDb();
      const detected = det(wt, {
        hasOrigin: true,
        originUrl: `file://${bare}`,
        prWorkflowAvailable: true,
      });
      const out = await worktreeCleanupStep.apply(
        mkCtx(parent, h.db),
        applyArgs(detected, {
          action: 'create_pr',
          prCredentialId: 'cred-1',
          prBaseBranch: 'main',
          prTitle: 'Task',
        }),
      );
      expect(out.prUrl).toBe('https://forge.test/pr/1');
      expect(await at(bare, 'feature/x', GLOBS)).toBe(await at(parent, forked, GLOBS));
      expect(await revOf(bare, 'feature/x')).toBe(await revOf(parent, 'feature/x'));
      expect(h.getWarning()).toContain(GLOBS);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('C3 create_pr leaves alone a record that local base holds ahead of origin', async () => {
    const { parent, wt } = await setupWorktree();
    const bare = await pushParentMainToOrigin(parent);
    try {
      await commitIn(parent, stateFiles({}, AT_FORK), 'the record, not yet pushed');
      await git(wt, ['merge', '-q', '--no-edit', 'main']);
      await commitIn(wt, stateFiles({}, BY_AGENT), 'agent edits a setting');
      const h = makeDb();
      const detected = det(wt, {
        hasOrigin: true,
        originUrl: `file://${bare}`,
        prWorkflowAvailable: true,
      });
      await worktreeCleanupStep.apply(
        mkCtx(parent, h.db),
        applyArgs(detected, {
          action: 'create_pr',
          prCredentialId: 'cred-1',
          prBaseBranch: 'main',
          prTitle: 'Task',
        }),
      );
      expect(await at(bare, 'feature/x', GLOBS)).toBe(await at(parent, 'main', GLOBS));
      expect(await revOf(bare, 'feature/x:.haive-data/state')).toBe(
        await revOf(parent, 'main:.haive-data/state'),
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('a .haive-data link halts the merge before anything merges, naming it', async () => {
    const { parent, wt } = await setupWorktree(stateFiles({}, AT_FORK));
    try {
      await commitIn(wt, stateFiles({}, BY_AGENT), 'agent edits a setting');
      await rm(path.join(wt, '.haive-data'), { recursive: true });
      await symlink(parent, path.join(wt, '.haive-data'));
      const { out, h } = await mergePass(parent, wt);
      expect(out.resolved).toBe(false);
      if (!out.resolved) {
        expect(out.result.status).toBe('failed');
        if (out.result.status === 'failed') {
          expect(out.result.error).toContain('.haive-data is a link in the worktree');
        }
      }
      expect(h.getStatus()).toBe('failed');
      expect(await at(parent, 'main', 'feature.txt')).toBeNull();
      expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).not.toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('C4 base has no state directory: a record the branch adds does not land, and the sync finds none', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await commitIn(wt, stateFiles({ framework: 'drupal' }, BY_AGENT), 'agent adds a record');
      const { out } = await mergePass(parent, wt);
      expect(out.resolved).toBe(true);
      expect(await git(parent, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain(
        PROJECT_STATE_DIR,
      );
      const { fake } = syncFixture({ render: BASE_RENDER, settings: AT_FORK });
      const result = await syncProjectStateFromCheckout(fake.db as never, {
        repositoryId: SYNC_REPO,
        repoPath: parent,
      });
      expect(result.outcome).toBe('absent');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('C5 a second pass makes no commit, and the pass after a Retry shows the warning again', async () => {
    const { parent, wt } = await setupWorktree(stateFiles({}, AT_FORK));
    try {
      await commitIn(wt, stateFiles({}, BY_AGENT), 'agent edits a setting');
      const h = makeDb();
      await keepPass(parent, wt, h);
      const tip = await revOf(parent, 'feature/x');
      expect(h.getWarning()).toContain(GLOBS);
      h.clearWarning();
      await keepPass(parent, wt, h);
      expect(await revOf(parent, 'feature/x')).toBe(tip);
      expect(putBackEvents(h)).toHaveLength(1);
      expect(h.getWarning()).toContain(GLOBS);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('C5 merge_remove: the pass after a Retry, with the merge landed, shows the warning again', async () => {
    const { parent, wt } = await setupWorktree(stateFiles({}, AT_FORK));
    try {
      await commitIn(wt, stateFiles({}, BY_AGENT), 'agent edits a setting');
      const h = makeDb();
      const ctx = mkCtx(parent, h.db);
      const values = { action: 'merge_remove', deleteBranch: false };
      const merged = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), values),
        ctx,
        mkParams(h.db, dispatching),
      );
      expect(merged.resolved).toBe(true);
      expect(h.getWarning()).toContain(GLOBS);
      h.clearWarning();
      // A Retry keeps the merge state, so the next pass goes straight to apply.
      const again = await resolveMergePhase(
        h.db as never,
        step,
        mkCurrent(det(wt), values, h.getState()),
        ctx,
        mkParams(h.db, dispatching),
      );
      expect(again.resolved).toBe(true);
      await worktreeCleanupStep.apply(ctx, applyArgs(det(wt), values));
      expect(h.getWarning()).toContain(GLOBS);
      expect(putBackEvents(h)).toHaveLength(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('C6 files deleted, made executable and moved out: the state tree at the tip is the fork point', async () => {
    const seed = stateFiles(
      {},
      { ...AT_FORK, 'rtk-version': '1.2.3', 'review-dimensions': ['security'] },
    );
    const { parent, wt } = await setupWorktree(seed);
    try {
      const forked = await revOf(parent);
      await rm(path.join(wt, GLOBS));
      await chmod(path.join(wt, RTK_VERSION), 0o755);
      await mkdir(path.join(wt, 'moved'), { recursive: true });
      await rename(path.join(wt, REVIEW_DIMS), path.join(wt, 'moved', 'review-dimensions.json'));
      await git(wt, ['add', '-A']);
      await git(wt, ['commit', '-m', 'agent edits three files']);
      expect(await revOf(wt, 'HEAD:.haive-data/state')).not.toBe(
        await revOf(parent, `${forked}:.haive-data/state`),
      );
      await keepPass(parent, wt);
      expect(await revOf(parent, 'feature/x:.haive-data/state')).toBe(
        await revOf(parent, `${forked}:.haive-data/state`),
      );
      expect(await at(parent, 'feature/x', 'moved/review-dimensions.json')).not.toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('C7 knowledge base, learnings and dependency ownership stay as the branch made them', async () => {
    const owned = {
      [`${KB_DIR}/overview.md`]: 'kb v1\n',
      [`${LEARNINGS_DIR}/l1.md`]: 'learning v1\n',
      '.haive-data/dependency-ownership.json': '{"ownedPaths":[]}\n',
      '.haive-data/environment.json': '{}\n',
    };
    const { parent, wt } = await setupWorktree({ ...stateFiles({}, AT_FORK), ...owned });
    try {
      const edited = Object.fromEntries(Object.keys(owned).map((f) => [f, `${f} edited\n`]));
      await commitIn(wt, { ...stateFiles({}, BY_AGENT), ...edited }, 'agent edits');
      await keepPass(parent, wt);
      expect(await at(parent, 'feature/x', GLOBS)).toBe(await at(parent, 'main', GLOBS));
      for (const [file, body] of Object.entries(edited)) {
        expect(await at(parent, 'feature/x', file), file).toBe(body);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('C8 a plan.json edit on the branch is put back, so the merge has no plan conflict', async () => {
    const { parent, wt } = await setupWorktree(planFiles('Base'));
    try {
      await commitIn(wt, planFiles('Theirs'), 'plan on feature');
      await commitIn(parent, planFiles('Ours'), 'plan on main');
      const { out, h } = await mergePass(parent, wt);
      expect(out.resolved).toBe(true);
      expect(h.invocationInserts).toEqual([]);
      expect(await git(parent, ['ls-files', '-u'])).toBe('');
      expect(await at(parent, 'main', PLAN_JSON)).toContain('Ours');
      expect(await at(parent, 'main', PLAN_JSON)).not.toContain('Theirs');
      expect(await at(parent, 'main', 'feature.txt')).toBe('feature\n');
      expect(h.getWarning()).toContain(PLAN_JSON);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('C8 a mixed conflict sends the fixer only the other file, and plan.json is already base’s', async () => {
    const { parent, wt } = await setupWorktree(planFiles('Base'));
    try {
      await commitIn(wt, { ...planFiles('Theirs'), 'base.txt': 'feature-edit\n' }, 'feature');
      await commitIn(parent, { ...planFiles('Ours'), 'base.txt': 'main-edit\n' }, 'main');
      const buildFixPrompt = vi.fn(step.mergeResolve!.buildFixPrompt);
      const h = makeDb();
      const out = await resolveMergePhase(
        h.db as never,
        { ...step, mergeResolve: { ...step.mergeResolve!, buildFixPrompt } } as StepDefinition,
        mkCurrent(det(wt), { action: 'merge_remove' }),
        mkCtx(parent, h.db),
        mkParams(h.db, dispatching),
      );
      expect(out.resolved).toBe(false);
      expect(buildFixPrompt.mock.calls[0]![0].conflictFiles).toEqual(['base.txt']);
      expect(await git(parent, ['show', ':3:base.txt'])).toBe('feature-edit\n');
      expect(await git(parent, ['show', `:${PLAN_JSON}`])).toContain('Ours');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  describe('C9 with the project state sync that follows a same-branch merge', () => {
    it('leaves repositories.render_context and scope_exclude_globs as they were', async () => {
      const { parent, wt } = await setupWorktree(stateFiles(BASE_RENDER, AT_FORK));
      try {
        const { fake } = syncFixture({ render: BASE_RENDER, settings: AT_FORK });
        const repoArgs = { repositoryId: SYNC_REPO, repoPath: parent };
        // The fixture is coherent: the fork point's files are what the sync last saw.
        expect((await syncProjectStateFromCheckout(fake.db as never, repoArgs)).outcome).toBe(
          'unchanged',
        );
        const columns = () => {
          const row = fake.rows(schema.repositories).find((r) => r.id === SYNC_REPO)!;
          return JSON.stringify([row.renderContext, row.scopeExcludeGlobs]);
        };
        const before = columns();
        await commitIn(wt, stateFiles(TEAM_RENDER, BY_AGENT), 'agent edits the record');
        const { out } = await mergePass(parent, wt);
        expect(out.resolved).toBe(true);
        const synced = await syncProjectStateFromCheckout(fake.db as never, repoArgs);
        expect(columns()).toBe(before);
        expect(synced.outcome).toBe('unchanged');
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });
  });

  it.each(['keep', 'remove_only'])(
    'C11 %s leaves the branch with the files put back',
    async (action) => {
      const { parent, wt } = await setupWorktree(stateFiles({}, AT_FORK));
      try {
        const forked = await revOf(parent);
        await commitIn(wt, stateFiles({}, BY_AGENT), 'agent edits a setting');
        const h = makeDb();
        const out = await keepPass(parent, wt, h, action);
        expect(await at(parent, 'feature/x', GLOBS)).toBe(await at(parent, forked, GLOBS));
        expect(h.getWarning()).toContain(GLOBS);
        // The worktree matched the new tip, so removing it deleted nothing: remove_only took it away.
        expect(out.removed).toBe(action === 'remove_only');
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  it('C12 an uncommitted edit to a Haive file survives, and so does one to any other file', async () => {
    const seed = stateFiles({}, { ...AT_FORK, 'rtk-version': '1.2.3' });
    const { parent, wt } = await setupWorktree(seed);
    try {
      const forked = await revOf(parent);
      await commitIn(
        wt,
        stateFiles({}, { 'scope-exclude-globs': ['vendor/**', 'dist/**'], 'rtk-version': '2.0.0' }),
        'agent edits two settings',
      );
      await writeIn(wt, { [RTK_VERSION]: '"3.0.0"\n', 'feature.txt': 'feature, edited\n' });
      await keepPass(parent, wt);
      expect(await at(parent, 'feature/x', GLOBS)).toBe(await at(parent, forked, GLOBS));
      expect(await at(parent, 'feature/x', RTK_VERSION)).toBe(
        await at(parent, forked, RTK_VERSION),
      );
      expect(await readFile(path.join(wt, GLOBS), 'utf8')).toBe(await at(parent, forked, GLOBS));
      expect(await readFile(path.join(wt, RTK_VERSION), 'utf8')).toBe('"3.0.0"\n');
      expect(await readFile(path.join(wt, 'feature.txt'), 'utf8')).toBe('feature, edited\n');
      expect((await git(wt, ['status', '--porcelain'])).split('\n').filter(Boolean).sort()).toEqual(
        [` M ${RTK_VERSION}`, ' M feature.txt'].sort(),
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  describe('C13 which passes run it', () => {
    const hook = vi.fn(async () => [] as string[]);
    const spied = {
      ...step,
      mergeResolve: { ...step.mergeResolve!, putBackBeforeMerge: hook },
    } as StepDefinition;
    beforeEach(() => hook.mockClear());
    const baseSyncState = (parent: string): MergeResolveState => ({
      mode: 'same-branch',
      phase: 'pending',
      baseBranch: 'main',
      featureBranch: 'origin/main',
      mergeDir: parent,
      sandboxMergeDir: parent,
      fixInvocationId: null,
      conflictRetries: 0,
      pendingQuestion: null,
      pushAfterMerge: false,
      merged: false,
      skipReason: null,
      pushed: false,
      mergeStage: 'base-sync',
      baseSyncRounds: 1,
    });

    it('only 12 sets it, not 00a-sync-base and not 13-onboarding-push', () => {
      expect(step.mergeResolve?.putBackBeforeMerge).toBeTypeOf('function');
      expect(syncBaseStep.mergeResolve?.putBackBeforeMerge).toBeUndefined();
      expect(onboardingPushStep.mergeResolve?.putBackBeforeMerge).toBeUndefined();
    });

    it('the feature merge calls it once, with the branch, its base and its worktree', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        const h = makeDb();
        await resolveMergePhase(
          h.db as never,
          spied,
          mkCurrent(det(wt), { action: 'merge_remove' }),
          mkCtx(parent, h.db),
          mkParams(h.db, dispatching),
        );
        expect(hook).toHaveBeenCalledTimes(1);
        expect(hook).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: 'main',
            featureBranch: 'feature/x',
            worktreePath: wt,
          }),
        );
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it('the base-sync round of 12 does not call it', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        await originAhead(parent, { 'origin.txt': 'origin\n' }, 'origin moved');
        const h = makeDb();
        const out = await resolveMergePhase(
          h.db as never,
          spied,
          mkCurrent(det(wt), { action: 'merge_remove' }, baseSyncState(parent)),
          mkCtx(parent, h.db),
          mkParams(h.db, dispatching),
        );
        expect(out.resolved).toBe(true);
        expect(await at(parent, 'main', 'origin.txt')).toBe('origin\n');
        expect(hook).not.toHaveBeenCalled();
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it('a pass that finds the feature merge open does not call it, and leaves the tip alone', async () => {
      const { parent, wt } = await setupWorktree();
      try {
        await divergeBase(parent, wt);
        await gitCode(parent, ['merge', '--no-ff', 'feature/x', '-m', 'Merge feature/x']);
        expect(await gitCode(parent, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(0);
        const tip = await revOf(parent, 'feature/x');
        const h = makeDb();
        const state: MergeResolveState = {
          ...baseSyncState(parent),
          featureBranch: 'feature/x',
          phase: 'resolving',
          mergeStage: 'feature',
          baseSyncRounds: 0,
        };
        await resolveMergePhase(
          h.db as never,
          spied,
          mkCurrent(det(wt), { action: 'merge_remove' }, state),
          mkCtx(parent, h.db),
          mkParams(h.db, dispatching),
        );
        expect(hook).not.toHaveBeenCalled();
        expect(await revOf(parent, 'feature/x')).toBe(tip);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });
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
        // The warning re-derived from what the pass recorded of the Haive files it put back: nothing.
        select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }),
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

describe('12 worktree cleanup with uncommitted changes (real git)', () => {
  let spy: { mockRestore: () => void };
  beforeEach(() => {
    spy = vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
  });
  afterEach(() => spy.mockRestore());

  const exists = (p: string) =>
    lstat(p).then(
      () => true,
      () => false,
    );
  // A gitfile that names nothing: git refuses the tree, so nothing can be said about it.
  const breakGitfile = (wt: string) =>
    writeFile(path.join(wt, '.git'), 'gitdir: /nonexistent/haive-gitdir\n', 'utf8');

  it('keeps the worktree under the defaults an auto-submit sends', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await leaveUncommitted(wt);
      const detected = await worktreeCleanupStep.detect!(detectCtx(parent, wt));
      const schema = formOf(detectCtx(parent, wt), detected);
      const validated = validateFormValues(schema, extractFormDefaults(schema));
      if (!validated.success) throw new Error(validated.issues.join('; '));
      const { applyOut } = await mergeThenApply(parent, detected, validated.data);
      expect(applyOut?.removed).toBe(false);
      expect(applyOut?.message).toContain('kept');
      expect(applyOut?.message).toContain('2 uncommitted changes');
      expect(await readFile(path.join(wt, 'feature.txt'), 'utf8')).toBe('feature, edited\n');
      expect(await readFile(path.join(wt, 'learning notes.md'), 'utf8')).toBe('not committed\n');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('remove_only keeps a dirty worktree unless the box is ticked', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await leaveUncommitted(wt);
      const { applyOut } = await mergeThenApply(parent, det(wt), { action: 'remove_only' });
      expect(applyOut?.removed).toBe(false);
      expect(applyOut?.message).toContain('kept');
      expect(applyOut?.message).toContain('2 uncommitted changes');
      expect(await readFile(path.join(wt, 'feature.txt'), 'utf8')).toBe('feature, edited\n');
      expect(await readFile(path.join(wt, 'learning notes.md'), 'utf8')).toBe('not committed\n');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('remove_only removes a dirty worktree once the box is ticked', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await leaveUncommitted(wt);
      const { applyOut } = await mergeThenApply(parent, det(wt), {
        action: 'remove_only',
        discardUncommitted: true,
      });
      expect(applyOut?.removed).toBe(true);
      expect(await exists(wt)).toBe(false);
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x'])).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('merge_remove merges a dirty worktree and keeps it unless the box is ticked', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await leaveUncommitted(wt);
      const { applyOut, state } = await mergeThenApply(parent, det(wt), {
        action: 'merge_remove',
        deleteBranch: true,
      });
      expect(state?.merged).toBe(true);
      expect(applyOut).toMatchObject({ merged: true, removed: false, branchDeleted: false });
      expect(applyOut?.message).toContain('2 uncommitted changes');
      expect(await gitCode(parent, ['show', 'main:feature.txt'])).toBe(0);
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x'])).toBe(0);
      expect(await readFile(path.join(wt, 'feature.txt'), 'utf8')).toBe('feature, edited\n');
      expect(await readFile(path.join(wt, 'learning notes.md'), 'utf8')).toBe('not committed\n');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('merge_remove removes a dirty worktree and deletes the branch once the box is ticked', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await leaveUncommitted(wt);
      const { applyOut } = await mergeThenApply(parent, det(wt), {
        action: 'merge_remove',
        deleteBranch: true,
        discardUncommitted: true,
      });
      expect(applyOut).toMatchObject({ merged: true, removed: true, branchDeleted: true });
      expect(await exists(wt)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('keeps a worktree git cannot read unless the box is ticked', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await breakGitfile(wt);
      const kept = await mergeThenApply(parent, det(wt), { action: 'remove_only' });
      expect(kept.applyOut?.removed).toBe(false);
      expect(kept.applyOut?.message).toContain('kept');
      expect(await exists(wt)).toBe(true);
      const discarded = await mergeThenApply(parent, det(wt), {
        action: 'remove_only',
        discardUncommitted: true,
      });
      expect(discarded.applyOut?.removed).toBe(true);
      expect(await exists(wt)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('a worktree that is already gone holds nothing to lose', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await git(parent, ['worktree', 'remove', '--force', wt]);
      const detected = await worktreeCleanupStep.detect!(detectCtx(parent, wt));
      expect(detected.uncommitted).toEqual({ count: 0, paths: [] });
      const { applyOut } = await mergeThenApply(parent, detected, { action: 'remove_only' });
      expect(applyOut?.removed).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('detect lists what git reports, an untracked file and a name with a space included', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await leaveUncommitted(wt);
      const detected = await worktreeCleanupStep.detect!(detectCtx(parent, wt));
      expect(detected.uncommitted).toEqual({
        count: 2,
        paths: ['feature.txt', 'learning notes.md'],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('detect lists 20 paths at most and still reports the total', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const many = Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`file ${String(i).padStart(2, '0')}.txt`, 'x\n']),
      );
      await writeIn(wt, { 'feature.txt': 'feature, edited\n', ...many });
      const { uncommitted } = await worktreeCleanupStep.detect!(detectCtx(parent, wt));
      expect(uncommitted?.count).toBe(26);
      expect(uncommitted?.paths).toHaveLength(20);
      expect(uncommitted?.paths[0]).toBe('feature.txt');
      expect(uncommitted?.paths.at(-1)).toBe('file 18.txt');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('detect records a clean worktree as zero', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const detected = await worktreeCleanupStep.detect!(detectCtx(parent, wt));
      expect(detected.uncommitted).toEqual({ count: 0, paths: [] });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('detect lists the Haive files the branch changed, and the form says so before the action', async () => {
    const { parent, wt } = await setupWorktree(stateFiles({}, AT_FORK));
    try {
      await commitIn(wt, stateFiles({}, BY_AGENT), 'agent edits a setting');
      const detected = await worktreeCleanupStep.detect!(detectCtx(parent, wt));
      expect(detected.projectionEdits).toEqual([GLOBS]);
      expect(await revOf(parent, 'feature/x')).toBe(await revOf(wt));
      const fields = formOf(detectCtx(parent, wt), detected).fields;
      const note = fields.find((f) => f.id === 'projectionEditsNote');
      expect(note).toMatchObject({ type: 'note', variant: 'warning' });
      expect((note as { body: string }).body).toContain(`\`${GLOBS}\``);
      const ids = fields.map((f) => f.id);
      expect(ids.indexOf('projectionEditsNote')).toBeLessThan(ids.indexOf('action'));
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('detect lists none for a branch that changed none, and the form has no note', async () => {
    const { parent, wt } = await setupWorktree(stateFiles({}, AT_FORK));
    try {
      const detected = await worktreeCleanupStep.detect!(detectCtx(parent, wt));
      expect(detected.projectionEdits).toEqual([]);
      const ids = formOf(detectCtx(parent, wt), detected).fields.map((f) => f.id);
      expect(ids).not.toContain('projectionEditsNote');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('detect records a worktree git cannot read as unknown, never as clean', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await breakGitfile(wt);
      const detected = await worktreeCleanupStep.detect!(detectCtx(parent, wt));
      expect(detected.uncommitted).toBeNull();
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

  it('defaults to keep and offers to delete the uncommitted changes with the worktree', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `dir/file ${i}.txt`);
    const schema = formOf(
      stubCtx(''),
      det('/ws/.haive/worktrees/feature-x', { uncommitted: { count: 23, paths } }),
    );
    expect((schema.fields.find((f) => f.id === 'action') as { default?: string }).default).toBe(
      'keep',
    );
    const note = schema.fields.find((f) => f.id === 'uncommittedNote') as {
      body?: string;
      variant?: string;
    };
    expect(note.variant).toBe('warning');
    expect(note.body).toContain('`dir/file 0.txt`');
    expect(note.body).toContain('`dir/file 19.txt`');
    expect(note.body).toContain('and 3 more');
    expect(schema.fields.find((f) => f.id === 'discardUncommitted')).toMatchObject({
      type: 'checkbox',
      label: 'Delete the 23 uncommitted changes with the worktree',
      default: false,
      visibleWhen: { field: 'action', in: ['merge_remove', 'remove_only'] },
    });
    expect(extractFormDefaults(schema)).toMatchObject({
      action: 'keep',
      discardUncommitted: false,
    });
  });

  it('defaults to keep as well when the worktree could not be checked', () => {
    const schema = formOf(
      stubCtx(''),
      det('/ws/.haive/worktrees/feature-x', { uncommitted: null }),
    );
    expect((schema.fields.find((f) => f.id === 'action') as { default?: string }).default).toBe(
      'keep',
    );
    expect(schema.fields.find((f) => f.id === 'uncommittedNote')).toMatchObject({
      variant: 'warning',
    });
    expect(schema.fields.find((f) => f.id === 'discardUncommitted')).toMatchObject({
      type: 'checkbox',
      default: false,
    });
  });

  it('puts a path holding backticks in a code span they cannot close', () => {
    const schema = formOf(
      stubCtx(''),
      det('/ws/.haive/worktrees/feature-x', { uncommitted: { count: 1, paths: ['a`b.txt'] } }),
    );
    const note = schema.fields.find((f) => f.id === 'uncommittedNote') as { body?: string };
    expect(note.body).toContain('`` a`b.txt ``');
  });

  it('is the form it always was when the worktree is clean', () => {
    const schema = formOf(
      stubCtx(''),
      det('/ws/.haive/worktrees/feature-x', {
        parentBranch: 'develop',
        hasOrigin: true,
        originUrl: 'https://github.com/o/r.git',
        boundCredentialId: 'c1',
        credentials: [{ id: 'c1', label: 'gh', host: 'github.com', provider: 'github' }],
        prWorkflowAvailable: true,
        taskTitle: 'Add thing',
        taskDescription: 'Does the thing',
      }),
    );
    expect(schema.fields).toEqual([
      {
        type: 'note',
        id: 'branchMismatchNote',
        label: 'Cross-branch merge',
        body: 'The parent checkout is on **develop**, not the base **main**. Haive will merge **feature/x** into **main** via a temporary worktree (your current checkout stays untouched), then optionally push **main** to origin.',
        variant: 'info',
      },
      {
        type: 'radio',
        id: 'action',
        label: 'What should happen to the worktree?',
        options: [
          {
            value: 'merge_remove',
            label: 'Merge feature/x into main, then remove the worktree',
          },
          {
            value: 'create_pr',
            label:
              'Open a pull request from feature/x into main (keep the worktree until it merges)',
          },
          {
            value: 'remove_only',
            label: 'Remove the worktree, keep the branch',
          },
          {
            value: 'keep',
            label: 'Keep the worktree',
          },
        ],
        default: 'merge_remove',
        required: true,
      },
      {
        type: 'checkbox',
        id: 'squashMerge',
        label: 'Squash feature/x into a single commit on main',
        description:
          'main gets ONE commit for this task instead of every commit the task made along the way (one per DAG issue, plus a merge commit each, plus a commit per fix round). The changes are identical either way; only the history differs. Untick to keep the full history on main.',
        default: true,
        visibleWhen: {
          field: 'action',
          equals: 'merge_remove',
        },
      },
      {
        type: 'checkbox',
        id: 'deleteBranch',
        label: 'Delete the feature/x branch after merging (safe — only if fully merged)',
        default: true,
        visibleWhen: {
          field: 'action',
          equals: 'merge_remove',
        },
      },
      {
        type: 'note',
        id: 'removeOnlyNote',
        label: 'Deleting the branch manually',
        body: 'The **feature/x** branch is kept. To delete it manually (it may have unmerged commits), open the [repository terminal](/repos/r1/terminal) and run `git branch -D feature/x`.',
        variant: 'info',
        visibleWhen: {
          field: 'action',
          equals: 'remove_only',
        },
      },
      {
        type: 'text',
        id: 'prTitle',
        label: 'Pull request title',
        default: 'Add thing',
        required: true,
        visibleWhen: {
          field: 'action',
          equals: 'create_pr',
        },
      },
      {
        type: 'textarea',
        id: 'prBody',
        label: 'Pull request description',
        default: 'Does the thing',
        rows: 6,
        visibleWhen: {
          field: 'action',
          equals: 'create_pr',
        },
      },
      {
        type: 'text',
        id: 'prBaseBranch',
        label: 'Base branch (the PR merges into this)',
        default: 'main',
        required: true,
        visibleWhen: {
          field: 'action',
          equals: 'create_pr',
        },
      },
      {
        type: 'select',
        id: 'prCredentialId',
        label: 'Forge credential to open the PR with',
        description:
          'Only credentials matching this forge are listed (by provider, or auto-detected from the host). The token must be able to push the branch and open pull/merge requests.',
        options: [
          {
            value: 'c1',
            label: 'gh (github.com — github)',
          },
        ],
        default: 'c1',
        visibleWhen: {
          field: 'action',
          equals: 'create_pr',
        },
      },
      {
        type: 'radio',
        id: 'finalizeMode',
        label: 'When the PR merges',
        options: [
          {
            value: 'auto',
            label: 'Automatically finish this task (reap the worktree)',
          },
          {
            value: 'manual',
            label: 'Wait for me to click Finalize',
          },
        ],
        default: 'auto',
        visibleWhen: {
          field: 'action',
          equals: 'create_pr',
        },
      },
      {
        type: 'checkbox',
        id: 'pushBase',
        label: 'Push main to origin (https://github.com/o/r.git) after merging',
        default: false,
        visibleWhen: {
          field: 'action',
          equals: 'merge_remove',
        },
      },
      {
        type: 'select',
        id: 'credentialId',
        label: 'Credential to push with',
        description:
          'Used only for this push; the token is never written to git config. Choose "manually" for SSH or public remotes.',
        options: [
          {
            value: 'c1',
            label: 'gh (github.com)',
          },
          {
            value: '',
            label: 'Authenticate manually (no stored credential)',
          },
        ],
        default: 'c1',
        visibleWhen: {
          field: 'action',
          equals: 'merge_remove',
        },
      },
      {
        type: 'checkbox',
        id: 'setUpstream',
        label: 'Set upstream (-u) so future pushes default to origin',
        default: true,
        visibleWhen: {
          field: 'action',
          equals: 'merge_remove',
        },
      },
    ]);
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

  it('deletes a merged DAG issue branch that a same-named tag shadows, and keeps the tag', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await git(wt, ['checkout', '-b', 'feature/x--iss-1']);
      await writeFile(path.join(wt, 'iss1.txt'), '1\n', 'utf8');
      await git(wt, ['add', '-A']);
      await git(wt, ['commit', '-m', 'ISS-1: work']);
      await git(wt, ['checkout', 'feature/x']);
      await git(wt, ['merge', '--no-ff', '--no-edit', 'feature/x--iss-1']);
      // `%(refname:short)` prints the branch as `heads/feature/x--iss-1` beside this tag.
      await git(parent, ['tag', 'feature/x--iss-1', 'feature/x--iss-1']);

      const { applyOut } = await mergeThenApply(parent, det(wt), {
        action: 'merge_remove',
        deleteBranch: true,
      });
      expect(applyOut?.message).toContain('1 merged DAG issue branch');
      expect(
        await gitCode(parent, ['rev-parse', '--verify', 'refs/heads/feature/x--iss-1']),
      ).not.toBe(0);
      expect(await gitCode(parent, ['rev-parse', '--verify', 'refs/tags/feature/x--iss-1'])).toBe(
        0,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const sandbox = vi.hoisted(() => ({ list: vi.fn(async (): Promise<string[] | null> => []) }));
vi.mock('../src/sandbox/sandbox-kill.js', () => ({ listCliSandboxesForTask: sandbox.list }));
import {
  taskMayRunWithoutRepository,
  taskScratchSubpath,
  taskTypeAllowsNoRepository,
  taskWasCreatedRepoLess,
} from '../src/repo/scratch-workspace.js';

// A null `tasks.repository_id` has TWO meanings — a task deliberately created without one, and
// a task whose repository was deleted out from under it (the column is ON DELETE SET NULL).
// Only the first is a mode; the second must keep failing loudly, which is why this is an
// allowlist rather than a blanket "null is fine".
describe('taskTypeAllowsNoRepository', () => {
  it('allows the KB author, whose article is meant to be repo-independent', () => {
    expect(taskTypeAllowsNoRepository('kb_author')).toBe(true);
  });

  it('refuses every type whose work IS a repository', () => {
    for (const type of ['workflow', 'onboarding', 'run_app', 'plan_build', 'plan_chat']) {
      expect(taskTypeAllowsNoRepository(type)).toBe(false);
    }
  });
});

// The allowlist keys on TYPE, so for kb_author it cannot separate "created without a repo" from
// "had one until the repository was deleted" — and the second is the torn state the hard failure
// exists for. Deleting a repository nulls the FK and leaves TERMINAL tasks alone, so a failed
// anchored task retries straight into the repo-less branch.
describe('taskWasCreatedRepoLess', () => {
  it('reads the recorded choice, not the current column', () => {
    expect(taskWasCreatedRepoLess({ anchorRepositoryId: null })).toBe(true);
    expect(taskWasCreatedRepoLess({ anchorRepositoryId: 'r1' })).toBe(false);
  });

  it('reads an absent record as ANCHORED, not as unknown', () => {
    // `enrichSchema.repositoryId` was a REQUIRED uuid until this branch, so a kb_author task
    // created before the record necessarily had a repository. A lenient default here would admit
    // exactly the tasks the old schema proves were anchored — the opposite of the usual
    // presence-bit shape, because the legacy state is not ambiguous.
    expect(taskWasCreatedRepoLess({ globalKbEntryId: 'e1' })).toBe(false);
    expect(taskWasCreatedRepoLess(null)).toBe(false);
    expect(taskWasCreatedRepoLess(undefined)).toBe(false);
    expect(taskWasCreatedRepoLess('not an object')).toBe(false);
  });

  it('separates a recorded null from an absent key', () => {
    // The two are the same JSON value on read; only the KEY's presence tells them apart, and
    // they mean OPPOSITE things.
    expect(taskWasCreatedRepoLess({ anchorRepositoryId: null })).toBe(true);
    expect(taskWasCreatedRepoLess({})).toBe(false);
  });
});

// Three call sites reach this decision by different routes — resolveTaskContext when the task
// runs, and both mount resolvers, one of which the human Terminal calls WITHOUT going through the
// task context. Splitting the two halves across them is how the deleted-anchor case survived
// being closed in one of them.
describe('taskMayRunWithoutRepository', () => {
  it('allows a task actually created without a repository', () => {
    expect(
      taskMayRunWithoutRepository({ type: 'kb_author', metadata: { anchorRepositoryId: null } }),
    ).toBe(true);
  });

  it('refuses a task whose recorded anchor is gone', () => {
    expect(
      taskMayRunWithoutRepository({ type: 'kb_author', metadata: { anchorRepositoryId: 'r1' } }),
    ).toBe(false);
  });

  it('refuses a task that predates the record, which the old schema proves was anchored', () => {
    expect(taskMayRunWithoutRepository({ type: 'kb_author', metadata: null })).toBe(false);
    expect(taskMayRunWithoutRepository({ type: 'kb_author', metadata: {} })).toBe(false);
  });

  it('refuses every type whose work IS a repository, recorded or not', () => {
    for (const type of ['workflow', 'onboarding', 'run_app']) {
      expect(taskMayRunWithoutRepository({ type, metadata: { anchorRepositoryId: null } })).toBe(
        false,
      );
    }
  });
});

describe('taskScratchSubpath', () => {
  it('sits under the user directory, where no repository UUID can collide with it', () => {
    expect(taskScratchSubpath('u1', 't1')).toBe('u1/_scratch/t1');
  });

  it('is per task, so two repo-less tasks never share a working directory', () => {
    expect(taskScratchSubpath('u1', 't1')).not.toBe(taskScratchSubpath('u1', 't2'));
  });
});

// `markTaskCompleted` stamps the status FIRST and reaps LAST, so a worker that exits between the
// two abandons the directory: a `completed` task is never advanced again, so redelivery cannot
// recover it and nothing else in the tree looks at these. The sweep is the reconciliation, and
// what it must never do is take a workspace from a task that is still using one.
describe('sweepOrphanScratchWorkspaces', () => {
  const TASK = '11111111-1111-4111-8111-111111111111';

  /** The storage root is read at module load, so the module is re-imported per root. */
  async function loadWithRoot(root: string) {
    vi.resetModules();
    process.env.REPO_STORAGE_ROOT = root;
    return import('../src/repo/scratch-workspace.js');
  }

  function fakeDb(task: unknown, pendingSummary: unknown = undefined) {
    return {
      query: {
        tasks: { findFirst: async () => task },
        cliInvocations: { findFirst: async () => pendingSummary },
      },
    } as never;
  }

  async function rootWithScratch(): Promise<{ root: string; userId: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'scratch-sweep-'));
    const userId = 'u1';
    await mkdir(path.join(root, userId, '_scratch', TASK), { recursive: true });
    return { root, userId };
  }

  async function scratchNames(root: string, userId: string): Promise<string[]> {
    return readdir(path.join(root, userId, '_scratch'));
  }

  it('removes a workspace whose task row is gone', async () => {
    // The one case cleanupTaskScratchWorkspace cannot handle: it keys on a task it cannot read.
    const { root, userId } = await rootWithScratch();
    const mod = await loadWithRoot(root);
    await mod.sweepOrphanScratchWorkspaces(fakeDb(undefined));
    expect(await scratchNames(root, userId)).toEqual([]);
  });

  it('leaves a live task its working directory', async () => {
    // The whole safety argument. A task parked on a form is not settled, and taking its
    // workspace would break the run this sweep is supposed to be invisible to.
    const { root, userId } = await rootWithScratch();
    const mod = await loadWithRoot(root);
    await mod.sweepOrphanScratchWorkspaces(
      fakeDb({ id: TASK, userId, type: 'kb_author', repositoryId: null, status: 'waiting_user' }),
    );
    expect(await scratchNames(root, userId)).toEqual([TASK]);
  });

  it('finishes the reap a crash interrupted', async () => {
    const { root, userId } = await rootWithScratch();
    const mod = await loadWithRoot(root);
    await mod.sweepOrphanScratchWorkspaces(
      fakeDb({ id: TASK, userId, type: 'kb_author', repositoryId: null, status: 'completed' }),
    );
    expect(await scratchNames(root, userId)).toEqual([]);
  });

  it('keeps a settled task whose recap has not finished', async () => {
    const { root, userId } = await rootWithScratch();
    const mod = await loadWithRoot(root);
    await mod.sweepOrphanScratchWorkspaces(
      fakeDb(
        { id: TASK, userId, type: 'kb_author', repositoryId: null, status: 'completed' },
        { id: 'inv1' },
      ),
    );
    expect(await scratchNames(root, userId)).toEqual([TASK]);
  });
});

describe('ensureTaskScratchWorkspace', () => {
  const TASK = '22222222-2222-4222-8222-222222222222';

  it('creates the user directory that a first repo-less task finds missing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'scratch-ensure-'));
    try {
      vi.resetModules();
      // Handing the directory to this process's own uid keeps the chown a no-op on any runner.
      vi.doMock('../src/sandbox/sandbox-identity.js', () => ({
        SANDBOX_UID: process.getuid!(),
        SANDBOX_GID: process.getgid!(),
      }));
      process.env.REPO_STORAGE_ROOT = root;
      const mod = await import('../src/repo/scratch-workspace.js');
      const dir = await mod.ensureTaskScratchWorkspace('u-new', TASK);
      expect(dir).toBe(path.join(root, 'u-new', '_scratch', TASK));
      expect((await stat(dir)).isDirectory()).toBe(true);
    } finally {
      vi.doUnmock('../src/sandbox/sandbox-identity.js');
      await rm(root, { recursive: true, force: true });
    }
  });

  // As root every chown succeeds, so only a non-root runner can show the refusal.
  it.skipIf(process.getuid?.() === 0)(
    'still creates the workspace where the sandbox user cannot be given it',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'scratch-ensure-'));
      try {
        vi.resetModules();
        vi.doMock('../src/sandbox/sandbox-identity.js', () => ({
          SANDBOX_UID: process.getuid!() + 1,
          SANDBOX_GID: process.getgid!() + 1,
        }));
        process.env.REPO_STORAGE_ROOT = root;
        const mod = await import('../src/repo/scratch-workspace.js');
        const dir = await mod.ensureTaskScratchWorkspace('u-other', TASK);
        expect(dir).toBe(path.join(root, 'u-other', '_scratch', TASK));
        expect((await stat(dir)).isDirectory()).toBe(true);
      } finally {
        vi.doUnmock('../src/sandbox/sandbox-identity.js');
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('repository task scratch lifecycle', () => {
  const TASK = '33333333-3333-4333-8333-333333333333';
  let root: string;
  let mod: typeof import('../src/repo/scratch-workspace.js');
  const scratch = (user = 'u1', task = TASK) => path.join(root, user, '_scratch', task);
  const task = (extra = {}) => ({
    id: TASK,
    userId: 'u1',
    type: 'workflow',
    repositoryId: 'repo',
    status: 'completed',
    deadAt: null,
    pausedAt: null,
    orchestrationEpoch: 1,
    ...extra,
  });
  type Run = { summary?: boolean; startedAt?: Date; endedAt?: Date; supersededAt?: Date };
  function database(current = task(), runs: Run[] = []) {
    return {
      query: {
        tasks: { findFirst: vi.fn(async () => current) },
        cliInvocations: {
          findFirst: vi.fn(async ({ where }: { where: SQL }) => {
            // Evaluate the live-run predicates the real query supplies, including the OLD
            // summary-only restriction, so a missing scan guard actually fails on base.
            const { sql } = new PgDialect().sqlToQuery(where);
            return runs.find(
              (run) =>
                (!sql.includes('"summary_for_step_id" is not null') || run.summary) &&
                (!sql.includes('"ended_at" is null') || !run.endedAt) &&
                (!sql.includes('"superseded_at" is null') || !run.supersededAt),
            );
          }),
        },
      },
    };
  }
  const dbArg = (db: ReturnType<typeof database>) => db as never;
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'repo-scratch-'));
    vi.resetModules();
    vi.stubEnv('REPO_STORAGE_ROOT', root);
    sandbox.list.mockReset().mockResolvedValue([]);
    mod = await import('../src/repo/scratch-workspace.js');
    await mkdir(scratch(), { recursive: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each(['completed', 'cancelled'])(
    'reaps only canonical scratch for a %s repository task',
    async (status) => {
      const repo = path.join(root, 'u1', 'repo');
      await mkdir(repo);
      await writeFile(path.join(repo, 'keep'), 'repository');
      expect(await mod.cleanupTaskScratchWorkspace(dbArg(database(task({ status }))), TASK)).toBe(
        true,
      );
      await expect(stat(scratch())).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(repo, 'keep'), 'utf8')).toBe('repository');
    },
  );

  it.each([
    { status: 'failed' },
    { status: 'running' },
    { status: 'waiting_user' },
    { status: 'completed', deadAt: new Date() },
    { status: 'cancelled', pausedAt: new Date() },
  ])('retains recovery scratch for %j', async (extra) => {
    expect(await mod.cleanupTaskScratchWorkspace(dbArg(database(task(extra))), TASK)).toBe(false);
    expect((await stat(scratch())).isDirectory()).toBe(true);
  });

  it.each([true, false])('defers queued and started invocations (summary: %s)', async (summary) => {
    // Repo-less eligibility isolates the invocation guard from the repository widening.
    const current = task({ repositoryId: null, type: 'kb_author' });
    for (const startedAt of [undefined, new Date()]) {
      expect(
        await mod.cleanupTaskScratchWorkspace(
          dbArg(database(current, [{ summary, startedAt }])),
          TASK,
        ),
      ).toBe(false);
      expect((await stat(scratch())).isDirectory()).toBe(true);
    }
  });

  it.each([true, false])(
    'does not wait for a superseded invocation (summary: %s)',
    async (summary) => {
      expect(
        await mod.cleanupTaskScratchWorkspace(
          dbArg(database(task(), [{ summary, supersededAt: new Date() }])),
          TASK,
        ),
      ).toBe(true);
    },
  );

  it('retries deferred cleanup after the last invocation ends', async () => {
    const runs: Run[] = [{ summary: true }, { summary: false }];
    const db = database(task(), runs);
    expect(await mod.cleanupTaskScratchWorkspace(dbArg(db), TASK)).toBe(false);
    runs[0]!.endedAt = new Date();
    expect(await mod.cleanupTaskScratchWorkspace(dbArg(db), TASK)).toBe(false);
    runs[1]!.endedAt = new Date();
    expect(await mod.cleanupTaskScratchWorkspace(dbArg(db), TASK)).toBe(true);
  });

  it('boot finishes an interrupted repository scratch reap', async () => {
    await mod.sweepOrphanScratchWorkspaces(dbArg(database()));
    await expect(stat(scratch())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([null, ['still-running']])('requires a clean sandbox listing (%j)', async (listing) => {
    sandbox.list.mockResolvedValue(listing);
    const db = database(task({ repositoryId: null, type: 'kb_author' }));
    expect(await mod.cleanupTaskScratchWorkspace(dbArg(db), TASK)).toBe(false);
    expect((await stat(scratch())).isDirectory()).toBe(true);
  });

  it('rechecks settlement after the sandbox probe yields to Retry', async () => {
    const current = task({ repositoryId: null, type: 'kb_author' });
    const db = database(current);
    sandbox.list.mockImplementationOnce(async () => {
      current.status = 'running';
      return [];
    });
    expect(await mod.cleanupTaskScratchWorkspace(dbArg(db), TASK)).toBe(false);
    expect((await stat(scratch())).isDirectory()).toBe(true);
  });

  it('rechecks invocations admitted while the sandbox probe was pending', async () => {
    const runs: Run[] = [];
    sandbox.list.mockImplementationOnce(async () => {
      runs.push({});
      return [];
    });
    expect(
      await mod.cleanupTaskScratchWorkspace(
        dbArg(database(task({ repositoryId: null, type: 'kb_author' }), runs)),
        TASK,
      ),
    ).toBe(false);
    expect((await stat(scratch())).isDirectory()).toBe(true);
  });

  it('a wrong-user boot entry never triggers removal of the owner tree', async () => {
    await mkdir(scratch('u-wrong'), { recursive: true });
    await rm(path.join(root, 'u1'), { recursive: true });
    // Only the wrong-user entry is enumerated. If it triggers cleanup by task id, the
    // owner tree recreated during that read would be deleted despite not being visited.
    const db = database(task({ repositoryId: null, type: 'kb_author' }));
    db.query.tasks.findFirst.mockImplementation(async () => {
      await mkdir(scratch(), { recursive: true });
      return task({ repositoryId: null, type: 'kb_author' });
    });
    await mod.sweepOrphanScratchWorkspaces(dbArg(db));
    expect((await stat(scratch())).isDirectory()).toBe(true);
  });

  it('skips invalid UUIDs and link entries, including missing-task links', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep'), 'keep');
    await rm(scratch(), { recursive: true });
    await symlink(outside, scratch());
    await mkdir(scratch('u1', 'invalid'));
    await symlink(outside, path.join(root, 'linked-user'));
    const db = database();
    await mod.sweepOrphanScratchWorkspaces(dbArg(db));
    expect(db.query.tasks.findFirst).not.toHaveBeenCalled();
    expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('keep');
  });

  it.each(['owner', 'scratch', 'task'])(
    'never follows a %s link into another tree',
    async (component) => {
      const victim = path.join(root, 'u-victim');
      await mkdir(path.join(victim, '_scratch', TASK), { recursive: true });
      const keep = path.join(victim, '_scratch', TASK, 'keep');
      await writeFile(keep, 'keep');
      if (component === 'owner') {
        await rm(path.join(root, 'u1'), { recursive: true });
        await symlink(victim, path.join(root, 'u1'));
      } else if (component === 'scratch') {
        await rm(path.join(root, 'u1', '_scratch'), { recursive: true });
        await symlink(path.join(victim, '_scratch'), path.join(root, 'u1', '_scratch'));
      } else {
        await rm(scratch(), { recursive: true });
        await symlink(path.join(victim, '_scratch', TASK), scratch());
      }
      await mod.cleanupTaskScratchWorkspace(dbArg(database(task())), TASK);
      expect(await readFile(keep, 'utf8')).toBe('keep');
    },
  );

  it('rejects noncanonical cleanup ids before querying or removing', async () => {
    const db = database(task({ repositoryId: null, type: 'kb_author' }));
    expect(await mod.cleanupTaskScratchWorkspace(dbArg(db), '../repo')).toBe(false);
    expect(db.query.tasks.findFirst).not.toHaveBeenCalled();
    expect((await stat(scratch())).isDirectory()).toBe(true);
  });

  it('waits for a snapshot acquisition, then rereads a Retry before admitting deletion', async () => {
    const acquired = gate();
    const release = gate();
    const current = task({ repositoryId: null, type: 'kb_author' });
    const db = database(current);
    const read = gate();
    db.query.tasks.findFirst.mockImplementation(async () => {
      read.release();
      return { ...current };
    });
    const withWorkspace = (
      mod as typeof mod & {
        withTaskScratchWorkspace: <T>(u: string, t: string, f: () => Promise<T>) => Promise<T>;
      }
    ).withTaskScratchWorkspace;
    const reader = withWorkspace('u1', TASK, async () => {
      acquired.release();
      await release.promise;
    });
    await acquired.promise;
    const reap = mod.cleanupTaskScratchWorkspace(dbArg(db), TASK);
    await read.promise;
    expect(db.query.cliInvocations.findFirst).not.toHaveBeenCalled();
    current.status = 'running';
    release.release();
    await reader;
    expect(await reap).toBe(false);
    expect((await stat(scratch())).isDirectory()).toBe(true);
  });

  it('holds materialization behind deletion, then lets Retry recreate the tree', async () => {
    const entered = gate();
    const release = gate();
    const safeFs = await import('@haive/shared/fs-safe');
    const realRemove = safeFs.removeNoFollow;
    vi.spyOn(safeFs, 'removeNoFollow').mockImplementationOnce(async (...args) => {
      entered.release();
      await release.promise;
      return realRemove(...args);
    });
    const reap = mod.cleanupTaskScratchWorkspace(
      dbArg(database(task({ repositoryId: null, type: 'kb_author' }))),
      TASK,
    );
    await entered.promise;
    const created = vi.fn();
    const ensure = mod.ensureTaskScratchWorkspace('u1', TASK).then(created);
    // A fence on another task must remain independent, and its completion provides a
    // deterministic scheduling boundary without sleeps or elapsed-time assertions.
    await mod.ensureTaskScratchWorkspace('u1', '44444444-4444-4444-8444-444444444444');
    const createdDuringRemoval = created.mock.calls.length;
    release.release();
    expect(await reap).toBe(true);
    await ensure;
    expect(createdDuringRemoval).toBe(0);
    expect((await stat(scratch())).isDirectory()).toBe(true);
  });
});

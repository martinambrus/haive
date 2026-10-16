import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';

const h = vi.hoisted(() => {
  const log: string[] = [];
  const failing = new Set<string>();
  const listing = new Map<string, string[] | null>();
  const hold: { until: Promise<void> | null; at: string | null } = { until: null, at: null };
  const step = async (name: string, taskId: string) => {
    log.push(`${name}:${taskId}`);
    if (hold.at === null || hold.at === name) await hold.until;
    if (failing.has(name) || failing.has(`${name}:${taskId}`)) throw new Error(`${name} failed`);
  };
  return { log, failing, listing, hold, step };
});

vi.mock('../src/queues/task-queue.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTaskQueue: () => ({ getJobs: async () => [] }),
}));
vi.mock('../src/data-migrations.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reconcileStrandedSyncingBundles: async () => undefined,
}));
vi.mock('../src/sandbox/cli-sandbox-fence.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  supersedeTaskRuns: (_db: unknown, taskId: string) => h.step('supersedeTaskRuns', taskId),
}));
vi.mock('../src/sandbox/sandbox-kill.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  killCliSandboxesForTask: async (taskId: string) => {
    await h.step('killCliSandboxesForTask', taskId);
    return 0;
  },
  listCliSandboxesForTask: async (taskId: string) => {
    await h.step('listCliSandboxesForTask', taskId);
    return h.listing.has(taskId) ? (h.listing.get(taskId) ?? null) : [];
  },
}));
vi.mock('../src/step-engine/left-open-merge.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordLeftOpenMerges: (_db: unknown, taskId: string) => h.step('recordLeftOpenMerges', taskId),
}));
vi.mock('../src/step-engine/merge-dir-claim.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  releaseTaskMergeClaims: (_db: unknown, taskId: string) =>
    h.step('releaseTaskMergeClaims', taskId),
}));
vi.mock('../src/step-engine/steps/plan/01-plan-merge.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  discardPlanMerge: (_db: unknown, taskId: string) => h.step('discardPlanMerge', taskId),
}));
vi.mock('../src/project-state/set-aside.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resyncAfterTaskEnd: (_db: unknown, taskId: string) => h.step('resyncAfterTaskEnd', taskId),
}));

import {
  abandonCancelledTeardowns,
  CANCEL_REDRIVE_BATCH,
  CANCEL_REDRIVE_LOOKBACK_MS,
  CANCEL_REDRIVE_MAX,
  redriveCancelledTasks,
  StalledTaskSweeper,
  type CancelRedriveDeps,
} from '../src/queues/stalled-redrive.js';
import { liveClaimHolder, type DbHandle } from '../src/step-engine/merge-dir-claim.js';

const GUARD = ['supersedeTaskRuns', 'killCliSandboxesForTask', 'listCliSandboxesForTask'] as const;
const GUARDED = ['releaseTaskMergeClaims', 'discardPlanMerge', 'resyncAfterTaskEnd'] as const;

/** One whole pass over a task: the sandbox guard, the report, the finish record, then the release,
 *  the plan-merge discard and the re-sync. */
const pass = (taskId: string) => [
  ...GUARD.map((s) => `${s}:${taskId}`),
  `recordLeftOpenMerges:${taskId}`,
  `insert:task.cancel_finished:${taskId}`,
  ...GUARDED.map((s) => `${s}:${taskId}`),
];
const upToGuard = (taskId: string) => pass(taskId).slice(0, GUARD.length);

interface Seen {
  where?: unknown;
  limit?: number;
  inserted: Record<string, unknown>[];
}

const finished = (events: { taskId?: unknown; eventType?: unknown }[], taskId: string) =>
  events.some((e) => e.taskId === taskId && e.eventType === 'task.cancel_finished');

/** The candidates SELECT is faked; its subqueries are built by a real drizzle builder, so the
 *  rendered condition can be read back. It leaves out a task once its finish record is inserted, as
 *  its NOT EXISTS does. The finish record's insert lands in the shared log, so the order of the
 *  steps and the record can be read off one list. */
function makeDb(
  rows: { taskId: string; attempts: number }[],
  opts: { insertFailsFor?: string } = {},
): { db: Database; seen: Seen } {
  const seen: Seen = { inserted: [] };
  const real = drizzle.mock();
  const outer = {
    from: () => ({
      where: (cond: unknown) => {
        seen.where = cond;
        return {
          orderBy: () => ({
            limit: (n: number) => {
              seen.limit = n;
              return Promise.resolve(rows.filter((r) => !finished(seen.inserted, r.taskId)));
            },
          }),
        };
      },
    }),
  };
  const db = {
    select: (fields: Parameters<typeof real.select>[0] & object) =>
      'taskId' in fields ? outer : real.select(fields),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        if (v.taskId === opts.insertFailsFor) throw new Error('db blinked');
        h.log.push(`insert:${String(v.eventType)}:${String(v.taskId)}`);
        seen.inserted.push(v);
      },
    }),
  };
  return { db: db as unknown as Database, seen };
}

interface CountedEvent {
  id: string;
  taskId: string;
  eventType: string;
  payload: unknown;
}

/** Keeps the events a re-drive writes and gives back, so the count it leaves can be read. Both
 *  candidate SELECTs are faked and apply the one cap their real WHERE applies. */
function makeRedriveDb(taskIds: string[], priorAttempts = 0) {
  const events: CountedEvent[] = [];
  const deletes: { sql: string; params: unknown[] }[] = [];
  let next = 0;
  for (const taskId of taskIds) {
    for (let attempt = 1; attempt <= priorAttempts; attempt++) {
      events.push({
        id: `prior-${attempt}`,
        taskId,
        eventType: 'task.cancel_redriven',
        payload: { attempt },
      });
    }
  }
  const redriven = (taskId: string) =>
    events.filter((e) => e.taskId === taskId && e.eventType === 'task.cancel_redriven').length;
  const candidates = (take: (taskId: string) => boolean, withUser: boolean) => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () =>
            Promise.resolve(
              taskIds.filter(take).map((taskId) => ({
                taskId,
                ...(withUser ? { userId: 'user-1' } : {}),
                attempts: redriven(taskId),
              })),
            ),
        }),
      }),
    }),
  });
  const real = drizzle.mock();
  const db = {
    select: (fields: Parameters<typeof real.select>[0] & object) => {
      if (!('taskId' in fields)) return real.select(fields);
      return 'userId' in fields
        ? candidates((id) => redriven(id) < CANCEL_REDRIVE_MAX, true)
        : candidates((id) => redriven(id) >= CANCEL_REDRIVE_MAX && !finished(events, id), false);
    },
    insert: () => ({
      values: (v: Omit<CountedEvent, 'id'>) => {
        const row = { id: `event-${(next += 1)}`, ...v };
        events.push(row);
        return Object.assign(Promise.resolve(), { returning: async () => [{ id: row.id }] });
      },
    }),
    delete: () => ({
      where: async (cond: unknown) => {
        const query = rendered(cond);
        deletes.push(query);
        for (const gone of events.filter((e) => query.params.includes(e.id))) {
          events.splice(events.indexOf(gone), 1);
        }
      },
    }),
  };
  return { db: db as unknown as Database, events, deletes, redriven };
}

/** What `liveClaimHolder` reads for a cancelled task: its events, answered from the ones recorded. */
function claimReader(events: { taskId?: unknown; eventType?: unknown }[]): DbHandle {
  const holder = [{ title: 'Cancelled task', taskStatus: 'cancelled', stepStatus: 'failed' }];
  return {
    select: (fields: object) =>
      'title' in fields
        ? { from: () => ({ innerJoin: () => ({ where: async () => holder }) }) }
        : {
            from: () => ({
              where: (cond: unknown) => ({
                limit: async () => {
                  const { params } = rendered(cond);
                  return events
                    .filter((e) => params.includes(e.taskId) && params.includes(e.eventType))
                    .map(() => ({ id: 'event' }));
                },
              }),
            }),
          },
  } as unknown as DbHandle;
}
const CLAIM = { taskId: 'task-1', taskStepId: 'step-1' };

const queued = (ids: string[] | null = []) => ({
  queuedCancelTaskIds: async () => (ids === null ? null : new Set(ids)),
});
const OPTS = { staleMs: 300_000 };

function rendered(cond: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(cond as SQL);
}

const finishRecord = (taskId: string, reason: string) => ({
  taskId,
  taskStepId: null,
  eventType: 'task.cancel_finished',
  payload: { source: 'worker', abandoned: true, reason },
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  h.log.length = 0;
  h.failing.clear();
  h.listing.clear();
  h.hold.until = null;
  h.hold.at = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('abandonCancelledTeardowns', () => {
  it('checks that no sandbox is left, reports, writes the finish record, then releases, discards and re-syncs, in that order', async () => {
    h.listing.set('task-1', []);
    const { db, seen } = makeDb([{ taskId: 'task-1', attempts: 3 }]);
    expect(await abandonCancelledTeardowns(db, queued(), OPTS)).toBe(1);
    expect(h.log).toEqual([
      'supersedeTaskRuns:task-1',
      'killCliSandboxesForTask:task-1',
      'listCliSandboxesForTask:task-1',
      'recordLeftOpenMerges:task-1',
      'insert:task.cancel_finished:task-1',
      'releaseTaskMergeClaims:task-1',
      'discardPlanMerge:task-1',
      'resyncAfterTaskEnd:task-1',
    ]);
    expect(seen.inserted).toEqual([finishRecord('task-1', 're-drive cap reached')]);
  });

  it.each<[string, string[] | null]>([
    ['a sandbox is still listed', ['c1']],
    ['docker could not list them', null],
  ])(
    'keeps the claims and writes no finish record when %s, and takes the task again on the next pass',
    async (_why, listing) => {
      h.listing.set('task-1', listing);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const { db, seen } = makeDb([
        { taskId: 'task-1', attempts: 3 },
        { taskId: 'task-2', attempts: 3 },
      ]);
      expect(await abandonCancelledTeardowns(db, queued(), OPTS)).toBe(1);
      expect(h.log).toEqual([...upToGuard('task-1'), ...pass('task-2')]);
      expect(seen.inserted).toEqual([finishRecord('task-2', 're-drive cap reached')]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-1' }),
        expect.any(String),
      );

      h.log.length = 0;
      h.listing.delete('task-1');
      expect(await abandonCancelledTeardowns(db, queued(), OPTS)).toBe(1);
      expect(h.log).toEqual(pass('task-1'));
      expect(seen.inserted).toEqual([
        finishRecord('task-2', 're-drive cap reached'),
        finishRecord('task-1', 're-drive cap reached'),
      ]);
    },
  );

  it('has written the finish record by the time the release starts, so a pass cut off in it leaves the claims stale', async () => {
    const gate = Promise.withResolvers<void>();
    h.hold.until = gate.promise;
    h.hold.at = 'releaseTaskMergeClaims';
    const { db, seen } = makeDb([{ taskId: 'task-1', attempts: 3 }]);
    expect(await liveClaimHolder(claimReader(seen.inserted), CLAIM)).toEqual({
      id: 'task-1',
      title: 'Cancelled task',
    });
    const running = abandonCancelledTeardowns(db, queued(), OPTS);
    try {
      await vi.waitFor(() => expect(h.log.at(-1)).toBe('releaseTaskMergeClaims:task-1'));
      expect(seen.inserted).toEqual([finishRecord('task-1', 're-drive cap reached')]);
      expect(await liveClaimHolder(claimReader(seen.inserted), CLAIM)).toBeNull();
    } finally {
      gate.resolve();
      await running;
    }
  });

  it('leaves a task finished, out of the next pass and its claims stale when the release throws', async () => {
    h.failing.add('releaseTaskMergeClaims');
    const { db, seen } = makeDb([{ taskId: 'task-1', attempts: 3 }]);
    expect(await abandonCancelledTeardowns(db, queued(), OPTS)).toBe(1);
    expect(h.log).toEqual(pass('task-1'));
    expect(seen.inserted).toEqual([finishRecord('task-1', 're-drive cap reached')]);

    h.log.length = 0;
    expect(await abandonCancelledTeardowns(db, queued(), OPTS)).toBe(0);
    expect(h.log).toEqual([]);
    expect(await liveClaimHolder(claimReader(seen.inserted), CLAIM)).toBeNull();
  });

  it('says why: the cap once the re-drive ran out, the window for a task cut off before that', async () => {
    const { db, seen } = makeDb([
      { taskId: 'task-0', attempts: 0 },
      { taskId: 'task-1', attempts: 1 },
      { taskId: 'task-2', attempts: CANCEL_REDRIVE_MAX - 1 },
      { taskId: 'task-3', attempts: CANCEL_REDRIVE_MAX },
    ]);
    expect(await abandonCancelledTeardowns(db, queued(), OPTS)).toBe(4);
    expect(seen.inserted).toEqual([
      finishRecord('task-0', 'cancelled before the re-drive window'),
      finishRecord('task-1', 'cancelled before the re-drive window'),
      finishRecord('task-2', 'cancelled before the re-drive window'),
      finishRecord('task-3', 're-drive cap reached'),
    ]);
  });

  it.each(GUARDED)(
    'still finishes the task and runs the other steps when %s throws',
    async (name) => {
      h.failing.add(name);
      const { db, seen } = makeDb([{ taskId: 'task-1', attempts: 3 }]);
      expect(await abandonCancelledTeardowns(db, queued(), OPTS)).toBe(1);
      expect(h.log).toEqual(pass('task-1'));
      expect(seen.inserted).toHaveLength(1);
    },
  );

  it('stops before releasing anything when the left-open merges cannot be reported, and leaves the task for the next pass', async () => {
    h.failing.add('recordLeftOpenMerges:task-1');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { db, seen } = makeDb([
      { taskId: 'task-1', attempts: 3 },
      { taskId: 'task-2', attempts: 3 },
    ]);
    expect(await abandonCancelledTeardowns(db, queued(), OPTS)).toBe(1);
    expect(h.log).toEqual([
      ...upToGuard('task-1'),
      'recordLeftOpenMerges:task-1',
      ...pass('task-2'),
    ]);
    expect(seen.inserted).toEqual([finishRecord('task-2', 're-drive cap reached')]);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1' }),
      expect.any(String),
    );
  });

  it('leaves a task with a CANCEL queued or active alone', async () => {
    const { db, seen } = makeDb([
      { taskId: 'task-1', attempts: 3 },
      { taskId: 'task-2', attempts: 3 },
    ]);
    expect(await abandonCancelledTeardowns(db, queued(['task-1']), OPTS)).toBe(1);
    expect(seen.inserted).toEqual([finishRecord('task-2', 're-drive cap reached')]);
    expect(h.log.every((l) => l.endsWith(':task-2'))).toBe(true);
  });

  it('does nothing when the task queue cannot be read', async () => {
    const { db, seen } = makeDb([{ taskId: 'task-1', attempts: 3 }]);
    expect(await abandonCancelledTeardowns(db, queued(null), OPTS)).toBe(0);
    expect(h.log).toEqual([]);
    expect(seen.inserted).toEqual([]);
  });

  it('does not read the task queue when nothing is a candidate', async () => {
    const { db } = makeDb([]);
    const read = vi.fn(async () => new Set<string>());
    expect(await abandonCancelledTeardowns(db, { queuedCancelTaskIds: read }, OPTS)).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('carries on past a task whose finish record cannot be written, releasing nothing of it and leaving it for the next pass', async () => {
    const { db, seen } = makeDb(
      [
        { taskId: 'task-1', attempts: 3 },
        { taskId: 'task-2', attempts: 3 },
      ],
      { insertFailsFor: 'task-1' },
    );
    expect(await abandonCancelledTeardowns(db, queued(), OPTS)).toBe(1);
    expect(seen.inserted).toEqual([finishRecord('task-2', 're-drive cap reached')]);
    expect(h.log).toContain('resyncAfterTaskEnd:task-2');
    expect(h.log.filter((l) => l.endsWith(':task-1'))).toEqual(
      pass('task-1').slice(0, GUARD.length + 1),
    );
  });

  it('selects a cancelled task with no finish record that holds a claim, capped or past the window', async () => {
    const before = Date.now();
    const { db, seen } = makeDb([]);
    await abandonCancelledTeardowns(db, queued(), OPTS);
    const { sql, params } = rendered(seen.where);
    expect(sql).toContain('"tasks"."status" = $');
    expect(sql).toContain('"merge_dir_claims"');
    expect(sql).toContain('not exists');
    expect(params).toEqual(
      expect.arrayContaining([
        'cancelled',
        'task.cancel_finished',
        'task.cancel_redriven',
        'task.cancelled',
        CANCEL_REDRIVE_MAX,
      ]),
    );
    const ages = params
      .filter((v): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v))
      .map((v) => before - new Date(v).getTime())
      .sort((x, y) => x - y);
    expect(ages).toHaveLength(2);
    expect(ages[0]).toBeGreaterThanOrEqual(OPTS.staleMs - 1000);
    expect(ages[0]).toBeLessThan(OPTS.staleMs + 5000);
    expect(ages[1]).toBeGreaterThanOrEqual(CANCEL_REDRIVE_LOOKBACK_MS - 1000);
    expect(seen.limit).toBe(CANCEL_REDRIVE_BATCH);
  });

  it('reads the re-drive count only for the cap: past the window a task is taken whatever its count', async () => {
    const { db, seen } = makeDb([]);
    await abandonCancelledTeardowns(db, queued(), OPTS);
    expect(rendered(seen.where).sql.match(/count\(\*\)/g)).toHaveLength(1);
  });
});

describe('redriveCancelledTasks, when the queue refuses the CANCEL', () => {
  const refusing: CancelRedriveDeps = {
    enqueueCancel: async () => {
      throw new Error('redis blinked');
    },
    queuedCancelTaskIds: async () => new Set<string>(),
  };

  it('leaves the re-drive count where it was, giving back only the event of its own attempt', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { db, events, deletes, redriven } = makeRedriveDb(['task-1'], 1);
    expect(await redriveCancelledTasks(db, refusing, OPTS)).toBe(0);
    expect(redriven('task-1')).toBe(1);
    expect(events.map((e) => e.id)).toEqual(['prior-1']);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.params).toContain('event-1');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1' }),
      expect.any(String),
    );
  });

  it('does not cap a task after as many refusals in a row as the cap, for the re-drive or the abandon pass', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { db, events, redriven } = makeRedriveDb(['task-1']);
    for (let refused = 0; refused < CANCEL_REDRIVE_MAX; refused++) {
      expect(await redriveCancelledTasks(db, refusing, OPTS)).toBe(0);
    }
    expect(redriven('task-1')).toBe(0);
    expect(await abandonCancelledTeardowns(db, queued(), OPTS)).toBe(0);
    expect(h.log).toEqual([]);

    const sent: string[] = [];
    const accepting = { ...refusing, enqueueCancel: async (id: string) => void sent.push(id) };
    expect(await redriveCancelledTasks(db, accepting, OPTS)).toBe(1);
    expect(sent).toEqual(['task-1']);
    expect(events.map((e) => e.payload)).toEqual([{ attempt: 1 }]);
  });
});

describe('StalledTaskSweeper', () => {
  /** Every select answers with no rows but the abandon pass's candidates, read through `rows`. */
  function sweeperDb(rows: () => Promise<{ taskId: string; attempts: number }[]>): Database {
    const empty: unknown = new Proxy(() => empty, {
      get: (_target, key) =>
        key === 'then' ? (ok: (rows: unknown[]) => unknown) => Promise.resolve([]).then(ok) : empty,
      apply: () => empty,
    });
    const abandonCandidates = {
      from: () => ({ where: () => ({ orderBy: () => ({ limit: rows }) }) }),
    };
    return {
      select: (fields?: object) =>
        fields && 'attempts' in fields && !('userId' in fields) ? abandonCandidates : empty,
      insert: () => ({
        values: async (v: Record<string, unknown>) => {
          h.log.push(`insert:${String(v.eventType)}:${String(v.taskId)}`);
        },
      }),
    } as unknown as Database;
  }
  const capped = async () => [{ taskId: 'task-1', attempts: 3 }];
  const wholePass = pass('task-1');

  it('gives up on a capped teardown in the same sweep as the re-drive', async () => {
    await new StalledTaskSweeper({ db: sweeperDb(capped) }).sweep();

    await vi.waitFor(() => expect(h.log).toEqual(wholePass));
  });

  it('returns from sweep() while an abandon step is still pending', async () => {
    const gate = Promise.withResolvers<void>();
    h.hold.until = gate.promise;
    let returned = false;
    const sweeping = new StalledTaskSweeper({ db: sweeperDb(capped) }).sweep().then(() => {
      returned = true;
    });
    try {
      await vi.waitFor(() => expect(h.log).toEqual(['supersedeTaskRuns:task-1']));
      await tick();
      expect(returned).toBe(true);
    } finally {
      gate.resolve();
      await sweeping;
    }
    await vi.waitFor(() => expect(h.log).toEqual(wholePass));
  });

  it('starts no second abandon pass while one is running, and one again once it has ended', async () => {
    const gate = Promise.withResolvers<void>();
    h.hold.until = gate.promise;
    const sweeper = new StalledTaskSweeper({ db: sweeperDb(capped) });
    const sweeps = [sweeper.sweep()];
    try {
      await vi.waitFor(() => expect(h.log).toEqual(['supersedeTaskRuns:task-1']));
      sweeps.push(sweeper.sweep());
      await tick();
      expect(h.log).toEqual(['supersedeTaskRuns:task-1']);
    } finally {
      gate.resolve();
      await Promise.all(sweeps);
    }
    await vi.waitFor(() => expect(h.log).toEqual(wholePass));
    await tick();

    h.hold.until = null;
    h.log.length = 0;
    await sweeper.sweep();
    await vi.waitFor(() => expect(h.log).toEqual(wholePass));
  });

  it('logs an abandon pass that rejects instead of throwing it, and starts another on the next sweep', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const boom = new Error('db blinked');
    let reads = 0;
    const sweeper = new StalledTaskSweeper({
      db: sweeperDb(async () => {
        reads += 1;
        throw boom;
      }),
    });

    await expect(sweeper.sweep()).resolves.toEqual({ redriven: 0 });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: boom }), expect.any(String)),
    );
    await tick();

    await expect(sweeper.sweep()).resolves.toEqual({ redriven: 0 });
    await vi.waitFor(() => expect(reads).toBe(2));
  });
});

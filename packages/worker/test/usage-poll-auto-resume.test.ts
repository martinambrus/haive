import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { CONFIG_KEYS, TASK_JOB_NAMES, configService, logger } from '@haive/shared';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const h = vi.hoisted(() => ({
  queued: [] as { name: string; data: unknown }[],
  failNextAdd: null as Error | null,
  refusals: 1,
  tries: 0,
}));

vi.mock('../src/queues/task-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues/task-queue.js')>()),
  getTaskQueue: () => ({
    add: async (name: string, data: unknown) => {
      h.tries++;
      if (h.failNextAdd) {
        const failure = h.failNextAdd;
        if (--h.refusals === 0) h.failNextAdd = null;
        throw failure;
      }
      h.queued.push({ name, data });
    },
  }),
}));

import { checkProviderRecovery } from '../src/queues/usage-poll-queue.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const PROVIDER = '00000000-0000-4000-8000-0000000000b1';
const ROW = '00000000-0000-4000-8000-0000000000c1';
const NEXT_TASK = '00000000-0000-4000-8000-000000000002';
const NEXT_ROW = '00000000-0000-4000-8000-0000000000c2';

/** The cached read says `normal` throughout, so only the stored state, read past it, can hold. */
function config(mode: string, stored: string) {
  vi.spyOn(configService, 'get').mockImplementation(async (key) => {
    if (key === CONFIG_KEYS.ALLOWANCE_WATCH_MODE) return mode;
    return key === CONFIG_KEYS.MAINTENANCE_STATE ? 'normal' : null;
  });
  vi.spyOn(configService, 'getFresh').mockImplementation(async (key) =>
    key === CONFIG_KEYS.MAINTENANCE_STATE ? stored : null,
  );
}

/** The stored state, read past the cache once per check: each value or Error answers one read, then normal. */
function storedStates(...values: (string | Error)[]) {
  const queue = [...values];
  vi.spyOn(configService, 'get').mockImplementation(async (key) => {
    if (key === CONFIG_KEYS.ALLOWANCE_WATCH_MODE) return 'auto';
    return key === CONFIG_KEYS.MAINTENANCE_STATE ? 'normal' : null;
  });
  vi.spyOn(configService, 'getFresh').mockImplementation(async (key) => {
    if (key !== CONFIG_KEYS.MAINTENANCE_STATE) return null;
    const next = queue.shift() ?? 'normal';
    if (next instanceof Error) throw next;
    return next;
  });
}

/** A task armed after a rate limit whose reset has passed; the poller's join read answers it. */
function setup() {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskEvents: schema.taskEvents,
    usageWindowSnapshots: schema.usageWindowSnapshots,
  });
  const since = new Date('2026-10-15T08:00:00.000Z');
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    status: 'failed',
    currentStepId: 'fan-out',
    currentRound: 0,
    awaitingAllowanceProviderId: PROVIDER,
    awaitingProviderReason: 'rate_limit',
    awaitingProviderSince: since,
    allowanceResetAt: new Date(0),
    allowanceAutoResumeCount: 0,
  });
  fake.insert(schema.taskSteps, {
    id: ROW,
    taskId: TASK,
    stepId: 'fan-out',
    round: 0,
    status: 'failed',
  });
  const armed = {
    id: TASK,
    userId: USER,
    providerId: PROVIDER,
    reason: 'rate_limit',
    since,
    resetAt: new Date(0),
    currentStepId: 'fan-out',
    currentRound: 0,
    autoResumeCount: 0,
    providerName: 'claude-code',
  };
  const next: (typeof armed)[] = [];
  const db = {
    ...fake.db,
    select: (fields?: Record<string, unknown>) => ({
      from: (table: PgTable) =>
        table === schema.tasks
          ? { leftJoin: () => ({ where: async () => [armed, ...next] }) }
          : fake.db.select(fields).from(table),
    }),
  } as unknown as Database;
  const writes: string[] = [];
  const record = (table: PgTable) => {
    writes.push(getTableName(table));
  };
  fake.hooks.beforeInsert = record;
  fake.hooks.beforeUpdate = record;
  fake.hooks.beforeDelete = record;
  const task = (id = TASK) => fake.rows(schema.tasks).find((r) => r.id === id)!;
  return { fake, db, writes, task, armed, next };
}

beforeEach(() => {
  h.queued = [];
  h.failNextAdd = null;
  h.refusals = 1;
  h.tries = 0;
});

describe('the allowance auto-resume of a task whose provider is back', () => {
  it('retries a refused auto-resume add after the re-open and queues exactly one advance', async () => {
    vi.useFakeTimers();
    config('auto', 'normal');
    const t = setup();
    t.fake.patch(schema.tasks, TASK, { orchestrationEpoch: 7 });
    h.failNextAdd = new Error('the queue refused the job');

    try {
      const resumed = checkProviderRecovery(t.db);
      await vi.advanceTimersByTimeAsync(1_000);
      await resumed;

      expect(h.tries).toBe(2);
      expect(h.queued).toEqual([
        {
          name: TASK_JOB_NAMES.ADVANCE_STEP,
          data: { taskId: TASK, userId: USER, stepId: 'fan-out', round: 0, epoch: 7 },
        },
      ]);
      expect(t.task()).toMatchObject({
        status: 'running',
        allowanceAutoResumeCount: 1,
        awaitingAllowanceProviderId: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes it and queues its step while the system is normal', async () => {
    config('auto', 'normal');
    const t = setup();

    await checkProviderRecovery(t.db);

    expect(t.task()).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
    expect(h.queued).toMatchObject([
      { name: TASK_JOB_NAMES.ADVANCE_STEP, data: { taskId: TASK, stepId: 'fan-out' } },
    ]);
  });

  it('stamps the advance with the epoch the task stands at, so one a Retry or a re-drive left behind is dropped as stale', async () => {
    config('auto', 'normal');
    const t = setup();
    t.fake.patch(schema.tasks, TASK, { orchestrationEpoch: 7 });

    await checkProviderRecovery(t.db);

    expect(t.task()).toMatchObject({ status: 'running', orchestrationEpoch: 7 });
    expect(h.queued).toMatchObject([
      {
        name: TASK_JOB_NAMES.ADVANCE_STEP,
        data: { taskId: TASK, userId: USER, stepId: 'fan-out', round: 0, epoch: 7 },
      },
    ]);
  });

  it('keeps the epoch of each task it resumes in one poll apart', async () => {
    config('auto', 'normal');
    const t = setup();
    t.fake.patch(schema.tasks, TASK, { orchestrationEpoch: 7 });
    t.fake.insert(schema.tasks, { ...t.task(), id: NEXT_TASK, orchestrationEpoch: 11 });
    t.fake.insert(schema.taskSteps, {
      id: NEXT_ROW,
      taskId: NEXT_TASK,
      stepId: 'fan-out',
      round: 0,
      status: 'failed',
    });
    t.next.push({ ...t.armed, id: NEXT_TASK });

    await checkProviderRecovery(t.db);

    expect(h.queued).toMatchObject([
      { data: { taskId: TASK, epoch: 7 } },
      { data: { taskId: NEXT_TASK, epoch: 11 } },
    ]);
  });

  describe.each(['draining', 'maintenance'])('while the system is %s', (state) => {
    it('changes nothing, queues nothing and spends no attempt', async () => {
      config('auto', state);
      const t = setup();

      await checkProviderRecovery(t.db);

      expect(t.writes).toEqual([]);
      expect(h.queued).toEqual([]);
      expect(t.task()).toMatchObject({
        status: 'failed',
        allowanceAutoResumeCount: 0,
        awaitingAllowanceProviderId: PROVIDER,
        allowanceReplenishedAt: null,
      });
    });

    it('resumes it on a later poll once the system is normal again', async () => {
      config('auto', state);
      const t = setup();
      await checkProviderRecovery(t.db);
      expect(t.task()).toMatchObject({ status: 'failed', allowanceAutoResumeCount: 0 });

      config('auto', 'normal');
      await checkProviderRecovery(t.db);

      expect(t.task()).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
      expect(h.queued).toHaveLength(1);
    });

    it('still tells the person in notify mode, which resumes nothing', async () => {
      config('notify', state);
      const t = setup();

      await checkProviderRecovery(t.db);

      expect(t.task()).toMatchObject({ status: 'failed', allowanceAutoResumeCount: 0 });
      expect(t.task().allowanceReplenishedAt).toBeInstanceOf(Date);
      expect(t.fake.rows(schema.taskEvents)).toMatchObject([
        { eventType: 'task.allowance_replenished' },
      ]);
      expect(h.queued).toEqual([]);
    });
  });
});

describe.each(['draining', 'maintenance'])(
  'the allowance auto-resume when the system turns %s after the early check',
  (state) => {
    it('changes nothing, queues nothing and spends no attempt', async () => {
      storedStates('normal', state);
      const t = setup();

      await checkProviderRecovery(t.db);

      expect(t.writes).toEqual([]);
      expect(h.queued).toEqual([]);
      expect(t.task()).toMatchObject({
        status: 'failed',
        allowanceAutoResumeCount: 0,
        awaitingAllowanceProviderId: PROVIDER,
        allowanceReplenishedAt: null,
      });
      expect(t.fake.rows(schema.taskEvents)).toEqual([]);
    });

    it('resumes it on a later poll once the system is normal again', async () => {
      storedStates('normal', state, 'normal', 'normal');
      const t = setup();
      await checkProviderRecovery(t.db);
      expect(t.task()).toMatchObject({ status: 'failed', allowanceAutoResumeCount: 0 });

      await checkProviderRecovery(t.db);

      expect(t.task()).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
      expect(h.queued).toHaveLength(1);
    });
  },
);

describe('the allowance auto-resume when the stored state cannot be read', () => {
  const down = new Error('redis went away');
  afterEach(() => vi.restoreAllMocks());

  it('warns, treats the system as normal, and goes on to resume the next armed task', async () => {
    storedStates(down, 'normal', down, 'normal');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const t = setup();
    t.fake.insert(schema.tasks, { ...t.task(), id: NEXT_TASK });
    t.fake.insert(schema.taskSteps, {
      id: NEXT_ROW,
      taskId: NEXT_TASK,
      stepId: 'fan-out',
      round: 0,
      status: 'failed',
    });
    t.next.push({ ...t.armed, id: NEXT_TASK });

    await checkProviderRecovery(t.db);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, err: expect.any(Error) }),
      expect.any(String),
    );
    expect(t.task()).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
    expect(t.task(NEXT_TASK)).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
    expect(h.queued).toMatchObject([
      { name: TASK_JOB_NAMES.ADVANCE_STEP, data: { taskId: TASK } },
      { name: TASK_JOB_NAMES.ADVANCE_STEP, data: { taskId: NEXT_TASK } },
    ]);
  });

  describe('under the fence', () => {
    it('leaves the task failed with its watch armed and goes on to resume the next armed task', async () => {
      storedStates('normal', down, 'normal', 'normal');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const t = setup();
      t.fake.insert(schema.tasks, { ...t.task(), id: NEXT_TASK });
      t.fake.insert(schema.taskSteps, {
        id: NEXT_ROW,
        taskId: NEXT_TASK,
        stepId: 'fan-out',
        round: 0,
        status: 'failed',
      });
      t.next.push({ ...t.armed, id: NEXT_TASK });

      await checkProviderRecovery(t.db);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: TASK,
          providerId: PROVIDER,
          err: expect.objectContaining({ name: 'MaintenanceStateUnreadable' }),
        }),
        expect.any(String),
      );
      expect(t.task()).toMatchObject({
        status: 'failed',
        allowanceAutoResumeCount: 0,
        awaitingAllowanceProviderId: PROVIDER,
        allowanceReplenishedAt: null,
      });
      expect(t.task(NEXT_TASK)).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
      expect(h.queued).toMatchObject([
        { name: TASK_JOB_NAMES.ADVANCE_STEP, data: { taskId: NEXT_TASK } },
      ]);
      expect(t.fake.rows(schema.taskEvents)).toMatchObject([
        { taskId: NEXT_TASK, eventType: 'task.auto_resumed' },
      ]);
    });

    it('resumes it on a later poll once the state can be read again', async () => {
      storedStates('normal', down, 'normal', 'normal');
      const t = setup();
      await checkProviderRecovery(t.db);
      expect(t.task()).toMatchObject({ status: 'failed', allowanceAutoResumeCount: 0 });

      await checkProviderRecovery(t.db);

      expect(t.task()).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
      expect(h.queued).toHaveLength(1);
    });
  });
});

describe('the allowance auto-resume when the epoch of the re-opened task cannot be read', () => {
  afterEach(() => vi.restoreAllMocks());
  const unreadable = new Error('connection terminated unexpectedly');
  const epochOf = (job: { data: unknown } | undefined) =>
    (job?.data as { epoch?: number } | undefined)?.epoch;

  /** The poller's db, with the read of a task's row failing for the first `fails` reads. The re-open
   *  has committed by then, so a throw there would lose the advance the task is waiting for. */
  function epochUnreadable(t: ReturnType<typeof setup>, fails: number): Database {
    let left = fails;
    return {
      ...t.db,
      query: {
        ...t.db.query,
        tasks: {
          ...t.db.query.tasks,
          findFirst: async (opts: unknown) => {
            if (left-- > 0) throw unreadable;
            return (t.db.query.tasks.findFirst as (o: unknown) => Promise<unknown>)(opts);
          },
        },
      },
    } as unknown as Database;
  }

  it('queues the advance unstamped and warns, rather than lose it to the read', async () => {
    config('auto', 'normal');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const t = setup();

    await checkProviderRecovery(epochUnreadable(t, 1));

    expect(t.task(), 'the task was re-opened').toMatchObject({
      status: 'running',
      allowanceAutoResumeCount: 1,
    });
    expect(h.queued, 'and its advance was queued').toMatchObject([
      {
        name: TASK_JOB_NAMES.ADVANCE_STEP,
        data: { taskId: TASK, userId: USER, stepId: 'fan-out', round: 0 },
      },
    ]);
    expect(epochOf(h.queued[0]), 'with no epoch to carry').toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, err: unreadable }),
      expect.any(String),
    );
    expect(error, 'the failed read is no failed recovery').not.toHaveBeenCalled();
  });

  it('stamps the next task it resumes with its own epoch', async () => {
    config('auto', 'normal');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const t = setup();
    t.fake.insert(schema.tasks, { ...t.task(), id: NEXT_TASK, orchestrationEpoch: 11 });
    t.fake.insert(schema.taskSteps, {
      id: NEXT_ROW,
      taskId: NEXT_TASK,
      stepId: 'fan-out',
      round: 0,
      status: 'failed',
    });
    t.next.push({ ...t.armed, id: NEXT_TASK });

    await checkProviderRecovery(epochUnreadable(t, 1));

    expect(h.queued).toHaveLength(2);
    expect(h.queued[0]).toMatchObject({ data: { taskId: TASK } });
    expect(epochOf(h.queued[0])).toBeUndefined();
    expect(h.queued[1]).toMatchObject({ data: { taskId: NEXT_TASK, epoch: 11 } });
  });
});

describe('the allowance auto-resume when resuming one task throws', () => {
  afterEach(() => vi.restoreAllMocks());

  it('leaves the task failed with its watch armed and goes on to resume the next armed task', async () => {
    config('auto', 'normal');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const t = setup();
    t.fake.insert(schema.tasks, { ...t.task(), id: NEXT_TASK });
    t.fake.insert(schema.taskSteps, {
      id: NEXT_ROW,
      taskId: NEXT_TASK,
      stepId: 'fan-out',
      round: 0,
      status: 'failed',
    });
    t.next.push({ ...t.armed, id: NEXT_TASK });
    const dropped = new Error('connection terminated unexpectedly');
    let broken = true;
    t.fake.hooks.beforeUpdate = (table) => {
      if (broken && table === schema.taskSteps) {
        broken = false;
        throw dropped;
      }
    };

    await checkProviderRecovery(t.db);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, providerId: PROVIDER, err: dropped }),
      expect.any(String),
    );
    expect(t.task()).toMatchObject({
      status: 'failed',
      allowanceAutoResumeCount: 0,
      awaitingAllowanceProviderId: PROVIDER,
      allowanceReplenishedAt: null,
    });
    expect(t.task(NEXT_TASK)).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
    expect(h.queued).toMatchObject([
      { name: TASK_JOB_NAMES.ADVANCE_STEP, data: { taskId: NEXT_TASK } },
    ]);
    expect(t.fake.rows(schema.taskEvents)).toMatchObject([
      { taskId: NEXT_TASK, eventType: 'task.auto_resumed' },
    ]);
  });
});

describe('the provider recovery when one armed task fails on its own writes', () => {
  afterEach(() => vi.restoreAllMocks());
  const dropped = new Error('connection terminated unexpectedly');

  /** Two armed tasks. `first` changes the one handled first; the second is the one that must still be handled. */
  function twoTasks(first: Record<string, unknown> = {}) {
    const t = setup();
    t.fake.insert(schema.tasks, { ...t.task(), id: NEXT_TASK });
    t.fake.insert(schema.taskSteps, {
      id: NEXT_ROW,
      taskId: NEXT_TASK,
      stepId: 'fan-out',
      round: 0,
      status: 'failed',
    });
    t.next.push({ ...t.armed, id: NEXT_TASK });
    Object.assign(t.armed, first);
    return t;
  }
  /** Fails the first write to `table` and no other. */
  function breakOnce(
    t: ReturnType<typeof setup>,
    hook: 'beforeInsert' | 'beforeUpdate',
    table: PgTable,
  ) {
    let broken = true;
    t.fake.hooks[hook] = (written) => {
      if (broken && written === table) {
        broken = false;
        throw dropped;
      }
    };
  }
  const expectLogged = (error: unknown) => {
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, providerId: PROVIDER, err: dropped }),
      expect.any(String),
    );
  };
  const advanceOfNext = [{ name: TASK_JOB_NAMES.ADVANCE_STEP, data: { taskId: NEXT_TASK } }];

  it('goes on to the next armed task when the notify stamp of one cannot be written', async () => {
    config('notify', 'normal');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const t = twoTasks();
    breakOnce(t, 'beforeUpdate', schema.tasks);

    await checkProviderRecovery(t.db);

    expectLogged(error);
    expect(t.task().allowanceReplenishedAt).toBeNull();
    expect(t.task(NEXT_TASK).allowanceReplenishedAt).toBeInstanceOf(Date);
    expect(t.fake.rows(schema.taskEvents)).toMatchObject([
      { taskId: NEXT_TASK, eventType: 'task.allowance_replenished' },
    ]);
  });

  it('goes on to the next armed task when the notify event of one cannot be written', async () => {
    config('notify', 'normal');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const t = twoTasks();
    breakOnce(t, 'beforeInsert', schema.taskEvents);

    await checkProviderRecovery(t.db);

    expectLogged(error);
    expect(t.task(NEXT_TASK).allowanceReplenishedAt).toBeInstanceOf(Date);
    expect(t.fake.rows(schema.taskEvents)).toMatchObject([
      { taskId: NEXT_TASK, eventType: 'task.allowance_replenished' },
    ]);
  });

  it('goes on to the next armed task when the queue exhausts retries of the advance of a resumed one', async () => {
    config('auto', 'normal');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const t = twoTasks();
    h.failNextAdd = dropped;
    h.refusals = 3;

    await checkProviderRecovery(t.db);

    expectLogged(error);
    expect(t.task(NEXT_TASK)).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
    expect(h.queued).toMatchObject(advanceOfNext);
  });

  it('goes on to the next armed task when the watch of one that never cleared cannot be dropped', async () => {
    config('auto', 'normal');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const t = twoTasks({ reason: 'server_error', since: null });
    breakOnce(t, 'beforeUpdate', schema.tasks);

    await checkProviderRecovery(t.db);

    expectLogged(error);
    expect(t.task()).toMatchObject({ awaitingAllowanceProviderId: PROVIDER });
    expect(t.task(NEXT_TASK)).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
    expect(h.queued).toMatchObject(advanceOfNext);
  });

  it('goes on to the next armed task when the backfilled reset of one cannot be saved', async () => {
    config('auto', 'normal');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const t = twoTasks({ resetAt: null });
    t.fake.insert(schema.usageWindowSnapshots, {
      providerId: PROVIDER,
      userId: USER,
      providerName: 'claude-code',
      status: 'ok',
      fetchedAt: new Date(),
      fiveHourPct: 95,
      fiveHourResetAt: new Date(Date.now() + 3_600_000),
    });
    breakOnce(t, 'beforeUpdate', schema.tasks);

    await checkProviderRecovery(t.db);

    expectLogged(error);
    expect(t.task()).toMatchObject({ allowanceResetAt: expect.any(Date) });
    expect(t.task(NEXT_TASK)).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
    expect(h.queued).toMatchObject(advanceOfNext);
  });
});

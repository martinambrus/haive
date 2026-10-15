import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { CONFIG_KEYS, TASK_JOB_NAMES, configService, logger } from '@haive/shared';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const h = vi.hoisted(() => ({ queued: [] as { name: string; data: unknown }[] }));

vi.mock('../src/queues/task-queue.js', () => ({
  getTaskQueue: () => ({
    add: async (name: string, data: unknown) => {
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

/** The stored state, read past the cache once per check: each value answers one read, then normal. */
function storedStates(...values: string[]) {
  const queue = [...values];
  vi.spyOn(configService, 'get').mockImplementation(async (key) => {
    if (key === CONFIG_KEYS.ALLOWANCE_WATCH_MODE) return 'auto';
    return key === CONFIG_KEYS.MAINTENANCE_STATE ? 'normal' : null;
  });
  vi.spyOn(configService, 'getFresh').mockImplementation(async (key) =>
    key === CONFIG_KEYS.MAINTENANCE_STATE ? (queue.shift() ?? 'normal') : null,
  );
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
});

describe('the allowance auto-resume of a task whose provider is back', () => {
  it('resumes it and queues its step while the system is normal', async () => {
    config('auto', 'normal');
    const t = setup();

    await checkProviderRecovery(t.db);

    expect(t.task()).toMatchObject({ status: 'running', allowanceAutoResumeCount: 1 });
    expect(h.queued).toMatchObject([
      { name: TASK_JOB_NAMES.ADVANCE_STEP, data: { taskId: TASK, stepId: 'fan-out' } },
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
  afterEach(() => vi.restoreAllMocks());

  it('warns, treats the system as normal, and goes on to resume the next armed task', async () => {
    config('auto', 'normal');
    vi.spyOn(configService, 'getFresh').mockImplementation(async (key) => {
      if (key === CONFIG_KEYS.MAINTENANCE_STATE) throw new Error('redis went away');
      return null;
    });
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
});

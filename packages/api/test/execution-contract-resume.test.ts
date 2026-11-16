import { AsyncLocalStorage } from 'node:async_hooks';
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@haive/database';
import { configService } from '@haive/shared';
import { createFakeDb } from '@haive/database/testing';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  paused: true,
  beforeLift: () => {},
  add: vi.fn(async () => undefined),
  kill: vi.fn(async () => 0),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: h.kill }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(k: string, v: string): void }, next: () => Promise<void>) => {
    c.set('userId', '00000000-0000-4000-8000-000000000001');
    c.set('userRole', 'admin');
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('@haive/shared', async (original) => {
  const shared = await original<typeof import('@haive/shared')>();
  return {
    ...shared,
    configService: {
      getFresh: async () => String(h.paused),
      set: async (key: string, value: string) => {
        expect(key).toBe(shared.CONFIG_KEYS.GLOBAL_PAUSE);
        if (value === 'false') h.beforeLift();
        h.paused = value === 'true';
      },
    },
  };
});
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { adminRoutes } from '../src/routes/admin.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const OWNER = '00000000-0000-4000-8000-000000000002';
const ADMIN = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-000000000003';
const STAMP = new Date('2026-01-01');
const empty = { version: 1, guardedSpans: [] };
const guarded = {
  version: 1,
  guardedSpans: [
    {
      id: 'a',
      firstStepId: 'report',
      lastStepId: 'report',
      predicateId: 'module.fx.planned',
      args: {},
    },
  ],
};
const fixed = { ...empty, fixTarget: { stepId: 'report', capabilityVersion: 1 } };
const unsupported = [guarded, fixed, { version: 99 }];
const app = new Hono<AppEnv>();
app.route('/admin/maintenance', maintenanceRoutes);
app.route('/admin', adminRoutes);
app.onError(errorHandler);
const request = (path: string, body: unknown, method = 'POST') =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
function setup(contract: unknown, pausedAt: Date | null = STAMP) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    auditEvents: schema.auditEvents,
  });
  h.db = fake.db;
  fake.insert(schema.tasks, {
    id: TASK,
    userId: OWNER,
    type: 'test',
    status: 'running',
    executionContract: contract,
    pausedAt,
    orchestrationEpoch: 3,
  });
  return fake;
}
const state = (fake: ReturnType<typeof setup>) =>
  structuredClone([
    fake.rows(schema.tasks),
    fake.rows(schema.taskEvents),
    fake.rows(schema.auditEvents),
  ]);
beforeEach(() => {
  h.paused = true;
  h.beforeLift = () => {};
  h.add.mockClear();
  h.kill.mockClear();
});
it.each(unsupported)(
  'admin Resume refuses an unsupported pin before any effect',
  async (contract) => {
    const fake = setup(contract);
    const before = state(fake);
    const res = await request(`/admin/maintenance/tasks/${TASK}/action`, { action: 'resume' });
    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'invalid-execution-contract' });
    expect(state(fake)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
  },
);
it.each([null, empty])('admin Resume retains supported pin behavior', async (contract) => {
  const fake = setup(contract);
  const res = await request(`/admin/maintenance/tasks/${TASK}/action`, { action: 'resume' });
  expect(res.status, await res.clone().text()).toBe(200);
  expect(fake.rows(schema.tasks)[0]).toMatchObject({
    pausedAt: null,
    executionContract: contract,
    orchestrationEpoch: 3,
  });
  expect(fake.rows(schema.taskEvents)).toMatchObject([{ eventType: 'task.resumed' }]);
  expect(fake.rows(schema.auditEvents)).toMatchObject([{ action: 'task.admin_resume' }]);
});
it.each(unsupported)(
  'global lift skips and reports an unsupported pin while ordinary work resumes',
  async (contract) => {
    const fake = setup(contract);
    const unheld = '00000000-0000-4000-8000-000000000004';
    fake.insert(schema.tasks, {
      id: unheld,
      userId: OWNER,
      type: 'test',
      status: 'queued',
      executionContract: contract,
    });
    for (const pin of [null, empty]) {
      fake.insert(schema.tasks, {
        userId: OWNER,
        type: 'test',
        status: 'running',
        executionContract: pin,
      });
    }
    for (const status of ['completed', 'cancelled'] as const) {
      fake.insert(schema.tasks, {
        userId: OWNER,
        type: 'test',
        status,
        executionContract: contract,
      });
    }
    fake.insert(schema.tasks, {
      userId: OWNER,
      type: 'test',
      status: 'running',
      executionContract: contract,
      deadAt: STAMP,
    });
    const before = structuredClone(fake.rows(schema.tasks));
    let heldBeforeLift = false;
    h.beforeLift = () => {
      // The durable per-task hold must already exist when the global switch is released.
      heldBeforeLift =
        fake.rows(schema.tasks).find((t) => t.id === unheld)?.pausedAt instanceof Date;
    };
    const res = await request('/admin/config/global-pause', { paused: false }, 'PUT');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(heldBeforeLift, 'unsupported task must be held before the global switch is lifted').toBe(
      true,
    );
    expect(await res.json()).toEqual({
      paused: false,
      skippedTasks: [
        { taskId: TASK, code: 'invalid-execution-contract', reason: expect.any(String) },
        { taskId: unheld, code: 'invalid-execution-contract', reason: expect.any(String) },
      ],
    });
    expect(h.paused).toBe(false);
    for (const row of before) {
      const after = fake.rows(schema.tasks).find((t) => t.id === row.id);
      if (row.id === unheld)
        expect(after).toMatchObject({
          ...row,
          pausedAt: expect.any(Date),
          updatedAt: expect.any(Date),
        });
      else expect(after).toEqual(row);
    }
    const stamp = fake.rows(schema.tasks).find((t) => t.id === unheld)?.pausedAt as Date;
    expect(fake.rows(schema.taskEvents)).toMatchObject([
      {
        taskId: unheld,
        eventType: 'task.paused',
        payload: { by: ADMIN, byAdmin: true, reason: 'unsupported-execution-contract' },
      },
    ]);
    expect(fake.rows(schema.taskEvents)).toHaveLength(1);
    expect(fake.rows(schema.auditEvents)).toMatchObject([
      {
        actorUserId: ADMIN,
        action: 'task.admin_pause',
        targetType: 'task',
        targetId: unheld,
        metadata: {
          ownerUserId: OWNER,
          pausedAt: stamp.toISOString(),
          reason: 'invalid-execution-contract',
        },
      },
      { action: 'config.global_pause', metadata: { from: true, to: false } },
    ]);
    expect(fake.rows(schema.auditEvents)).toHaveLength(2);
    expect(h.add).not.toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
  },
);
it('an already-off global lift leaves unsupported tasks and their pause evidence untouched', async () => {
  const fake = setup(guarded, null);
  h.paused = false;
  const before = structuredClone(fake.rows(schema.tasks));

  const res = await request('/admin/config/global-pause', { paused: false }, 'PUT');

  expect(res.status, await res.clone().text()).toBe(200);
  expect(fake.rows(schema.tasks)).toEqual(before);
  expect(await res.json()).toEqual({ paused: false });
  expect(fake.rows(schema.taskEvents)).toEqual([]);
  expect(fake.rows(schema.auditEvents)).toMatchObject([
    { action: 'config.global_pause', metadata: { from: false, to: false } },
  ]);
  expect(fake.rows(schema.auditEvents)).toHaveLength(1);
  expect(h.paused).toBe(false);
});
it('a task hold lock timeout answers 503 before the config save and leaves the switch on', async () => {
  const fake = setup(guarded, null);
  const before = state(fake);
  const statements: string[][] = [];
  const transaction = fake.db.transaction;
  vi.spyOn(fake.db, 'transaction').mockImplementation((run) =>
    transaction(async (tx) => {
      const queries: string[] = [];
      statements.push(queries);
      const execute = tx.execute;
      tx.execute = async (query) => {
        queries.push(new PgDialect().sqlToQuery(query as SQL).sql);
        return execute(query);
      };
      return run(tx);
    }),
  );
  fake.hooks.beforeUpdate = (table) => {
    if (table === schema.tasks)
      throw new Error('task hold failed', {
        cause: Object.assign(new Error('lock timeout'), { code: '55P03' }),
      });
  };

  const res = await request('/admin/config/global-pause', { paused: false }, 'PUT');

  expect(res.status, await res.clone().text()).toBe(503);
  expect(await res.json()).toEqual({
    error: 'Another save of this setting is in progress; try again',
    code: null,
  });
  expect(state(fake)).toEqual(before);
  expect(h.paused).toBe(true);
  expect(statements).toHaveLength(1);
  expect(statements[0]?.[0]).toBe("SET LOCAL lock_timeout = '30000ms'");
  expect(statements[0]).toHaveLength(1);
  expect(h.add).not.toHaveBeenCalled();
  expect(h.kill).not.toHaveBeenCalled();
});
it.each([schema.taskEvents, schema.auditEvents])(
  'a refused hold evidence insert rolls back the task hold and keeps the global switch on',
  async (refusedTable) => {
    const fake = setup(guarded, null);
    const before = state(fake);
    fake.hooks.beforeInsert = (table) => {
      if (table === refusedTable && fake.rows(schema.tasks)[0]?.pausedAt)
        throw new Error('hold evidence refused');
    };

    const res = await request('/admin/config/global-pause', { paused: false }, 'PUT');

    expect(res.status).toBe(500);
    expect(state(fake)).toEqual(before);
    expect(h.paused).toBe(true);
    expect(h.add).not.toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
  },
);
it('global pause engagement leaves tasks untouched', async () => {
  const fake = setup(guarded);
  const before = structuredClone(fake.rows(schema.tasks));
  const res = await request('/admin/config/global-pause', { paused: true }, 'PUT');
  expect(res.status).toBe(200);
  expect(fake.rows(schema.tasks)).toEqual(before);
});

// Model a finite pool separately from the fake database's real per-key advisory mutex.
// A savepoint borrows no connection; a root transaction does. Fail a nested borrow by
// the config-lock owner as if the pool/lock timeout fired, so regressions cannot hang.
it.each([1, 2, 3])('completes N+1 global lifts with an injected pool of %i', async (size) => {
  const fake = setup(guarded, null);
  const context = new AsyncLocalStorage<{ configLockHeld: boolean }>();
  const firstWave = Promise.withResolvers<void>();
  const waiting: Array<() => void> = [];
  let inUse = 0;
  let peak = 0;
  let acquisitions = 0;
  let nestedBorrows = 0;
  const transaction = fake.db.transaction;
  vi.spyOn(fake.db, 'transaction').mockImplementation(async (run) => {
    if (context.getStore()?.configLockHeld) {
      nestedBorrows += 1;
      throw Object.assign(new Error('pool acquire blocked behind the config lock owner'), {
        code: '55P03',
      });
    }
    if (inUse === size) await new Promise<void>((resolve) => waiting.push(resolve));
    else inUse += 1;
    peak = Math.max(peak, inUse);
    if (++acquisitions === size) firstWave.resolve();
    await firstWave.promise;
    try {
      return await context.run({ configLockHeld: false }, () =>
        transaction(async (tx) => {
          const execute = tx.execute;
          tx.execute = async (query) => {
            const result = await execute(query);
            if (new PgDialect().sqlToQuery(query as SQL).sql.includes('pg_advisory_xact_lock'))
              context.getStore()!.configLockHeld = true;
            return result;
          };
          return run(tx);
        }),
      );
    } finally {
      const next = waiting.shift();
      if (next) next();
      else inUse -= 1;
    }
  });

  const responses = await Promise.all(
    Array.from({ length: size + 1 }, () =>
      request('/admin/config/global-pause', { paused: false }, 'PUT'),
    ),
  );

  expect(nestedBorrows, 'no config-lock owner may borrow a second pooled connection').toBe(0);
  expect(responses.map((res) => res.status)).toEqual(Array(size + 1).fill(200));
  expect(peak).toBe(size);
  expect(inUse).toBe(0);
  expect(waiting).toEqual([]);
  expect(h.paused).toBe(false);
  expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeInstanceOf(Date);
  expect(fake.rows(schema.taskEvents)).toHaveLength(1);
  expect(
    fake.rows(schema.auditEvents).filter((row) => row.action === 'task.admin_pause'),
  ).toHaveLength(1);
  expect(
    fake.rows(schema.auditEvents).filter((row) => row.action === 'config.global_pause'),
  ).toHaveLength(size + 1);
});

it('keeps the committed task hold and evidence when the later config write fails', async () => {
  const fake = setup(guarded, null);
  h.beforeLift = () => {
    throw new Error('redis write failed');
  };

  const res = await request('/admin/config/global-pause', { paused: false }, 'PUT');

  expect(res.status).toBe(500);
  expect(h.paused).toBe(true);
  expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeInstanceOf(Date);
  expect(fake.rows(schema.taskEvents)).toMatchObject([
    { taskId: TASK, eventType: 'task.paused', payload: { by: ADMIN, byAdmin: true } },
  ]);
  expect(fake.rows(schema.taskEvents)).toHaveLength(1);
  expect(fake.rows(schema.auditEvents)).toMatchObject([
    { targetId: TASK, action: 'task.admin_pause' },
  ]);
  expect(fake.rows(schema.auditEvents)).toHaveLength(1);
});

it('allows an extra unsupported-task hold when another lift turns the switch off after the read', async () => {
  const fake = setup(guarded, null);
  vi.spyOn(configService, 'getFresh').mockImplementationOnce(async () => {
    h.paused = false;
    return 'true';
  });

  const res = await request('/admin/config/global-pause', { paused: false }, 'PUT');

  expect(res.status, await res.clone().text()).toBe(200);
  expect(h.paused).toBe(false);
  expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeInstanceOf(Date);
  expect(fake.rows(schema.taskEvents)).toHaveLength(1);
  expect(fake.rows(schema.auditEvents)).toMatchObject([
    { targetId: TASK, action: 'task.admin_pause' },
    { action: 'config.global_pause', metadata: { from: false, to: false } },
  ]);
  expect(fake.rows(schema.auditEvents)).toHaveLength(2);
});

it('holds unsupported tasks after saving when the switch turns on after the pre-read', async () => {
  const fake = setup(guarded, null);
  h.paused = false;
  vi.spyOn(configService, 'getFresh').mockImplementationOnce(async () => {
    h.paused = true;
    return 'false';
  });
  h.beforeLift = () => {
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeNull();
    expect(fake.rows(schema.taskEvents)).toEqual([]);
  };

  const res = await request('/admin/config/global-pause', { paused: false }, 'PUT');

  expect(res.status, await res.clone().text()).toBe(200);
  expect(h.paused).toBe(false);
  expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeInstanceOf(Date);
  expect(await res.json()).toEqual({
    paused: false,
    skippedTasks: [
      { taskId: TASK, code: 'invalid-execution-contract', reason: expect.any(String) },
    ],
  });
  expect(fake.rows(schema.taskEvents)).toMatchObject([
    { taskId: TASK, eventType: 'task.paused', payload: { by: ADMIN, byAdmin: true } },
  ]);
  expect(fake.rows(schema.taskEvents)).toHaveLength(1);
  expect(fake.rows(schema.auditEvents)).toMatchObject([
    { action: 'config.global_pause', metadata: { from: true, to: false } },
    { targetId: TASK, action: 'task.admin_pause' },
  ]);
  expect(fake.rows(schema.auditEvents)).toHaveLength(2);
});

it('reports recovery when a raced post-save hold times out after the switch is lifted', async () => {
  const fake = setup(guarded, null);
  h.paused = false;
  vi.spyOn(configService, 'getFresh').mockImplementationOnce(async () => {
    h.paused = true;
    return 'false';
  });
  fake.hooks.beforeUpdate = (table) => {
    if (table === schema.tasks) {
      expect(h.paused).toBe(false);
      expect(fake.rows(schema.auditEvents)).toMatchObject([
        { action: 'config.global_pause', metadata: { from: true, to: false } },
      ]);
      throw new Error('task hold failed', {
        cause: Object.assign(new Error('lock timeout'), { code: '55P03' }),
      });
    }
  };

  const res = await request('/admin/config/global-pause', { paused: false }, 'PUT');

  expect(res.status, await res.clone().text()).toBe(503);
  const body = await res.json();
  expect(body).toEqual({
    error:
      'The global pause was lifted, but holding the affected tasks failed; turn the switch on and lift it again to re-run the holds',
    code: null,
  });
  expect(body).not.toMatchObject({ error: expect.stringContaining('Another save') });
  expect(h.paused).toBe(false);
  expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeNull();
  expect(fake.rows(schema.taskEvents)).toEqual([]);
  expect(fake.rows(schema.auditEvents)).toMatchObject([
    { action: 'config.global_pause', metadata: { from: true, to: false } },
  ]);
  expect(fake.rows(schema.auditEvents)).toHaveLength(1);
  expect(h.add).not.toHaveBeenCalled();
  expect(h.kill).not.toHaveBeenCalled();
});

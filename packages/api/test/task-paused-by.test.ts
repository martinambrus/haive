import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  tasks: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  eventReads: 0,
  role: 'user' as string,
}));
const schemaRef = vi.hoisted(() => ({}) as { taskEvents: unknown });

function stubDb() {
  const chain = (table: unknown, fields: Record<string, unknown> | undefined) => {
    const q: Record<string, unknown> = {};
    for (const m of ['where', 'orderBy', 'limit', 'offset', 'innerJoin', 'leftJoin', 'groupBy']) {
      q[m] = () => q;
    }
    q.then = (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => {
      if (table === schemaRef.taskEvents) h.eventReads += 1;
      const rows =
        table === schemaRef.taskEvents
          ? h.events
          : fields && 'n' in fields
            ? [{ n: h.tasks.length }]
            : [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    return q;
  };
  return {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => chain(table, fields),
    }),
    selectDistinct: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => chain(table, fields),
    }),
    query: {
      tasks: {
        findMany: async (opts: { where?: unknown }) => (opts.where ? h.tasks : []),
        findFirst: async () => h.tasks[0],
      },
    },
  };
}

vi.mock('../src/db.js', () => ({ getDb: () => stubDb() }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    c.set('userRole', h.role);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...actual,
    configService: {
      ...actual.configService,
      get: async () => 'USD',
      getBoolean: async () => false,
    },
  };
});
vi.mock('@haive/shared/stats-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/stats-server')>()),
  resolveCostDisplay: async () => ({ currency: 'USD', rate: 1 }),
}));
vi.mock('../src/routes/tasks/_call-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/routes/tasks/_call-log.js')>()),
  loadLoggedCallCount: async () => ({ logged: 0, running: 0 }),
}));
vi.mock('../src/routes/tasks/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/routes/tasks/_helpers.js')>()),
  findQueuedInvocationStepIds: async () => new Set<string>(),
  sumTaskTokens: async () => new Map(),
  resolveCurrentStepCliProviderIds: async () => new Map(),
  enrichStepsWithCliPreferences: async (_db: unknown, _f: unknown, _u: unknown, rows: unknown[]) =>
    rows,
  enrichStepsWithSkipFlag: async (_db: unknown, _f: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithCliStats: async (_db: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithActiveRole: async (_db: unknown, _f: unknown, _id: unknown, rows: unknown[]) =>
    rows,
  enrichStepsWithAgentCounts: async (_db: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithCliUsage: (_flags: unknown, rows: unknown[]) => rows,
  findActiveCliInvocation: async () => null,
  sumTaskProviderBreakdown: async () => [],
  buildUpcomingCliSteps: async () => [],
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { findAdminPausedTaskIds } from '../src/routes/tasks/_helpers.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

schemaRef.taskEvents = schema.taskEvents;

const ADMIN_PAUSED = '00000000-0000-4000-8000-000000000001';
const OWNER_PAUSED = '00000000-0000-4000-8000-000000000002';
const RUNNING = '00000000-0000-4000-8000-000000000003';
const PAUSED_AT = new Date('2026-10-14T09:00:00.000Z');

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

function taskRow(id: string, pausedAt: Date | null) {
  return {
    id,
    userId: USER,
    type: 'workflow',
    title: id,
    status: 'running',
    currentStepId: null,
    currentRound: 0,
    pausedAt,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(0),
    parentTaskId: null,
    ignoreSavedStepClis: false,
    awaitingAllowanceProviderId: null,
    awaitingProviderReason: null,
    allowanceReplenishedAt: null,
    allowanceAutoResumedAt: null,
  };
}

describe('findAdminPausedTaskIds', () => {
  const A = '00000000-0000-4000-8000-0000000000a1';
  const B = '00000000-0000-4000-8000-0000000000a2';
  const C = '00000000-0000-4000-8000-0000000000a3';

  function eventsOf(
    rows: {
      id?: string;
      taskId: string;
      eventType: string;
      payload: Record<string, unknown>;
      createdAt?: Date;
    }[],
  ) {
    const fake = createFakeDb({ taskEvents: schema.taskEvents });
    for (const row of rows) fake.insert(schema.taskEvents, row);
    return fake.db as never;
  }
  const paused = (taskId: string, payload: Record<string, unknown>) => ({
    taskId,
    eventType: 'task.paused',
    payload,
  });

  it('names a task an administrator paused and not one its owner paused', async () => {
    const db = eventsOf([
      paused(A, { by: 'admin-1', byAdmin: true, reason: 'maintenance' }),
      paused(B, { by: 'owner-1' }),
    ]);

    expect([...(await findAdminPausedTaskIds(db, [A, B, C]))]).toEqual([A]);
  });

  it('reads the latest pause, so a pause the owner made after an administrator lifted theirs is the owner', async () => {
    const db = eventsOf([
      paused(A, { by: 'admin-1', byAdmin: true }),
      { taskId: A, eventType: 'task.resumed', payload: { by: 'owner-1' } },
      paused(A, { by: 'owner-1' }),
      paused(B, { by: 'owner-1' }),
      paused(B, { by: 'admin-1', byAdmin: true }),
    ]);

    expect([...(await findAdminPausedTaskIds(db, [A, B]))]).toEqual([B]);
  });

  it('reads two pauses with the same stamp by id, whichever of them was written first', async () => {
    const at = new Date('2026-10-14T09:00:00.000Z');
    const lower = {
      id: '00000000-0000-4000-8000-000000000a01',
      ...paused(A, { by: 'owner-1' }),
      createdAt: at,
    };
    const higher = {
      id: '00000000-0000-4000-8000-000000000a02',
      ...paused(A, { by: 'admin-1', byAdmin: true }),
      createdAt: at,
    };

    expect([...(await findAdminPausedTaskIds(eventsOf([lower, higher]), [A]))]).toEqual([A]);
    expect([...(await findAdminPausedTaskIds(eventsOf([higher, lower]), [A]))]).toEqual([A]);
  });

  it('keys on the pause event alone, not on any other event an administrator wrote', async () => {
    const db = eventsOf([
      { taskId: A, eventType: 'task.stopped', payload: { by: 'admin-1', byAdmin: true } },
      { taskId: A, eventType: 'task.resumed', payload: { by: 'admin-1', byAdmin: true } },
      paused(A, { by: 'owner-1' }),
    ]);

    expect((await findAdminPausedTaskIds(db, [A])).size).toBe(0);
  });

  it('asks the database nothing for no tasks', async () => {
    const select = vi.fn();

    expect((await findAdminPausedTaskIds({ select } as never, [])).size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });
});

describe('who paused a task, as the owner reads it', () => {
  beforeEach(() => {
    h.role = 'user';
    h.eventReads = 0;
    h.tasks = [
      taskRow(ADMIN_PAUSED, PAUSED_AT),
      taskRow(OWNER_PAUSED, PAUSED_AT),
      taskRow(RUNNING, null),
    ];
    h.events = [
      {
        taskId: OWNER_PAUSED,
        eventType: 'task.paused',
        payload: { by: USER },
        createdAt: new Date('2026-10-14T09:00:01.000Z'),
      },
      {
        taskId: ADMIN_PAUSED,
        eventType: 'task.paused',
        payload: { by: 'admin-1', byAdmin: true, reason: 'maintenance' },
        createdAt: new Date('2026-10-14T09:00:00.000Z'),
      },
    ];
  });

  it('the list carries pausedByAdmin on each task', async () => {
    const res = await app.request('/tasks?includeChats=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string; pausedByAdmin: boolean }[] };
    expect(Object.fromEntries(body.tasks.map((t) => [t.id, t.pausedByAdmin]))).toEqual({
      [ADMIN_PAUSED]: true,
      [OWNER_PAUSED]: false,
      [RUNNING]: false,
    });
  });

  it('the list reads no events when no task on the page is paused', async () => {
    h.tasks = [taskRow(RUNNING, null)];
    h.events = [];
    const res = await app.request('/tasks?includeChats=1');
    expect(res.status).toBe(200);
    expect(h.eventReads).toBe(0);
  });

  it.each([
    [ADMIN_PAUSED, true],
    [OWNER_PAUSED, false],
    [RUNNING, false],
  ])('the detail of %s carries pausedByAdmin %s', async (id, expected) => {
    h.tasks = h.tasks.filter((t) => t.id === id);
    const res = await app.request(`/tasks/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { pausedByAdmin: boolean } };
    expect(body.task.pausedByAdmin).toBe(expected);
  });
});

describe('whether the viewer may lift the pause, as the detail reads it', () => {
  it.each([
    ['the owner of an administrator pause', ADMIN_PAUSED, 'user', true],
    ['an administrator viewing an administrator pause', ADMIN_PAUSED, 'admin', false],
    ['the owner of their own pause', OWNER_PAUSED, 'user', false],
    ['the owner of an unpaused task', RUNNING, 'user', false],
  ])('carries pauseLocked for %s', async (_name, id, role, expected) => {
    h.role = role;
    h.eventReads = 0;
    h.tasks = [taskRow(id, id === RUNNING ? null : PAUSED_AT)];
    h.events = [
      {
        taskId: ADMIN_PAUSED,
        eventType: 'task.paused',
        payload: { by: 'admin-1', byAdmin: true, reason: 'maintenance' },
        createdAt: new Date('2026-10-14T09:00:00.000Z'),
      },
      {
        taskId: OWNER_PAUSED,
        eventType: 'task.paused',
        payload: { by: USER },
        createdAt: new Date('2026-10-14T09:00:01.000Z'),
      },
    ];
    const res = await app.request(`/tasks/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { pauseLocked: boolean } };
    expect(body.task.pauseLocked).toBe(expected);
  });
});

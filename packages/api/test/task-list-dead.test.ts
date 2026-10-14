import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.TASK_LIST_DEAD_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_list_dead_test'))
  throw new Error('Use a dedicated task_list_dead_test database for task list dead tests');

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000d1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
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

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDatabase, schema, type Database } from '@haive/database';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const ALIVE = '00000000-0000-4000-8000-0000000000d2';
const DEAD = '00000000-0000-4000-8000-0000000000d3';
const STALE_REASON = '00000000-0000-4000-8000-0000000000d4';
const PARKED_ALIVE = '00000000-0000-4000-8000-0000000000d5';
const PARKED_DEAD = '00000000-0000-4000-8000-0000000000d6';
const CANCELLED_DEAD = '00000000-0000-4000-8000-0000000000d7';
const ALL = [ALIVE, DEAD, STALE_REASON, PARKED_ALIVE, PARKED_DEAD, CANCELLED_DEAD].sort();
const STARTED = new Date('2026-10-14T07:00:00.000Z');
const PARKED_SINCE = new Date('2026-10-14T08:00:00.000Z');
const DIED = new Date('2026-10-14T09:00:00.000Z');
const CANCELLED = new Date('2026-10-14T10:00:00.000Z');

type SlotWait = { kind: string; stepId: string } | null;

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

describe.skipIf(!url)('GET /tasks status filters and dead tasks, on Postgres', () => {
  let db: Database;

  const list = async (query = '') => {
    const res = await app.request(`/tasks${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as {
      tasks: { id: string; timing: { wallMs: number; idleMs: number }; slotWait: SlotWait }[];
      total: number;
    };
  };
  const idsFor = async (query = '') => (await list(query)).tasks.map((t) => t.id).sort();
  const slotWaitOf = async (id: string) => (await list()).tasks.find((t) => t.id === id)?.slotWait;
  const detailSlotWaitOf = async (id: string) => {
    const res = await app.request(`/tasks/${id}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { task: { slotWait: SlotWait } }).task.slotWait;
  };

  afterAll(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
    await db.delete(schema.users).where(eq(schema.users.id, USER));
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    db ??= createDatabase(url as string);
    h.db = db;
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
    await db.delete(schema.users).where(eq(schema.users.id, USER));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'x',
      emailBlindIndex: 'task-list-dead-test',
      passwordHash: 'x',
    });
    const task = (id: string, over: Partial<typeof schema.tasks.$inferInsert> = {}) => ({
      id,
      userId: USER,
      type: 'workflow',
      title: id,
      status: 'running' as const,
      startedAt: STARTED,
      ...over,
    });
    await db
      .insert(schema.tasks)
      .values([
        task(ALIVE),
        task(DEAD, { deadAt: DIED, deadReason: 'the run list names a step this install lacks' }),
        task(STALE_REASON, { deadAt: null, deadReason: 'left over from a task that revived' }),
        task(PARKED_ALIVE, { currentStepId: 'tld-park', currentRound: 0 }),
        task(PARKED_DEAD, { currentStepId: 'tld-park', currentRound: 0, deadAt: DIED }),
        task(CANCELLED_DEAD, { status: 'cancelled', deadAt: DIED, completedAt: CANCELLED }),
      ]);
    await db.insert(schema.taskSteps).values(
      [PARKED_ALIVE, PARKED_DEAD].map((taskId) => ({
        taskId,
        stepId: 'tld-park',
        stepIndex: 1,
        round: 0,
        title: 'a step waiting for a slot',
        status: 'pending' as const,
        waitingStartedAt: PARKED_SINCE,
      })),
    );
  });

  it('lists a running task that is not dead under status=running', async () => {
    expect(await idsFor('?status=running')).toContain(ALIVE);
  });

  it('keys on dead_at, so a dead_reason left on a revived task does not hide it', async () => {
    expect(await idsFor('?status=running')).toContain(STALE_REASON);
  });

  it('leaves a dead task out of status=running, whose total agrees', async () => {
    const running = await list('?status=running');
    expect(running.tasks.map((t) => t.id)).not.toContain(DEAD);
    expect(running.total).toBe(running.tasks.length);
  });

  it('still lists the dead task in the unfiltered list', async () => {
    expect(await idsFor()).toEqual(ALL);
  });

  it('lists a task parked for a slot that is not dead under status=waiting_slot', async () => {
    expect(await idsFor('?status=waiting_slot')).toContain(PARKED_ALIVE);
  });

  it('leaves a dead task parked for a slot out of status=waiting_slot', async () => {
    expect(await idsFor('?status=waiting_slot')).not.toContain(PARKED_DEAD);
  });

  it('reports no slot wait for a dead task parked for a slot', async () => {
    expect(await slotWaitOf(PARKED_DEAD)).toBeNull();
  });

  it('still reports the slot wait of a task parked for a slot that is not dead', async () => {
    expect(await slotWaitOf(PARKED_ALIVE)).toMatchObject({ kind: 'runtime', stepId: 'tld-park' });
  });

  it('reports no slot wait for a dead task parked for a slot on GET /tasks/:id either', async () => {
    expect(await detailSlotWaitOf(PARKED_DEAD)).toBeNull();
  });

  it('still reports the slot wait of a parked task that is not dead on GET /tasks/:id', async () => {
    expect(await detailSlotWaitOf(PARKED_ALIVE)).toMatchObject({
      kind: 'runtime',
      stepId: 'tld-park',
    });
  });

  describe('clocks', () => {
    const NOW = Date.parse('2026-10-14T12:00:00.000Z');
    const SECOND = 1000;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const timingsAt = async (nowMs: number) => {
      vi.setSystemTime(nowMs);
      return new Map((await list()).tasks.map((t) => [t.id, t.timing]));
    };

    it('stops a dead task at dead_at: the same on two calls a second apart', async () => {
      const first = await timingsAt(NOW);
      const second = await timingsAt(NOW + SECOND);
      expect(second.get(DEAD)).toEqual(first.get(DEAD));
      expect(first.get(DEAD)?.wallMs).toBe(DIED.getTime() - STARTED.getTime());
      expect(second.get(PARKED_DEAD)).toEqual(first.get(PARKED_DEAD));
      expect(first.get(PARKED_DEAD)?.idleMs).toBe(DIED.getTime() - PARKED_SINCE.getTime());
    });

    it('stops a task cancelled after it died at completed_at, not at dead_at', async () => {
      const first = await timingsAt(NOW);
      const second = await timingsAt(NOW + SECOND);
      expect(second.get(CANCELLED_DEAD)).toEqual(first.get(CANCELLED_DEAD));
      expect(first.get(CANCELLED_DEAD)?.wallMs).toBe(CANCELLED.getTime() - STARTED.getTime());
    });

    it('still bills a running task that is not dead to now', async () => {
      const first = await timingsAt(NOW);
      const second = await timingsAt(NOW + SECOND);
      expect(first.get(ALIVE)?.wallMs).toBe(NOW - STARTED.getTime());
      for (const id of [ALIVE, STALE_REASON]) {
        expect(second.get(id)?.wallMs).toBe((first.get(id)?.wallMs ?? 0) + SECOND);
      }
      expect(first.get(PARKED_ALIVE)?.idleMs).toBe(NOW - PARKED_SINCE.getTime());
      expect(second.get(PARKED_ALIVE)?.idleMs).toBe(
        (first.get(PARKED_ALIVE)?.idleMs ?? 0) + SECOND,
      );
    });
  });
});

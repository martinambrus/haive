import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { AppEnv } from '@haive/shared/module-host';
import createStatsRoutes from '../src/routes.js';

async function request(db: FakeDbHandle) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', USER);
    c.set('userRole', 'user');
    await next();
  });
  app.route('/m/statistics', createStatsRoutes({ db: db as unknown as Database }));
  const res = await app.request('/m/statistics/estimates?from=2026-10-31&to=2026-11-02');
  expect(res.status).toBe(200);
  return (await res.json()) as ReturnType<typeof buildEstimationAccuracy>;
}

import { schema } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import type { buildEstimationAccuracy } from '@haive/shared';
import type { SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-000000000001';

function fixture(events: { aiHours?: unknown; at: number; eventType?: string }[], empty = false) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  if (!empty) {
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      repositoryId: REPO,
      type: 'workflow',
      status: 'completed',
      title: 'refined task',
      completedAt: new Date('2026-11-01T02:00:00Z'),
      aiEstimatedTimeHours: 2.92,
      estimatedTimeHours: 3,
    });
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      startedAt: new Date('2026-11-01T00:00:00Z'),
      endedAt: new Date('2026-11-01T02:00:00Z'),
      idleMs: 0,
      userActiveMs: 0,
      waitingStartedAt: null,
      status: 'done',
    });
  }
  for (const e of events) {
    fake.insert(schema.taskEvents, {
      taskId: TASK,
      eventType: e.eventType ?? 'estimate.recorded',
      payload: { aiHours: e.aiHours },
      createdAt: new Date(e.at),
    });
  }
  const findMany = vi.spyOn(fake.db.query.taskEvents, 'findMany');
  return { fake, findMany };
}

describe('recorded estimate accuracy through the HTTP route', () => {
  it('reports the latest recorded estimate, ignoring refinement and other event types', async () => {
    const { fake, findMany } = fixture([
      { aiHours: 6.5, at: 2 },
      { aiHours: 4, at: 1 },
      { aiHours: 100, at: 3, eventType: 'estimate.refined' },
    ]);
    const body = await request(fake.db);
    expect(body.rows).toMatchObject([{ aiEstimatedHours: 6.5, confirmedHours: 3, actualHours: 2 }]);
    expect(body.summary.medianBiasFactor).toBe(0.31);
    const query = new PgDialect().sqlToQuery(findMany.mock.calls[0]![0]!.where as SQL);
    expect(query.params).toEqual([TASK, 'estimate.recorded']);
  });

  it.each([
    { events: [] },
    {
      events: [
        { aiHours: 6.5, at: 1 },
        { aiHours: 0, at: 2 },
      ],
    },
  ])(
    'falls back to the column when latest history is absent or invalid (%j)',
    async ({ events }) => {
      const { fake } = fixture(events);
      const body = await request(fake.db);
      expect(body.rows).toMatchObject([{ aiEstimatedHours: 2.92 }]);
      expect(body.summary.medianBiasFactor).toBe(0.68);
    },
  );

  it('skips event and timing queries when no tasks qualify', async () => {
    const { fake, findMany } = fixture([], true);
    const select = vi.spyOn(fake.db, 'select');
    expect((await request(fake.db)).rows).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
  });
});

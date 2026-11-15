import { afterEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
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

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);
type EventResponse = { events: { payload: Record<string, unknown> }[] };
const TASK = '00000000-0000-4000-8000-0000000000b1';

describe('bounded insight event pages through the polled route', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    ['insight.auto_round_started', ['insights']],
    ['insight.classified', ['items']],
    ['insight.batch', ['selected', 'items']],
  ] as const)(
    '%s pages copies without truncating durable protocol records',
    async (eventType, fields) => {
      const fake = createFakeDb({ tasks: schema.tasks, taskEvents: schema.taskEvents });
      fake.insert(schema.tasks, { id: TASK, userId: USER });
      const values = Array.from({ length: 31 }, (_, n) => ({ id: `item-${n}` }));
      const payload = Object.fromEntries(fields.map((key) => [key, values]));
      fake.insert(schema.taskEvents, { taskId: TASK, eventType, payload, createdAt: new Date() });
      fake.insert(schema.taskEvents, {
        taskId: TASK,
        eventType: 'unrelated',
        payload: { values },
        createdAt: new Date(),
      });
      h.db = fake.db;
      const first = await app.request(`/tasks/${TASK}/events`);
      expect(first.status).toBe(200);
      const events = ((await first.json()) as EventResponse).events;
      for (const key of fields) {
        expect(events[0]!.payload[key]).toEqual(values.slice(0, 30));
        expect(events[0]!.payload[`${key}Omitted`]).toBe(1);
        expect(fake.rows(schema.taskEvents)[0]!.payload).toEqual(payload);
      }
      expect(events[1]!.payload).toEqual({ values });
      const next = await app.request(`/tasks/${TASK}/events?type=${eventType}&insightOffset=30`);
      expect(next.status).toBe(200);
      const page = ((await next.json()) as EventResponse).events;
      expect(page).toHaveLength(1);
      for (const key of fields) expect(page[0]!.payload[key]).toEqual(values.slice(30));
    },
  );
  it('leaves under-bound payload bytes unchanged', async () => {
    const fake = createFakeDb({ tasks: schema.tasks, taskEvents: schema.taskEvents });
    fake.insert(schema.tasks, { id: TASK, userId: USER });
    const payload = { version: 1, insights: [{ id: 'one' }] };
    fake.insert(schema.taskEvents, {
      taskId: TASK,
      eventType: 'insight.auto_round_started',
      payload,
    });
    h.db = fake.db;
    const response = await app.request(`/tasks/${TASK}/events`);
    expect(JSON.stringify(((await response.json()) as EventResponse).events[0]!.payload)).toBe(
      JSON.stringify(payload),
    );
  });
});

import { markdownReportPage } from '../src/routes/tasks/_markdown-report.js';
describe('completed Markdown reports', () => {
  it('pages a complete report at an injectable bound', () => {
    const payload = {
      version: 1,
      title: 'Insight summary',
      items: ['one', 'two', 'three', 'four', 'five'],
    };
    expect(markdownReportPage(payload, 0, 2)).toMatchObject({
      body: 'one\n\ntwo',
      total: 5,
      pageSize: 2,
    });
    expect(markdownReportPage(payload, 2, 2).body).toBe('three\n\nfour');
    expect(markdownReportPage(payload, 4, 2).body).toBe('five');
    expect(payload.items).toHaveLength(5);
  });
  it('reads every report entry after task completion and refuses a foreign task/report/owner', async () => {
    const fake = createFakeDb({ tasks: schema.tasks, taskEvents: schema.taskEvents });
    fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'completed' });
    const reportId = '00000000-0000-4000-8000-0000000000c1';
    const payload = {
      version: 1,
      title: 'Insight summary',
      items: Array.from({ length: 31 }, (_, n) => `entry ${n}`),
    };
    fake.insert(schema.taskEvents, {
      id: reportId,
      taskId: TASK,
      eventType: 'task.markdown_report',
      payload,
    });
    h.db = fake.db;
    const first = await app.request(`/tasks/${TASK}/reports/${reportId}`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ total: 31, pageSize: 30, offset: 0 });
    const next = await app.request(`/tasks/${TASK}/reports/${reportId}?offset=30`);
    expect(await next.json()).toMatchObject({ body: 'entry 30', offset: 30 });
    fake.insert(schema.taskEvents, {
      id: '00000000-0000-4000-8000-0000000000c2',
      taskId: '00000000-0000-4000-8000-0000000000b2',
      eventType: 'task.markdown_report',
      payload,
    });
    expect(
      (await app.request(`/tasks/${TASK}/reports/00000000-0000-4000-8000-0000000000c2`)).status,
    ).toBe(404);
    await fake.db
      .update(schema.tasks)
      .set({ userId: 'foreign' })
      .where((await import('drizzle-orm')).eq(schema.tasks.id, TASK));
    expect((await app.request(`/tasks/${TASK}/reports/${reportId}`)).status).toBe(404);
  });
});

it.each([
  null,
  { version: 2, title: 'Future', items: [] },
  { version: 1, title: 'Invalid', items: [42] },
])('unsupported report payload returns a typed 4xx through the route: %j', async (payload) => {
  const fake = createFakeDb({ tasks: schema.tasks, taskEvents: schema.taskEvents });
  fake.insert(schema.tasks, { id: TASK, userId: USER });
  const reportId = '00000000-0000-4000-8000-0000000000c1';
  fake.insert(schema.taskEvents, {
    id: reportId,
    taskId: TASK,
    eventType: 'task.markdown_report',
    payload,
  });
  h.db = fake.db;
  const response = await app.request(`/tasks/${TASK}/reports/${reportId}`);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: 'markdown-report-unsupported' });
});

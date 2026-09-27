import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  entries: [] as Record<string, unknown>[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getGlobalKbSyncQueue: vi.fn(), getTaskQueue: vi.fn() }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  withGlobalKb: async () => ({ entries: h.entries, total: h.entries.length, frameworks: [] }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { globalKbRoutes } from '../src/routes/global-kb.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const OTHER_USER = '00000000-0000-4000-8000-0000000000a2';
const FAILED_TASK = '00000000-0000-4000-8000-000000000001';
const CANCELLED_TASK = '00000000-0000-4000-8000-000000000002';
const GONE_TASK = '00000000-0000-4000-8000-000000000003';
const OTHERS_TASK = '00000000-0000-4000-8000-000000000004';

const app = new Hono<AppEnv>();
app.route('/', globalKbRoutes);
app.onError(errorHandler);

function entry(id: string, status: string, sourceTaskId: string | null) {
  return { id, title: id, status, sourceTaskId };
}

describe('the global KB entries list', () => {
  beforeEach(() => {
    const fake = createFakeDb({ tasks: schema.tasks });
    fake.insert(schema.tasks, { id: FAILED_TASK, userId: USER, status: 'failed' });
    fake.insert(schema.tasks, { id: CANCELLED_TASK, userId: USER, status: 'cancelled' });
    fake.insert(schema.tasks, { id: OTHERS_TASK, userId: OTHER_USER, status: 'failed' });
    h.db = fake.db;
    h.entries = [
      entry('retryable', 'failed', FAILED_TASK),
      entry('cancelled', 'failed', CANCELLED_TASK),
      entry('gone', 'failed', GONE_TASK),
      entry('not-mine', 'failed', OTHERS_TASK),
      entry('hand-written', 'active', null),
    ];
  });

  it("names each entry's source task status, and only for the caller's own tasks", async () => {
    const res = await app.request('/entries');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { id: string; sourceTaskStatus: string | null }[];
    };
    expect(Object.fromEntries(body.entries.map((e) => [e.id, e.sourceTaskStatus]))).toEqual({
      retryable: 'failed',
      cancelled: 'cancelled',
      gone: null,
      'not-mine': null,
      'hand-written': null,
    });
  });
});

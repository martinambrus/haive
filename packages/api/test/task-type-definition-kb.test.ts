import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  gdb: undefined as unknown,
  definition: vi.fn(
    async (..._args: unknown[]) =>
      ({
        runListSnapshot: ['01-enrich'],
        customSteps: { 'custom.t.s': { slug: 's', title: 'S' } },
      }) as unknown,
  ),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/task-type-definition.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/task-type-definition.js')>()),
  definitionForCreate: h.definition,
}));
vi.mock('../src/queues.js', () => ({
  getGlobalKbSyncQueue: () => ({ add: vi.fn() }),
  getTaskQueue: vi.fn(),
}));
vi.mock('../src/lib/task-start.js', () => ({
  enqueueStart: vi.fn(async () => {}),
  markQueuedForStart: async () => true,
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true },
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
    fn({ db: h.gdb, settings: { namespace: 'default' } }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { globalKbEntries } from '@haive/shared/global-kb';
import { globalKbRoutes } from '../src/routes/global-kb.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { HttpError } from '../src/context.js';
import type { AppEnv } from '../src/context.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000c1';

const app = new Hono<AppEnv>();
app.use(async (c, next) => {
  c.set('maintenanceState', 'normal');
  await next();
});
app.route('/', globalKbRoutes);
app.onError(errorHandler);

let fake: ReturnType<typeof makeFake>;
const makeFake = () =>
  createFakeDb({ tasks: schema.tasks, cliProviders: schema.cliProviders, globalKbEntries });

beforeEach(() => {
  fake = makeFake();
  fake.insert(schema.cliProviders, { id: PROVIDER, userId: USER });
  h.db = fake.db;
  h.gdb = fake.db;
  h.definition.mockClear();
});

const enrich = () =>
  app.request('/enrich', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'T', seedText: 'notes', cliProviderId: PROVIDER }),
  });

describe('POST /enrich pins the kb_author step list', () => {
  it('writes the helper snapshot into the task row', async () => {
    expect((await enrich()).status).toBe(201);
    expect(h.definition).toHaveBeenCalledWith(fake.db, 'kb_author', { generic: false });
    expect(fake.rows(schema.tasks)[0]).toMatchObject({
      runListSnapshot: ['01-enrich'],
      customSteps: { 'custom.t.s': { slug: 's', title: 'S' } },
    });
  });

  const refused = () =>
    Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('value too long'), { code: '22001' }),
    });

  it('removes the skeleton entry when Postgres refuses the task insert', async () => {
    fake.hooks.beforeInsert = (table) => {
      if (table === schema.tasks) throw refused();
    };
    expect((await enrich()).status).toBe(500);
    expect(fake.rows(schema.tasks)).toHaveLength(0);
    expect(fake.rows(globalKbEntries)).toHaveLength(0);
  });

  it('keeps the skeleton entry when the task insert committed but its reply was lost', async () => {
    const real = fake.db;
    h.db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== 'insert') return Reflect.get(target, prop, receiver);
        return (table: unknown) => {
          const builder = real.insert(table as typeof schema.tasks);
          if (table !== schema.tasks) return builder;
          return {
            values: (v: unknown) => ({
              returning: async () => {
                await builder.values(v as never).returning();
                throw new Error('connection dropped');
              },
            }),
          };
        };
      },
    });
    expect((await enrich()).status).toBe(500);
    const [task] = fake.rows(schema.tasks);
    expect(task).toBeDefined();
    const [entry] = fake.rows(globalKbEntries);
    expect(entry?.id).toBe((task!.metadata as { globalKbEntryId: string }).globalKbEntryId);
  });

  it('keeps the skeleton entry when the outcome of the insert is unknown', async () => {
    for (const error of [
      Object.assign(new Error('connection failure'), { code: '08006' }),
      Object.assign(new Error('statement completion unknown'), { code: '40003' }),
      new Error('socket closed'),
    ]) {
      fake = makeFake();
      fake.insert(schema.cliProviders, { id: PROVIDER, userId: USER });
      h.db = fake.db;
      h.gdb = fake.db;
      fake.hooks.beforeInsert = (table) => {
        if (table === schema.tasks) throw error;
      };
      expect((await enrich()).status).toBe(500);
      expect(fake.rows(globalKbEntries)).toHaveLength(1);
    }
  });

  it('keeps an entry that stopped being a skeleton before the cleanup', async () => {
    fake.hooks.beforeInsert = (table) => {
      if (table !== schema.tasks) return;
      fake.patch(globalKbEntries, fake.rows(globalKbEntries)[0]!.id as string, { status: 'draft' });
      throw refused();
    };
    expect((await enrich()).status).toBe(500);
    expect(fake.rows(globalKbEntries)).toHaveLength(1);
  });

  it('creates neither the entry nor the task when the type is refused', async () => {
    h.definition.mockRejectedValueOnce(new HttpError(403, 'Task type kb_author is disabled'));
    expect((await enrich()).status).toBe(403);
    expect(fake.rows(schema.tasks)).toHaveLength(0);
    expect(fake.rows(globalKbEntries)).toHaveLength(0);
  });
});

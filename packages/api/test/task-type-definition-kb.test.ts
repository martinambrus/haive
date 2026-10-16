import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  gdb: undefined as unknown,
  beforeAdmit: undefined as (() => Promise<void>) | undefined,
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
  markQueuedForStart: vi.fn(async () => true),
}));
vi.mock('../src/middleware/maintenance.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/maintenance.js')>();
  return {
    ...actual,
    admitNewWork: async (...args: Parameters<typeof actual.admitNewWork>) => {
      await h.beforeAdmit?.();
      return actual.admitNewWork(...args);
    },
  };
});
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true, getFresh: async () => 'normal' },
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
import { enqueueStart, markQueuedForStart } from '../src/lib/task-start.js';
import { NewWorkRefused } from '../src/middleware/maintenance.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { HttpError } from '../src/context.js';
import type { AppEnv } from '../src/context.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000c1';

const app = new Hono<AppEnv>();
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
  h.beforeAdmit = undefined;
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

  it('keeps the skeleton entry when the task committed but the reply to the commit was lost', async () => {
    const real = fake.db;
    h.db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver);
        return async (run: Parameters<typeof real.transaction>[0]) => {
          await real.transaction(run);
          throw new Error('connection dropped');
        };
      },
    });
    expect((await enrich()).status).toBe(500);
    const [task] = fake.rows(schema.tasks);
    expect(task).toBeDefined();
    const [entry] = fake.rows(globalKbEntries);
    expect(entry?.id).toBe((task!.metadata as { globalKbEntryId: string }).globalKbEntryId);
  });

  it('removes the skeleton entry however the insert fails, since the error rolls the task back', async () => {
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
      expect(fake.rows(schema.tasks)).toHaveLength(0);
      expect(fake.rows(globalKbEntries)).toHaveLength(0);
    }
  });

  it('removes the skeleton entry when the statement after the task insert fails', async () => {
    vi.mocked(markQueuedForStart).mockRejectedValueOnce(new Error('connection refused'));
    expect((await enrich()).status).toBe(500);
    expect(fake.rows(schema.tasks)).toHaveLength(0);
    expect(fake.rows(globalKbEntries)).toHaveLength(0);
  });

  it('removes the skeleton entry when the new-work fence cannot be taken, before the task insert', async () => {
    h.beforeAdmit = async () => {
      throw new Error('connection refused');
    };
    expect((await enrich()).status).toBe(500);
    expect(fake.rows(schema.tasks)).toHaveLength(0);
    expect(fake.rows(globalKbEntries)).toHaveLength(0);
  });

  it('removes the skeleton entry when new work is refused after the check at the door', async () => {
    h.beforeAdmit = async () => {
      throw new NewWorkRefused();
    };
    expect((await enrich()).status).toBe(503);
    expect(fake.rows(schema.tasks)).toHaveLength(0);
    expect(fake.rows(globalKbEntries)).toHaveLength(0);
  });

  it('keeps the skeleton entry when the commit of the task fails, after the insert', async () => {
    fake.hooks.beforeCommit = () => {
      fake.hooks.beforeCommit = null;
      throw new Error('connection dropped');
    };
    expect((await enrich()).status).toBe(500);
    expect(fake.rows(globalKbEntries)).toHaveLength(1);
  });

  it('removes the skeleton entry when Postgres refuses the commit of the task', async () => {
    fake.hooks.beforeCommit = () => {
      fake.hooks.beforeCommit = null;
      throw refused();
    };
    expect((await enrich()).status).toBe(500);
    expect(fake.rows(schema.tasks)).toHaveLength(0);
    expect(fake.rows(globalKbEntries)).toHaveLength(0);
  });

  it('keeps the skeleton entry when the START cannot be queued after the commit', async () => {
    vi.mocked(enqueueStart).mockRejectedValueOnce(new Error('connection refused'));
    expect((await enrich()).status).toBe(500);
    expect(fake.rows(schema.tasks)).toHaveLength(1);
    expect(fake.rows(globalKbEntries)).toHaveLength(1);
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

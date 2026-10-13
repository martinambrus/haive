import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'user',
  getDb: vi.fn(),
  write: vi.fn(),
  defs: [] as unknown[],
}));

vi.mock('../src/db.js', () => ({
  getDb: () => {
    h.getDb();
    return {
      select: () => ({ from: (table: unknown) => rows(table) }),
      insert: h.write,
      update: h.write,
      delete: h.write,
      transaction: h.write,
    };
  },
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    c.set('userRole', h.role);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async (_key: string, fallback: boolean) => fallback },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { adminTaskTypeRoutes, taskTypeRoutes } from '../src/routes/task-types.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

function rows(table: unknown) {
  const result = table === schema.taskTypeDefinitions ? h.defs : [];
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  for (const method of ['where', 'orderBy', 'limit', 'groupBy']) chain[method] = () => chain;
  return chain;
}

const app = new Hono<AppEnv>();
app.route('/admin/task-types', adminTaskTypeRoutes);
app.route('/task-types', taskTypeRoutes);
app.onError(errorHandler);

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  h.role = 'user';
  h.getDb.mockClear();
  h.write.mockClear();
  h.defs = [];
});

describe('/admin/task-types for a regular user', () => {
  const create = {
    slug: 'my-type',
    displayName: 'My type',
    stepIds: ['01-worktree-setup'],
    requiresRepository: true,
  };
  const verbs: [string, string, unknown?][] = [
    ['GET', '/admin/task-types'],
    ['GET', '/admin/task-types/catalog'],
    ['GET', '/admin/task-types/my-type'],
    ['POST', '/admin/task-types', create],
    ['PATCH', '/admin/task-types/my-type', { displayName: 'Renamed' }],
    ['DELETE', '/admin/task-types/my-type'],
  ];

  it.each(verbs)('refuses %s %s with 403 before touching the database', async (m, path, body) => {
    const res = await send(m, path, body);
    expect(res.status).toBe(403);
    expect(h.getDb).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it('lets an admin through the same gate', async () => {
    h.role = 'admin';
    const res = await send('GET', '/admin/task-types');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ taskTypes: [] });
  });
});

describe('GET /task-types', () => {
  it('answers a regular user, listing only what the database returned', async () => {
    h.defs = [
      {
        slug: 'workflow',
        displayName: 'Workflow',
        description: null,
        runListStrategy: 'workflow_paths',
        stepIds: null,
        source: 'builtin',
        enabled: true,
        selectable: true,
        requiresRepository: true,
        sortOrder: 1,
      },
    ];
    const res = await send('GET', '/task-types');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      taskTypes: [
        {
          slug: 'workflow',
          displayName: 'Workflow',
          description: null,
          requiresRepository: true,
          sortOrder: 1,
          restoresDatabase: true,
          dispatchesCli: true,
          available: true,
        },
      ],
    });
    expect(h.write).not.toHaveBeenCalled();
  });
});

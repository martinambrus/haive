import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'user',
  getDb: vi.fn(),
  write: vi.fn(),
  defs: [] as unknown[],
  catalog: [] as unknown[],
  modules: [] as unknown[],
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
  const result =
    table === schema.taskTypeDefinitions
      ? h.defs
      : table === schema.stepCatalog
        ? h.catalog
        : table === schema.modules
          ? h.modules
          : [];
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
  h.catalog = [];
  h.modules = [];
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
  it('names only absent steps in missingStepIds, leaving the stored run list intact', async () => {
    h.catalog = [{ stepId: 'installed', composable: false, dispatchesCli: false }];
    h.defs = [
      {
        slug: 'onboarding',
        displayName: 'Onboarding',
        description: null,
        runListStrategy: 'static',
        stepIds: ['installed', 'gone'],
        source: 'builtin',
        enabled: true,
        selectable: true,
        requiresRepository: true,
        sortOrder: 0,
      },
    ];
    const res = await send('GET', '/task-types');
    expect(res.status).toBe(200);
    const { taskTypes } = (await res.json()) as { taskTypes: Record<string, unknown>[] };
    expect(taskTypes).toHaveLength(1);
    expect(taskTypes[0]).toMatchObject({
      available: false,
      reason: 'missing-step',
      missingStepIds: ['gone'],
    });
    expect(taskTypes[0]).not.toHaveProperty('stepIds');
    expect(h.defs[0]).toHaveProperty('stepIds', ['installed', 'gone']);
    expect(h.write).not.toHaveBeenCalled();
  });

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

describe('GET /admin/task-types/catalog overview metadata', () => {
  it('keeps filtered module declarations read-only and outside the selectable catalog', async () => {
    h.role = 'admin';
    h.modules = [{ moduleId: 'notes', name: 'Notes', missingAt: null, deactivatedAt: new Date() }];
    const entry = {
      stepId: 'module.notes.review',
      label: 'Notes review',
      group: 'build',
      dispatchesCli: true,
      requires: [],
      provides: [],
      integrations: [{ id: 'docs', category: 'module.notes.docs', access: 'read' }],
    };
    h.catalog = [
      {
        stepId: entry.stepId,
        source: 'module:notes',
        title: entry.label,
        composable: true,
        dispatchesCli: true,
        entry,
      },
    ];
    const response = await send('GET', '/admin/task-types/catalog');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      steps: [],
      unavailableSteps: [{ stepId: entry.stepId, entry }],
      registeredStepIds: [entry.stepId],
      modules: [{ id: 'notes', state: 'deactivated' }],
    });
    expect(h.write).not.toHaveBeenCalled();
  });
});

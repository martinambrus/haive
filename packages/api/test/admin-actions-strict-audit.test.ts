import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ db: undefined as unknown, add: vi.fn(), publish: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', async (original) => ({
  ...(await original<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ publish: h.publish }) }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/task-type-definition.js', async (original) => ({
  ...(await original<typeof import('../src/lib/task-type-definition.js')>()),
  definitionForCreate: async () => ({ runListSnapshot: ['01-type-draft'], customSteps: null }),
}));
vi.mock('@haive/shared/modularity-server', async (original) => ({
  ...(await original<typeof import('@haive/shared/modularity-server')>()),
  moduleDependents: async () => ({ tasks: [], capped: false }),
  moduleDependentRows: async () => [],
}));
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { adminTaskTypeRoutes } from '../src/routes/task-types.js';
import { taskTypeDraftRoutes } from '../src/routes/task-type-drafts.js';
import { moduleRoutes } from '../src/modules/loader.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const app = new Hono<AppEnv>();
app.route('/types', adminTaskTypeRoutes);
app.route('/drafts', taskTypeDraftRoutes);
app.route('/modules', moduleRoutes([]));
app.onError(errorHandler);
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
function setup() {
  const fake = createFakeDb({
    stepCatalog: schema.stepCatalog,
    taskTypeDefinitions: schema.taskTypeDefinitions,
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    auditEvents: schema.auditEvents,
    modules: schema.modules,
    moduleDrainTasks: schema.moduleDrainTasks,
  });
  h.db = fake.db;
  return fake;
}
beforeEach(() => {
  h.add.mockReset();
  h.publish.mockReset().mockResolvedValue(1);
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});
it.each(['PATCH', 'DELETE'])('a refused audit rolls back task-type %s', async (method) => {
  const fake = setup();
  fake.insert(schema.taskTypeDefinitions, {
    slug: 'my-type',
    source: 'admin',
    displayName: 'Before',
    updatedAt: new Date(),
  });
  fake.hooks.beforeInsert = async (table) => {
    if (table === schema.auditEvents) throw new Error('audit refused');
  };
  expect(
    (
      await send(
        method,
        '/types/my-type',
        method === 'PATCH' ? { displayName: 'After' } : undefined,
      )
    ).status,
  ).toBe(500);
  expect(fake.rows(schema.taskTypeDefinitions)).toMatchObject([{ displayName: 'Before' }]);
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});
it('a refused draft audit rolls back the task and opening message before enqueue', async () => {
  const fake = setup();
  fake.hooks.beforeInsert = async (table) => {
    if (table === schema.auditEvents) throw new Error('audit refused');
  };
  expect((await send('POST', '/drafts', { message: 'Draft a type' })).status).toBe(500);
  expect(fake.rows(schema.tasks)).toEqual([]);
  expect(fake.rows(schema.taskEvents)).toEqual([]);
  expect(h.add).not.toHaveBeenCalled();
});
it.each([true, false])(
  'a refused audit rolls back module active=%s before publishing',
  async (active) => {
    const fake = setup();
    const stamp = active ? new Date() : null;
    fake.insert(schema.modules, { moduleId: 'alpha', deactivatedAt: stamp });
    fake.hooks.beforeInsert = async (table) => {
      if (table === schema.auditEvents) throw new Error('audit refused');
    };
    expect((await send('PATCH', '/modules/alpha', { active })).status).toBe(500);
    expect(fake.rows(schema.modules)[0]?.deactivatedAt).toEqual(stamp);
    expect(h.publish).not.toHaveBeenCalled();
  },
);
it('a refused urgent-deactivation audit leaves the module active', async () => {
  const fake = setup();
  fake.insert(schema.modules, { moduleId: 'alpha', deactivatedAt: null });
  const attempted = vi.fn();
  fake.hooks.beforeInsert = async (table) => {
    if (table === schema.auditEvents) throw new Error('audit refused');
  };
  fake.hooks.beforeInsert = async (table) => {
    if (table === schema.auditEvents) {
      attempted();
      throw new Error('audit refused');
    }
  };
  expect((await send('PATCH', '/modules/alpha', { active: false, mode: 'urgent' })).status).toBe(
    500,
  );
  expect(fake.rows(schema.modules)[0]?.deactivatedAt).toBeNull();
  expect(attempted).toHaveBeenCalled();
});

it.each([false, true])(
  'task-type create keeps its change and audit atomic, refuse=%s',
  async (refuse) => {
    const fake = setup();
    fake.insert(schema.stepCatalog, {
      stepId: 'audit-step',
      source: 'core',
      title: 'Audit step',
      composable: true,
      dispatchesCli: false,
      entry: {
        stepId: 'audit-step',
        label: 'Audit step',
        group: 'build',
        dispatchesCli: false,
        requires: [],
        provides: [],
      },
    });
    if (refuse)
      fake.hooks.beforeInsert = async (table) => {
        if (table === schema.auditEvents) throw new Error('audit refused');
      };
    const res = await send('POST', '/types', {
      slug: 'my-type',
      displayName: 'My type',
      stepIds: ['audit-step'],
      requiresRepository: false,
    });
    expect(res.status).toBe(refuse ? 500 : 201);
    expect(fake.rows(schema.taskTypeDefinitions)).toHaveLength(refuse ? 0 : 1);
    expect(fake.rows(schema.auditEvents)).toHaveLength(refuse ? 0 : 1);
  },
);
it('urgent deactivation commits its one required row before stopping dependents', async () => {
  const fake = setup();
  fake.insert(schema.modules, { moduleId: 'alpha', deactivatedAt: null });
  expect((await send('PATCH', '/modules/alpha', { active: false, mode: 'urgent' })).status).toBe(
    200,
  );
  expect(fake.rows(schema.modules)[0]?.deactivatedAt).toBeInstanceOf(Date);
  expect(fake.rows(schema.auditEvents)).toMatchObject([
    { action: 'module.deactivate', metadata: { moduleId: 'alpha', mode: 'urgent' } },
  ]);
});
it('a commit refusal undoes the task-type update and its row', async () => {
  const fake = setup();
  fake.insert(schema.taskTypeDefinitions, {
    slug: 'my-type',
    source: 'admin',
    displayName: 'Before',
    updatedAt: new Date(),
  });
  fake.hooks.beforeCommit = async () => {
    throw new Error('commit refused');
  };
  expect((await send('PATCH', '/types/my-type', { displayName: 'After' })).status).toBe(500);
  expect(fake.rows(schema.taskTypeDefinitions)[0]?.displayName).toBe('Before');
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});

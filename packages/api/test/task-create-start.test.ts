import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

vi.mock('../src/lib/task-type-definition.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/task-type-definition.js')>()),
  definitionForCreate: async () => ({ runListSnapshot: null }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { TASK_JOB_NAMES, configService } from '@haive/shared';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const DRAFT = '00000000-0000-4000-8000-000000000001';

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);
vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');

beforeEach(() => {
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
});

function setup() {
  const fake = createFakeDb({
    cliProviders: schema.cliProviders,
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    repositories: schema.repositories,
    taskDatabaseStates: schema.taskDatabaseStates,
    repositoryDatabaseStates: schema.repositoryDatabaseStates,
    databaseSnapshots: schema.databaseSnapshots,
    dbUploads: schema.dbUploads,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', status: 'ready' });
  h.db = fake.db;
  const task = () => fake.rows(schema.tasks).find((r) => r.id !== DRAFT)!;
  return { fake, task };
}

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const create = () =>
  post('/', { type: 'workflow', title: 'a task', description: 'do it', repositoryId: REPO });
const starts = () =>
  h.add.mock.calls.filter(([name]) => name === TASK_JOB_NAMES.START).map(([, data]) => data);

describe('POST /tasks', () => {
  const SNAPSHOT = '00000000-0000-4000-8000-0000000000c1';
  function savedDatabase() {
    const t = setup();
    t.fake.insert(schema.databaseSnapshots, {
      id: SNAPSHOT,
      repositoryId: REPO,
      userId: USER,
      status: 'ready',
      engine: 'postgres',
      sourceTaskTitle: 'Source',
    });
    t.fake.insert(schema.repositoryDatabaseStates, {
      repositoryId: REPO,
      revision: 3,
      snapshotId: SNAPSHOT,
    });
    return t;
  }

  it('pins the chosen snapshot before START; saving is decided at the end', async () => {
    const t = savedDatabase();
    h.add.mockImplementation(async () => {
      expect(t.fake.rows(schema.taskDatabaseStates)[0]).toMatchObject({
        sourceSnapshotId: SNAPSHOT,
        baseRevision: 3,
        saveEnabled: true,
      });
    });
    const res = await post('/', {
      type: 'workflow',
      title: 'continue',
      description: 'Continue from saved state',
      repositoryId: REPO,
      databaseSnapshotId: SNAPSHOT,
      saveDatabase: false,
    });
    expect(res.status).toBe(201);
    expect(starts()).toHaveLength(1);
  });

  it('rejects stale or foreign snapshots without creating a task or START', async () => {
    const t = savedDatabase();
    const res = await post('/', {
      type: 'workflow',
      title: 'continue',
      description: 'Continue from saved state',
      repositoryId: REPO,
      databaseSnapshotId: '00000000-0000-4000-8000-0000000000c2',
    });
    expect(res.status).toBe(409);
    expect(t.fake.rows(schema.tasks)).toHaveLength(0);
    expect(t.fake.rows(schema.taskDatabaseStates)).toHaveLength(0);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('rejects combining a saved database and a manual dump', async () => {
    setup();
    const res = await post('/', {
      type: 'workflow',
      title: 'continue',
      description: 'Continue from saved state',
      repositoryId: REPO,
      databaseSnapshotId: SNAPSHOT,
      dbUploadId: SNAPSHOT,
    });
    expect(res.status).toBe(400);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('queues the task before it queues its START', async () => {
    const t = setup();
    h.add.mockImplementation(async () => {
      expect(t.task().status).toBe('queued');
    });
    const res = await create();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { id: string; status: string } };
    expect(body.task.status).toBe('queued');
    expect(starts()).toEqual([{ taskId: body.task.id, userId: USER }]);
  });

  it('with deferStart creates the task unstarted, and the start action queues it once', async () => {
    const t = setup();
    const res = await post('/', {
      type: 'workflow',
      title: 'a task',
      description: 'do it',
      repositoryId: REPO,
      deferStart: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { id: string; status: string } };
    expect(body.task.status).toBe('created');
    expect(t.task().status).toBe('created');
    expect(h.add).not.toHaveBeenCalled();
    const started = await post(`/${body.task.id}/action`, { action: 'start' });
    expect(await started.json()).toMatchObject({ started: true, status: 'queued' });
    const again = await post(`/${body.task.id}/action`, { action: 'start' });
    expect(await again.json()).toMatchObject({ started: false, status: 'queued' });
    expect(t.task().status).toBe('queued');
    expect(starts()).toEqual([{ taskId: body.task.id, userId: USER }]);
  });

  it('with deferStart refuses a read-only local repository, which takes no attachments', async () => {
    const t = setup();
    const readOnly = '00000000-0000-4000-8000-0000000000f1';
    t.fake.insert(schema.repositories, {
      id: readOnly,
      userId: USER,
      name: 'ro',
      status: 'ready',
      source: 'local_path',
      writable: false,
    });
    const res = await post('/', {
      type: 'workflow',
      title: 'a task',
      description: 'do it',
      repositoryId: readOnly,
      deferStart: true,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'Attachments are not supported for read-only local repositories',
    });
    expect(t.fake.rows(schema.tasks).filter((r) => r.id !== DRAFT)).toEqual([]);
    expect((await create()).status).toBe(201);
  });

  // The stalled re-driver gives a `queued` task with no START one, and leaves `created` alone.
  it('answers 201 with the task queued when its START cannot be queued', async () => {
    const t = setup();
    h.add.mockRejectedValue(new Error('redis unavailable'));
    const res = await create();
    expect(res.status).toBe(201);
    expect(t.task().status).toBe('queued');
  });

  it('creates no task and queues nothing when a write before the start fails', async () => {
    const t = setup();
    t.fake.hooks.beforeInsert = (table) => {
      if (table === schema.taskEvents) throw new Error('db unavailable');
    };
    const res = await create();
    expect(res.status).toBe(500);
    expect(t.fake.rows(schema.tasks)).toHaveLength(0);
    expect(h.add).not.toHaveBeenCalled();
  });
});

describe('POST /tasks with an uploaded dump', () => {
  const DUMP = '00000000-0000-4000-8000-0000000000d1';
  function withDump(status: string) {
    const t = setup();
    t.fake.insert(schema.dbUploads, {
      id: DUMP,
      userId: USER,
      filename: 'a.sql',
      dumpFormat: 'sql',
      totalSize: 1,
      chunkSize: 1,
      dumpPath: '/uploads/db-a.sql',
      status,
    });
    return t;
  }
  const createWith = (dbUploadId: string) =>
    post('/', {
      type: 'workflow',
      title: 'a task',
      description: 'do it',
      repositoryId: REPO,
      dbUploadId,
    });
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

  it('links a complete dump to the task', async () => {
    const t = withDump('complete');
    const res = await createWith(DUMP);
    expect(res.status).toBe(201);
    expect(t.task()).toMatchObject({ dbUploadId: DUMP });
  });

  it('answers 404 for a dump that does not exist, and creates no task', async () => {
    const t = withDump('complete');
    const res = await createWith('00000000-0000-4000-8000-0000000000d2');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe('DB dump upload not found');
    expect(t.fake.rows(schema.tasks)).toHaveLength(0);
    expect(h.add).not.toHaveBeenCalled();
  });

  it.each(['uploading', 'completing', 'cancelled', 'consumed', 'reaping'])(
    'answers 409 naming the status of a %s dump, and creates no task',
    async (status) => {
      const t = withDump(status);
      const res = await createWith(DUMP);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe(`DB dump upload is ${status}, not complete`);
      expect(t.fake.rows(schema.tasks)).toHaveLength(0);
      expect(h.add).not.toHaveBeenCalled();
    },
  );
});

describe('the start action', () => {
  function draft() {
    const t = setup();
    t.fake.insert(schema.tasks, {
      id: DRAFT,
      userId: USER,
      type: 'plan_build',
      title: 'draft',
      repositoryId: REPO,
      status: 'created',
    });
    const row = () => t.fake.rows(schema.tasks).find((r) => r.id === DRAFT)!;
    return { ...t, row };
  }

  it('answers started with the task queued when its START cannot be queued', async () => {
    const t = draft();
    h.add.mockRejectedValue(new Error('redis unavailable'));
    const res = await post(`/${DRAFT}/action`, { action: 'start' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ started: true, status: 'queued' });
    expect(t.row().status).toBe('queued');
  });

  it('starts a draft once', async () => {
    draft();
    await post(`/${DRAFT}/action`, { action: 'start' });
    const again = await post(`/${DRAFT}/action`, { action: 'start' });
    expect(await again.json()).toMatchObject({ started: false, status: 'queued' });
    expect(starts()).toEqual([{ taskId: DRAFT, userId: USER }]);
  });
});

describe('disabled providers on task writes', () => {
  const CLI = '00000000-0000-4000-8000-0000000000e1';
  it.each(['cliProviderId', 'summaryCliProviderId'])(
    'rejects a disabled %s on create before writing a task',
    async (field) => {
      const t = setup();
      t.fake.insert(schema.cliProviders, { id: CLI, userId: USER, enabled: false });
      const res = await post('/', {
        type: 'workflow',
        title: 'task',
        description: 'do it',
        repositoryId: REPO,
        [field]: CLI,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: expect.stringMatching(/disabled/i),
        code: 'CLI_PROVIDER_DISABLED',
      });
      expect(t.fake.rows(schema.tasks)).toHaveLength(0);
      expect(h.add).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['cli-provider', { cliProviderId: CLI }],
    ['summary-cli', { summaryCliProviderId: CLI }],
  ])('rejects a disabled provider on %s updates', async (route, body) => {
    const t = setup();
    t.fake.insert(schema.cliProviders, { id: CLI, userId: USER, enabled: false });
    t.fake.insert(schema.tasks, { id: DRAFT, userId: USER, status: 'running' });
    const res = await app.request(`/${DRAFT}/${route}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'CLI_PROVIDER_DISABLED' });
    expect(t.fake.rows(schema.tasks)[0]?.cliProviderId).not.toBe(CLI);
    expect(t.fake.rows(schema.tasks)[0]?.summaryCliProviderId).not.toBe(CLI);
  });
});

describe('provider admission guards', () => {
  const CLI = '00000000-0000-4000-8000-0000000000e1';
  it('accepts enabled providers for the task and summary', async () => {
    const t = setup();
    t.fake.insert(schema.cliProviders, { id: CLI, userId: USER, enabled: true });
    const res = await post('/', {
      type: 'workflow',
      title: 'task',
      description: 'do it',
      repositoryId: REPO,
      cliProviderId: CLI,
      summaryCliProviderId: CLI,
    });
    expect(res.status).toBe(201);
    expect(t.task()).toMatchObject({ cliProviderId: CLI, summaryCliProviderId: CLI });
  });
  it('keeps a disabled provider already bound to an existing task when it starts', async () => {
    const t = setup();
    t.fake.insert(schema.cliProviders, { id: CLI, userId: USER, enabled: false });
    t.fake.insert(schema.tasks, {
      id: DRAFT,
      userId: USER,
      type: 'plan_build',
      status: 'created',
      cliProviderId: CLI,
    });
    const res = await post(`/${DRAFT}/action`, { action: 'start' });
    expect(res.status).toBe(200);
    expect(t.fake.rows(schema.tasks)[0]?.cliProviderId).toBe(CLI);
  });
  it.each(['cliProviderId', 'summaryCliProviderId'])('hides a foreign %s', async (field) => {
    const t = setup();
    t.fake.insert(schema.cliProviders, {
      id: CLI,
      userId: '00000000-0000-4000-8000-0000000000f1',
      enabled: false,
    });
    const res = await post('/', {
      type: 'workflow',
      title: 'task',
      description: 'do it',
      repositoryId: REPO,
      [field]: CLI,
    });
    expect(res.status).toBe(404);
    expect(t.fake.rows(schema.tasks)).toHaveLength(0);
  });
});

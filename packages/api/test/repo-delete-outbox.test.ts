import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  names: [] as string[],
  rag: vi.fn(async (..._args: unknown[]) => undefined),
  resources: vi.fn(async (..._args: unknown[]) => undefined),
  rowsAtEnqueue: [] as unknown[][],
  snapshot: undefined as undefined | (() => unknown[]),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/lib/cancel-task.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/cancel-task.js')>()),
  cancelOpenTasksForRepo: async () => [],
  collectInternalRagProjectNamesForRepo: async () => h.names,
  enqueueCancelJob: async () => undefined,
  enqueueRepoRagCleanupJob: async (...args: unknown[]) => {
    h.rowsAtEnqueue.push(h.snapshot?.() ?? []);
    return h.rag(...args);
  },
  enqueueRepoResourceCleanupJob: async (...args: unknown[]) => {
    h.rowsAtEnqueue.push(h.snapshot?.() ?? []);
    return h.resources(...args);
  },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';

const app = new Hono<AppEnv>();
app.route('/', repoRoutes);
app.onError(errorHandler);

function setup() {
  const fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    envTemplates: schema.envTemplates,
    repoCleanups: schema.repoCleanups,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    source: 'git',
    status: 'ready',
    storagePath: `/var/lib/haive/repos/${USER}/${REPO}`,
  });
  h.db = fake.db;
  h.snapshot = () => fake.rows(schema.repoCleanups).map((r) => ({ ...r }));
  return fake;
}

beforeEach(() => {
  h.names = ['proj_a'];
  h.rowsAtEnqueue = [];
  h.rag.mockReset().mockResolvedValue(undefined);
  h.resources.mockReset().mockResolvedValue(undefined);
});

describe('deleting a repository records its cleanup before it queues it', () => {
  it('writes one repo_cleanups row per job, and the rows exist when each job is queued', async () => {
    const fake = setup();
    const res = await app.request(`/${REPO}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(fake.rows(schema.repositories)).toHaveLength(0);

    const rows = fake.rows(schema.repoCleanups);
    expect(rows.map((r) => r.kind).sort()).toEqual(['rag', 'resources']);
    expect(rows.every((r) => r.userId === USER && r.repositoryId === REPO)).toBe(true);
    expect(h.rowsAtEnqueue.map((seen) => seen.length)).toEqual([2, 2]);

    const rag = rows.find((r) => r.kind === 'rag')!;
    const resources = rows.find((r) => r.kind === 'resources')!;
    expect(rag.payload).toMatchObject({
      repositoryId: REPO,
      userId: USER,
      projectNames: ['proj_a'],
    });
    expect(resources.payload).toMatchObject({ repositoryId: REPO, userId: USER, taskIds: [] });
  });

  it('hands each job the id of its row', async () => {
    const fake = setup();
    await app.request(`/${REPO}`, { method: 'DELETE' });
    const rows = fake.rows(schema.repoCleanups);
    const idOf = (kind: string) => rows.find((r) => r.kind === kind)!.id;
    expect(h.rag).toHaveBeenCalledWith(expect.objectContaining({ cleanupId: idOf('rag') }));
    expect(h.resources).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupId: idOf('resources') }),
    );
  });

  it('stamps when each job was queued', async () => {
    const fake = setup();
    await app.request(`/${REPO}`, { method: 'DELETE' });
    const rows = fake.rows(schema.repoCleanups);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.lastEnqueuedAt instanceof Date)).toBe(true);
  });

  it('writes no rag row when the repository named no internal store', async () => {
    h.names = [];
    const fake = setup();
    const res = await app.request(`/${REPO}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(fake.rows(schema.repoCleanups).map((r) => r.kind)).toEqual(['resources']);
  });

  it('answers 200 and keeps the rows when the queue refuses both jobs after the commit', async () => {
    const fake = setup();
    h.rag.mockRejectedValue(new Error('redis down'));
    h.resources.mockRejectedValue(new Error('redis down'));
    const res = await app.request(`/${REPO}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(fake.rows(schema.repositories)).toHaveLength(0);
    const rows = fake.rows(schema.repoCleanups);
    expect(rows.map((r) => r.kind).sort()).toEqual(['rag', 'resources']);
    expect(rows.every((r) => r.lastEnqueuedAt == null)).toBe(true);
  });

  it('still queues the resource job when the rag job could not be queued', async () => {
    const fake = setup();
    h.rag.mockRejectedValue(new Error('redis down'));
    const res = await app.request(`/${REPO}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(h.resources).toHaveBeenCalledTimes(1);
    const rows = fake.rows(schema.repoCleanups);
    expect(rows.find((r) => r.kind === 'rag')!.lastEnqueuedAt).toBeNull();
    expect(rows.find((r) => r.kind === 'resources')!.lastEnqueuedAt).toBeInstanceOf(Date);
  });

  it('writes nothing when the repository does not exist', async () => {
    const fake = setup();
    const res = await app.request('/00000000-0000-4000-8000-0000000000ff', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(fake.rows(schema.repoCleanups)).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  cleanup: vi.fn(async (..._args: unknown[]) => undefined),
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
  collectInternalRagProjectNamesForRepo: async () => [],
  enqueueCancelJob: async () => undefined,
  enqueueRepoRagCleanupJob: async () => undefined,
  enqueueRepoResourceCleanupJob: h.cleanup,
}));

import { Hono } from 'hono';
import { schema, ROOT_CLAIM_STALE_MS } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';

const app = new Hono<AppEnv>();
app.route('/', repoRoutes);
app.onError(errorHandler);

function setup(rootClaimedAt: Date | null) {
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
    status: 'cloning',
    rootClaimedAt,
    rootClaimKind: rootClaimedAt ? 'rebuild' : null,
  });
  h.db = fake.db;
  return fake;
}

beforeEach(() => h.cleanup.mockClear());

describe('deleting a repository', () => {
  it('refuses while a clone holds the root, removing and queuing nothing', async () => {
    const fake = setup(new Date());
    const res = await app.request(`/${REPO}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('being rebuilt from its source');
    expect(fake.rows(schema.repositories)).toHaveLength(1);
    expect(h.cleanup).not.toHaveBeenCalled();
  });

  it('goes ahead once the claim has gone stale', async () => {
    const fake = setup(new Date(Date.now() - ROOT_CLAIM_STALE_MS - 60_000));
    const res = await app.request(`/${REPO}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(fake.rows(schema.repositories)).toHaveLength(0);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
  });

  // A template row goes with its user, so the job cannot count on reading the tag afterwards.
  it("hands the cleanup job each env template's image tag", async () => {
    const fake = setup(null);
    const TEMPLATE = '00000000-0000-4000-8000-0000000000c1';
    fake.insert(schema.envTemplates, { id: TEMPLATE, userId: USER, imageTag: 'haive-env:abc' });
    fake.insert(schema.tasks, {
      id: '00000000-0000-4000-8000-0000000000d1',
      userId: USER,
      repositoryId: REPO,
      envTemplateId: TEMPLATE,
      type: 'workflow',
      title: 'task',
      status: 'completed',
    });
    const res = await app.request(`/${REPO}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(h.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        envTemplateIds: [TEMPLATE],
        envImageTags: { [TEMPLATE]: 'haive-env:abc' },
      }),
    );
  });

  // A Retry of a failed task takes this key, so the delete takes it too: a Retry that commits after
  // the delete read its tasks would leave a running task whose repository the delete cleared.
  it('takes the repository task-creation key', async () => {
    const keys: string[] = [];
    setup(null).hooks.beforeLock = (key) => {
      keys.push(key);
    };
    const res = await app.request(`/${REPO}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(keys).toEqual([`onboarding-upgrade:${REPO}`]);
  });

  it('answers 409 busy when the key wait times out, deleting nothing', async () => {
    const fake = setup(null);
    fake.hooks.beforeLock = () => {
      throw Object.assign(new Error('Failed query'), {
        cause: Object.assign(new Error('canceling statement due to lock timeout'), {
          code: '55P03',
        }),
      });
    };
    const res = await app.request(`/${REPO}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(fake.rows(schema.repositories)).toHaveLength(1);
    expect(h.cleanup).not.toHaveBeenCalled();
  });

  it("answers 404 for another user's repository without queuing on its key", async () => {
    const fake = setup(null);
    const OTHERS = '00000000-0000-4000-8000-0000000000b2';
    fake.insert(schema.repositories, {
      id: OTHERS,
      userId: '00000000-0000-4000-8000-0000000000a2',
      name: 'theirs',
      source: 'git',
      status: 'ready',
    });
    const keys: string[] = [];
    fake.hooks.beforeLock = (key) => {
      keys.push(key);
    };
    const res = await app.request(`/${OTHERS}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(keys).toEqual([]);
    expect(fake.rows(schema.repositories)).toHaveLength(2);
    expect(h.cleanup).not.toHaveBeenCalled();
  });
});

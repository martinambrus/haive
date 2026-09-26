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
  const fake = createFakeDb({ repositories: schema.repositories, tasks: schema.tasks });
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
});

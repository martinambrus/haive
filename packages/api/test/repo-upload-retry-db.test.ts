import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, REPO_JOB_NAMES } from '@haive/shared';
import type { AppEnv } from '../src/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { repoRoutes } from '../src/routes/repos.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: '',
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', h.userId);
    await next();
  },
}));
vi.mock('../src/queues.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues.js')>()),
  getRepoQueue: () => ({ add: h.add, getJobs: async () => [] }),
}));

const url = process.env.UPLOAD_RETRY_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/upload_retry_test_')) {
  throw new Error('Use a dedicated upload_retry_test_ database');
}
const app = new Hono<AppEnv>();
app.route('/', repoRoutes);
app.onError(errorHandler);

describe.skipIf(!url)('upload retry against Postgres', () => {
  let repoId: string;
  beforeAll(() => {
    h.db = createDatabase(url!);
  });
  beforeEach(async () => {
    h.userId = randomUUID();
    repoId = randomUUID();
    h.add.mockClear();
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    await h.db.insert(schema.users).values({
      id: h.userId,
      emailEncrypted: 'test',
      emailBlindIndex: h.userId,
      passwordHash: 'test',
    });
    await h.db
      .insert(schema.repositories)
      .values({ id: repoId, userId: h.userId, name: 'upload', source: 'upload', status: 'error' });
  });
  afterEach(async () => {
    await h.db.delete(schema.users).where(eq(schema.users.id, h.userId));
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await h.db.$client.end({ timeout: 5 });
  });
  async function source(status = 'complete') {
    await h.db.insert(schema.repoUploads).values({
      id: repoId,
      userId: h.userId,
      filename: 'a.zip',
      archiveFormat: 'zip',
      archivePath: `/var/lib/haive/repos/_uploads/${h.userId}/${repoId}.zip`,
      totalSize: 10,
      chunkSize: 10,
      status,
    });
  }
  async function listed() {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        repositories: {
          canRetry: boolean;
          retryUnavailableReason: string | null;
          statusMessage: string | null;
        }[];
      }
    ).repositories[0]!;
  }

  it('does not promise Retry without an archive record, even with stale Retry copy', async () => {
    await h.db
      .update(schema.repositories)
      .set({ statusMessage: 'Use Retry to start again.' })
      .where(eq(schema.repositories.id, repoId));
    expect((await listed()).canRetry).toBe(false);
    expect((await listed()).retryUnavailableReason).toMatch(/delete.*repository.*upload.*again/i);
  });
  it('offers Retry until the worker has recorded that the archive is gone', async () => {
    await source();
    expect((await listed()).canRetry).toBe(true);
    expect((await listed()).retryUnavailableReason).toBeNull();
    await h.db
      .update(schema.repoUploads)
      .set({ status: 'cancelled' })
      .where(eq(schema.repoUploads.id, repoId));
    expect((await listed()).canRetry).toBe(false);
    expect((await listed()).retryUnavailableReason).toMatch(/delete.*repository.*upload.*again/i);
    const res = await app.request(`/${repoId}/refresh-tree`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/delete.*repository.*upload.*again/i);
    expect(h.add).not.toHaveBeenCalled();
  });
  it('admits exactly one simultaneous extraction retry', async () => {
    await source();
    const results = await Promise.all(
      [0, 1].map(() => app.request(`/${repoId}/refresh-tree`, { method: 'POST' })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.add.mock.calls[0]![0]).toBe(REPO_JOB_NAMES.EXTRACT);
  });
});

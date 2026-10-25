import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  it.each(['blank', 'git_https', 'github_https', 'github_oauth', 'gitlab_https'] as const)(
    'does not promise Retry for %s without a remote, even with stale Retry copy',
    async (source) => {
      await h.db
        .update(schema.repositories)
        .set({ source, statusMessage: 'Use Retry to start again.' })
        .where(eq(schema.repositories.id, repoId));
      const repo = await listed();
      expect(repo.canRetry).toBe(false);
      expect(repo.retryUnavailableReason).toMatch(
        /no remote.*delete.*repository.*(create|add).*again/i,
      );
      expect((await app.request(`/${repoId}/refresh-tree`, { method: 'POST' })).status).toBe(409);
      expect(h.add).not.toHaveBeenCalled();
    },
  );
  it.each([
    'git_https',
    'github_https',
    'github_oauth',
    'gitlab_https',
    'upload',
    'blank',
    'local_path',
  ] as const)(
    'keeps Retry for %s with a usable source despite a temporary root fence',
    async (source) => {
      await h.db
        .update(schema.repositories)
        .set({
          source,
          remoteUrl: source === 'local_path' ? null : 'https://example.com/r.git',
          localPath: source === 'local_path' ? '/host-fs/repo' : null,
          rootClaimedAt: new Date(),
          rootClaimKind: 'reset',
        })
        .where(eq(schema.repositories.id, repoId));
      expect((await listed()).canRetry).toBe(true);
      expect((await listed()).retryUnavailableReason).toBeNull();
      expect((await app.request(`/${repoId}/refresh-tree`, { method: 'POST' })).status).toBe(409);
    },
  );
  it('keeps an available upload retry visible while a task holds the repository', async () => {
    await source();
    await h.db.insert(schema.tasks).values({
      repositoryId: repoId,
      userId: h.userId,
      type: 'workflow',
      title: 'holds root',
      status: 'running',
    });
    expect((await listed()).canRetry).toBe(true);
    expect((await listed()).retryUnavailableReason).toBeNull();
    expect((await app.request(`/${repoId}/refresh-tree`, { method: 'POST' })).status).toBe(409);
    expect(h.add).not.toHaveBeenCalled();
  });
  it('persists a single-shot upload source that drives a later failed-upload retry', async () => {
    const storage = await mkdtemp(path.join(tmpdir(), 'upload-source-'));
    const previous = process.env.REPO_STORAGE_ROOT;
    process.env.REPO_STORAGE_ROOT = storage;
    try {
      const bytes = new Uint8Array([80, 75, 3, 4, 0, 1, 2, 3]);
      const form = new FormData();
      form.set('archive', new File([bytes], 'source.zip'));
      form.set('name', 'Single shot');
      form.set('branch', 'fixture-branch');
      const res = await app.request('/upload', { method: 'POST', body: form });
      expect(res.status).toBe(201);
      const { repository } = (await res.json()) as { repository: { id: string } };
      const expectedPath = path.join(storage, '_uploads', h.userId, `${repository.id}.zip`);
      const upload = await h.db.query.repoUploads.findFirst({
        where: eq(schema.repoUploads.id, repository.id),
      });
      expect(upload).toMatchObject({
        id: repository.id,
        userId: h.userId,
        filename: 'source.zip',
        archiveFormat: 'zip',
        archivePath: expectedPath,
        totalSize: bytes.length,
        bytesReceived: bytes.length,
        chunkSize: bytes.length,
        status: 'complete',
      });
      expect(await readFile(expectedPath)).toEqual(Buffer.from(bytes));
      expect(h.add).toHaveBeenCalledWith(
        REPO_JOB_NAMES.EXTRACT,
        expect.objectContaining({
          repositoryId: repository.id,
          archivePath: expectedPath,
          archiveFormat: 'zip',
          branch: 'fixture-branch',
        }),
        expect.objectContaining({ attempts: 1 }),
      );
      await h.db
        .update(schema.repositories)
        .set({ status: 'error' })
        .where(eq(schema.repositories.id, repository.id));
      h.add.mockClear();
      expect((await app.request(`/${repository.id}/refresh-tree`, { method: 'POST' })).status).toBe(
        200,
      );
      expect(h.add).toHaveBeenCalledTimes(1);
      expect(h.add).toHaveBeenCalledWith(
        REPO_JOB_NAMES.EXTRACT,
        expect.objectContaining({
          repositoryId: repository.id,
          userId: h.userId,
          source: 'upload',
          archivePath: expectedPath,
          archiveFormat: 'zip',
          branch: 'fixture-branch',
        }),
        expect.objectContaining({ attempts: 1 }),
      );
    } finally {
      if (previous === undefined) delete process.env.REPO_STORAGE_ROOT;
      else process.env.REPO_STORAGE_ROOT = previous;
      await rm(storage, { recursive: true, force: true });
    }
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

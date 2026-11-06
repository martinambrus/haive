import { expect, it, vi } from 'vitest';
import { QUEUE_NAMES } from '@haive/shared';
import { createDatabase, schema, type Database } from '@haive/database';
import { eq, sql } from 'drizzle-orm';
import { startModuleControlWorker } from '../src/queues/module-control-queue.js';
import * as sourceQueue from '../src/queues/module-source-queue.js';

const h = vi.hoisted(() => ({
  workers: new Map<
    string,
    { process: (job: unknown) => Promise<unknown>; options: { concurrency: number } }
  >(),
  fetch: vi.fn(),
  db: undefined as Database | undefined,
  failed: undefined as ((job: unknown, error: Error) => void) | undefined,
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Queue: class {},
  Worker: class {
    constructor(
      name: string,
      process: (job: unknown) => Promise<unknown>,
      options: { concurrency: number },
    ) {
      h.workers.set(name, { process, options });
    }
    on(event: string, handler: (job: unknown, error: Error) => void) {
      if (event === 'failed') h.failed = handler;
      return this;
    }
  },
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db ?? {} }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('../src/modules/source-jobs.js', async (original) => ({
  ...(await original<typeof import('../src/modules/source-jobs.js')>()),
  runModuleSourceFetch: h.fetch,
  recoverModuleSourceFetches: vi.fn(),
}));
const url = process.env.MODULE_SOURCES_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_sources_test'))
  throw new Error('Use a dedicated module_sources_test database');
it.skipIf(!url)(
  'records queue failure for a microsecond timestamp and ignores an older job',
  async () => {
    const db = createDatabase(url!);
    h.db = db;
    vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'false');
    let id: string | undefined;
    try {
      const [row] = await db
        .insert(schema.moduleSources)
        .values({
          moduleId: 'queue-failure-test',
          kind: 'git',
          url: 'https://example.com/a',
          ref: 'main',
          fetchStatus: 'fetching',
          updatedAt: sql`TIMESTAMP '2026-11-06 12:00:00.123999'`,
        })
        .returning();
      id = row!.id;
      sourceQueue.startModuleSourceWorker();
      const current = async () =>
        (await db.select().from(schema.moduleSources).where(eq(schema.moduleSources.id, id!)))[0]!;
      h.failed!(
        { data: { sourceId: id, requestedAt: '2026-11-06T12:00:00.122Z' } },
        new Error('stale'),
      );
      h.failed!(
        { data: { sourceId: id, requestedAt: row!.updatedAt.toISOString() } },
        new Error('failed'),
      );
      await vi.waitFor(async () => expect((await current()).fetchStatus).toBe('failed'));
      await db
        .update(schema.moduleSources)
        .set({ fetchStatus: 'queued', updatedAt: sql`TIMESTAMP '2026-11-06 12:00:00.124999'` })
        .where(eq(schema.moduleSources.id, id));
      h.failed!(
        { data: { sourceId: id, requestedAt: row!.updatedAt.toISOString() } },
        new Error('stale'),
      );
      // Allow the asynchronous failure handler to complete before inspecting the row.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await current()).fetchStatus).toBe('queued');
    } finally {
      if (id) await db.delete(schema.moduleSources).where(eq(schema.moduleSources.id, id));
      h.db = undefined;
      await db.$client.end({ timeout: 5 });
      vi.unstubAllEnvs();
    }
  },
);
it('runs fetches on their own serial worker while teardown remains independently runnable', async () => {
  vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'false');
  try {
    startModuleControlWorker({ loaded: [], entries: [] });
    sourceQueue.startModuleSourceWorker();
    const source = h.workers.get(QUEUE_NAMES.MODULE_SOURCE)!;
    const control = h.workers.get(QUEUE_NAMES.MODULE_CONTROL)!;
    expect(source.options.concurrency).toBe(1);
    let release!: () => void;
    h.fetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const request = {
      name: 'fetch-source',
      data: { sourceId: 'source', requestedAt: '2026-11-05T00:00:00.000Z' },
    };
    const fetching = source.process(request);
    await expect(control.process({ name: 'unsupported', data: {} })).rejects.toThrow(
      'Unknown module-control job',
    );
    expect(h.fetch).toHaveBeenCalledWith({}, 'source', request.data.requestedAt);
    release();
    await fetching;
  } finally {
    vi.unstubAllEnvs();
  }
});

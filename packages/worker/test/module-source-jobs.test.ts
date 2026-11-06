import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, SecretsService, secretsService } from '@haive/shared';
import { eq, sql, type SQL } from 'drizzle-orm';
import { runModuleSourceFetch, recoverModuleSourceFetches } from '../src/modules/source-jobs.js';

const h = vi.hoisted(() => ({ fetch: vi.fn(), pin: vi.fn() }));
vi.mock('../src/modules/source-pin.js', () => ({ pinModuleTree: h.pin }));
vi.mock('../src/modules/source-fetch.js', async (original) => ({
  ...(await original<typeof import('../src/modules/source-fetch.js')>()),
  fetchModuleSource: h.fetch,
}));
const url = process.env.MODULE_SOURCES_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_sources_test'))
  throw new Error('Use a dedicated module_sources_test database');
let db: Database;
const sha = 'a'.repeat(40);
describe.skipIf(!url)('module fetch job persistence', () => {
  beforeAll(async () => {
    db = createDatabase(url!);
    vi.spyOn(configService, 'getEncryptionKey').mockResolvedValue('33'.repeat(32));
    await secretsService.initialize(db);
  });
  beforeEach(async () => {
    vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'true');
    await db.delete(schema.moduleSources);
    h.fetch.mockReset();
    h.pin.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end({ timeout: 5 });
  });
  async function source(updatedAt: Date | SQL = new Date()) {
    return (
      await db
        .insert(schema.moduleSources)
        .values({
          kind: 'git',
          moduleId: 'alpha',
          url: 'https://example.com/a',
          ref: 'main',
          fetchStatus: 'queued',
          updatedAt,
        })
        .returning()
    )[0]!;
  }
  it.each(['pinned', 'failed'])('claims a microsecond timestamp and records %s', async (status) => {
    const row = await source(sql`TIMESTAMP '2026-11-06 12:00:00.123999'`);
    // postgres.js constructs a Date, truncating (not rounding) the microseconds.
    expect(row.updatedAt.toISOString()).toBe('2026-11-06T12:00:00.123Z');
    h.fetch.mockImplementation(async (_source, _token, pin, resolved) => {
      await resolved(sha, 'refs/heads/main');
      if (status === 'failed') throw new Error('fixture fetch failed');
      await pin('fake', 'fake', 'alpha');
      return sha;
    });
    const fetch = runModuleSourceFetch(db, row.id, row.updatedAt.toISOString());
    if (status === 'failed') await expect(fetch).rejects.toThrow('fixture fetch failed');
    else await fetch;
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.pin).toHaveBeenCalledTimes(status === 'pinned' ? 1 : 0);
    expect(await db.select().from(schema.moduleSources)).toMatchObject([
      { fetchStatus: status, resolvedSha: sha, resolvedRef: 'refs/heads/main' },
    ]);
  });
  it('reads the fresh secret, publishes fetching and SHA, and admits only one concurrent fetch', async () => {
    const row = await source();
    const key = 'module_source:' + row.id + ':token';
    await secretsService.set(key, 'old-token');
    await secretsService.get(key);
    const writer = new SecretsService();
    await writer.initialize(db);
    await writer.set(key, 'new-token');
    expect(await secretsService.get(key)).toBe('old-token');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.fetch.mockImplementation(async (_source, token, pin, resolved) => {
      expect(token).toBe('new-token');
      await resolved(sha, 'refs/heads/main');
      started();
      await hold;
      await pin('fake', 'fake', 'alpha');
      return sha;
    });
    const first = runModuleSourceFetch(db, row.id);
    await ready;
    expect(await db.select().from(schema.moduleSources)).toMatchObject([
      { fetchStatus: 'fetching', resolvedSha: sha, resolvedRef: 'refs/heads/main' },
    ]);
    await runModuleSourceFetch(db, row.id);
    expect(h.fetch).toHaveBeenCalledOnce();
    release();
    await first;
    expect(await db.select().from(schema.moduleSources)).toMatchObject([
      { fetchStatus: 'pinned', resolvedSha: sha, lastError: null },
    ]);
    await secretsService.delete(key);
  });
  it('stores a scrubbed failed status and keeps the resolved SHA for a retry', async () => {
    const row = await source();
    const key = 'module_source:' + row.id + ':token';
    await secretsService.set(key, 'private-token');
    h.fetch.mockImplementation(async (_source, _token, _pin, resolved) => {
      await resolved(sha, 'refs/heads/main');
      throw new Error('private-token https://user:pass@example.com/a');
    });
    await expect(runModuleSourceFetch(db, row.id)).rejects.toThrow();
    const [failed] = await db.select().from(schema.moduleSources);
    expect(failed).toMatchObject({
      fetchStatus: 'failed',
      resolvedSha: sha,
      resolvedRef: 'refs/heads/main',
    });
    expect(failed!.lastError).not.toMatch(/private-token|user:pass/);
    await secretsService.delete(key);
  });
  it('recovers committed queued or fetching rows without re-resolving SHA', async () => {
    const row = await source();
    const queue = { add: vi.fn() };
    await recoverModuleSourceFetches(db, queue);
    expect(queue.add).toHaveBeenCalledWith(
      'fetch-source',
      { sourceId: row.id, moduleId: 'alpha', requestedAt: row.updatedAt.toISOString() },
      expect.objectContaining({ jobId: 'source-' + row.id + '-' + row.updatedAt.getTime() }),
    );
    vi.stubEnv('HAIVE_PUBLISHED_INSTALL', '');
    queue.add.mockClear();
    await recoverModuleSourceFetches(db, queue);
    expect(queue.add).not.toHaveBeenCalled();
  });
  it('ignores a stale queued job after a newer request and refuses a superseded pin', async () => {
    const row = await source();
    await runModuleSourceFetch(db, row.id, new Date(row.updatedAt.getTime() - 1).toISOString());
    expect(h.fetch).not.toHaveBeenCalled();
    h.fetch.mockImplementation(async (_source, _token, pin, resolved) => {
      await resolved(sha, 'refs/heads/main');
      await db
        .update(schema.moduleSources)
        .set({ fetchStatus: 'queued', updatedAt: new Date(row.updatedAt.getTime() + 1) })
        .where(eq(schema.moduleSources.id, row.id));
      await pin('fake', 'fake', 'alpha');
    });
    await expect(runModuleSourceFetch(db, row.id, row.updatedAt.toISOString())).rejects.toThrow(
      /superseded/,
    );
    expect(h.pin).not.toHaveBeenCalled();
    expect(await db.select().from(schema.moduleSources)).toMatchObject([{ fetchStatus: 'queued' }]);
  });
});

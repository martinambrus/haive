import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  fresh: vi.fn(),
  git: vi.fn(),
  verify: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db, withFreshDatabase: h.fresh }));
vi.mock('../src/lib/relink-git.js', () => ({
  relinkGit: h.git,
  verifyRelinkCheckout: h.verify,
  gitFailureText: () => 'git operation failed',
}));
import { logger } from '@haive/shared';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  isRemoteConnectionError,
  markRemoteIntent,
  clearRemoteIntent,
  reconcileRemote,
  startRemoteReconcileSweep,
  REMOTE_SWEEP_BATCH,
  REMOTE_SWEEP_INTERVAL_MS,
} from '../src/lib/remote-reconcile.js';
const id = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const root = '/owned-repository';
const repo = { id, userId, storagePath: root, localPath: null };
let fake: ReturnType<typeof createFakeDb>;
let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  fake = createFakeDb({ repositories: schema.repositories });
  fake.insert(schema.repositories, {
    ...repo,
    name: 'owned',
    remoteUrl: 'https://saved.test/repo',
    remoteRelinkIntent: '00000000-0000-4000-8000-000000000003',
  });
  h.db = fake.db;
  h.fresh.mockImplementation((run: (db: unknown) => Promise<unknown>) => run(fake.db));
  h.git.mockImplementation(async (_root, args: string[]) => ({
    ok: !args.includes('add'),
    exitedClean: !args.includes('add'),
    code: args.includes('add') ? 3 : 0,
    stdout: '',
    stderr: '',
  }));
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'ECONNRESET',
  'EPIPE',
  '08006',
  '57P01',
  '40003',
])('recognizes structured connection error %s through wrappers', (code) => {
  expect(isRemoteConnectionError(new AggregateError([{ cause: { code } }]))).toBe(true);
});
it('keeps ordinary failures on the restore path and terminates cyclic causes', () => {
  const cycle = { code: '23505', cause: undefined as unknown };
  cycle.cause = cycle;
  expect(isRemoteConnectionError(cycle)).toBe(false);
  expect(isRemoteConnectionError(new Error('connection closed'))).toBe(false);
});
const pending = () => fake.rows(schema.repositories)[0]!.remoteRelinkIntent as string | null;
it('commits a fresh intent token and inherits a predecessor repair', async () => {
  const previous = pending();
  const inherited = await markRemoteIntent(id, userId);
  expect(inherited.created).toBe(false);
  expect(inherited.token).not.toBe(previous);
  expect(pending()).toBe(inherited.token);
  fake.patch(schema.repositories, id, { remoteRelinkIntent: null });
  expect((await markRemoteIntent(id, userId)).created).toBe(true);
});
it('never clears another request token', async () => {
  const previous = pending();
  await clearRemoteIntent(id, '00000000-0000-4000-8000-000000000099');
  expect(pending()).toBe(previous);
  await clearRemoteIntent(id, previous!);
  expect(pending()).toBeNull();
});
it('leaves Git and the intent untouched when the fresh database read fails', async () => {
  h.fresh.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' }));
  await expect(reconcileRemote(id, userId)).rejects.toThrow('unavailable');
  expect(h.git).not.toHaveBeenCalled();
  expect(pending()).toBeTruthy();
});
it('reads the committed destination under the ownership lock and clears push overrides', async () => {
  await reconcileRemote(id, userId);
  expect(h.git.mock.calls.map((call) => call[1])).toEqual([
    ['remote', 'add', 'origin', 'https://saved.test/repo'],
    ['config', '--local', '--unset-all', 'remote.origin.pushurl'],
    ['config', '--local', '--replace-all', 'remote.origin.url', 'https://saved.test/repo'],
  ]);
  expect(pending()).toBeNull();
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBe('https://saved.test/repo');
});
it('does not touch a deleted or foreign-owned repository', async () => {
  await reconcileRemote(id, '00000000-0000-4000-8000-000000000099');
  expect(h.git).not.toHaveBeenCalled();
  expect(pending()).toBeTruthy();
});
it('removes an uncommitted first origin when the committed row has no remote', async () => {
  fake.patch(schema.repositories, id, { remoteUrl: null });
  await reconcileRemote(id, userId);
  expect(h.git).toHaveBeenCalledWith(root, ['remote', 'remove', 'origin']);
});
it('never writes legacy credentials or URL secrets to Git or the repair log', async () => {
  const secret = randomBytes(12).toString('hex');
  fake.patch(schema.repositories, id, {
    remoteUrl: `https://user:${secret}@saved.test/repo?key=${secret}#${secret}`,
  });
  await reconcileRemote(id, userId);
  const writes = JSON.stringify(h.git.mock.calls);
  expect(writes).not.toContain(secret);
  expect(writes).not.toContain('user:');
  expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toContain(secret);
});
it('keeps the intent when Git fails so the next sweep retries', async () => {
  h.git.mockResolvedValueOnce({ ok: false, code: 128, stderr: '' });
  await expect(reconcileRemote(id, userId)).rejects.toThrow('Could not reconcile');
  expect(pending()).toBeTruthy();
});
it('leaves an unmanaged folder origin alone without an intent', async () => {
  fake.patch(schema.repositories, id, { remoteRelinkIntent: null });
  fake.patch(schema.repositories, id, { remoteUrl: null });
  await reconcileRemote(id, userId);
  expect(h.git).not.toHaveBeenCalled();
  expect(pending()).toBeNull();
});
it('pins sweep defaults and rotates bounded pages without overlapping passes', async () => {
  vi.useFakeTimers();
  expect(REMOTE_SWEEP_BATCH).toBe(25);
  expect(REMOTE_SWEEP_INTERVAL_MS).toBe(30_000);
  fake.patch(schema.repositories, id, { remoteRelinkIntent: null });
  const pages = vi
    .fn()
    .mockResolvedValueOnce([repo])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
  h.db = { query: { repositories: { findMany: pages } } };
  const stop = startRemoteReconcileSweep({ batchSize: 1, intervalMs: 10 });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(pages).toHaveBeenCalledTimes(1);
    expect(pages.mock.calls[0]![0]).toMatchObject({ limit: 1, where: expect.anything() });
    await vi.advanceTimersByTimeAsync(10);
    expect(pages.mock.calls[1]![0].where).toBeDefined();
    await vi.advanceTimersByTimeAsync(10);
    expect(pages.mock.calls[2]![0].where).toEqual(pages.mock.calls[0]![0].where);
    expect(h.git).not.toHaveBeenCalled();
  } finally {
    stop();
  }
  await vi.advanceTimersByTimeAsync(100);
  expect(pages).toHaveBeenCalledTimes(3);
});
it('retries a failed sweep read on the next timer tick', async () => {
  vi.useFakeTimers();
  const pages = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
  h.db = { query: { repositories: { findMany: pages } } };
  const stop = startRemoteReconcileSweep({ intervalMs: 10 });
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(pages).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});

it('reconciles a pending repository from a sweep and clears its intent before stopping', async () => {
  vi.useFakeTimers();
  const pages = vi
    .spyOn(fake.db.query.repositories!, 'findMany')
    .mockResolvedValue([repo] as never);
  const stop = startRemoteReconcileSweep({ intervalMs: 10 });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.git).toHaveBeenCalled();
  expect(pending()).toBeNull();
  stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(pages).toHaveBeenCalledOnce();
});

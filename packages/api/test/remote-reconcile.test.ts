import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  fresh: vi.fn(),
  pending: true,
  stat: vi.fn(),
  remove: vi.fn(),
  write: vi.fn(),
  ensure: vi.fn(),
  git: vi.fn(),
  verify: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db, withFreshDatabase: h.fresh }));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  lstatNoFollow: h.stat,
  removeFileIfIdentityNoFollow: h.remove,
  openFileNoFollow: vi.fn(async () => ({
    stat: async () => ({ dev: 1n, ino: 2n }),
    close: async () => {},
  })),
  writeFileNoFollow: h.write,
  ensureDirNoFollow: h.ensure,
}));
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
  markRemotePending,
  reconcileRemote,
  reconcileRemoteOnRead,
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
  h.pending = true;
  fake = createFakeDb({ repositories: schema.repositories });
  fake.insert(schema.repositories, {
    ...repo,
    name: 'owned',
    remoteUrl: 'https://saved.test/repo',
  });
  h.db = fake.db;
  h.fresh.mockImplementation((run: (db: unknown) => Promise<unknown>) => run(h.db));
  h.stat.mockImplementation(async (_root, rel) =>
    rel === '.' || rel === '.haive'
      ? { kind: 'directory', stats: { uid: 1000, gid: 1000 } }
      : h.pending
        ? { kind: 'file' }
        : null,
  );
  h.remove.mockImplementation(async () => {
    h.pending = false;
    return 'removed';
  });
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
it('records no remote or credential in its durable intent and preserves directory ownership', async () => {
  await markRemotePending(root);
  expect(h.write).toHaveBeenCalledWith(
    root,
    expect.any(String),
    'pending\n',
    expect.objectContaining({ durable: true }),
  );
  expect(h.ensure).toHaveBeenCalledWith(root, '.haive', { owner: { uid: 1000, gid: 1000 } });
});
it('leaves Git and the intent untouched when the fresh database read fails', async () => {
  h.fresh.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' }));
  await expect(reconcileRemote(id, userId)).rejects.toThrow('unavailable');
  expect(h.git).not.toHaveBeenCalled();
  expect(h.remove).not.toHaveBeenCalled();
});
it('reads the committed destination under the ownership lock and clears push overrides', async () => {
  await reconcileRemote(id, userId);
  expect(h.git.mock.calls.map((call) => call[1])).toEqual([
    ['remote', 'add', 'origin', 'https://saved.test/repo'],
    ['config', '--local', '--unset-all', 'remote.origin.pushurl'],
    ['config', '--local', '--replace-all', 'remote.origin.url', 'https://saved.test/repo'],
  ]);
  expect(h.remove).toHaveBeenCalledOnce();
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBe('https://saved.test/repo');
});
it('does not touch a deleted or foreign-owned repository', async () => {
  await reconcileRemote(id, '00000000-0000-4000-8000-000000000099');
  expect(h.git).not.toHaveBeenCalled();
  expect(h.remove).not.toHaveBeenCalled();
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
  expect(h.remove).not.toHaveBeenCalled();
});
it('repairs a pending read once and leaves an unmanaged folder origin alone', async () => {
  await reconcileRemoteOnRead(repo);
  await reconcileRemoteOnRead(repo);
  expect(h.fresh).toHaveBeenCalledOnce();
  expect(info).toHaveBeenCalledOnce();
  fake.patch(schema.repositories, id, { remoteUrl: null });
  await reconcileRemoteOnRead(repo);
  expect(h.fresh).toHaveBeenCalledOnce();
});
it('refuses an unreadable intent instead of treating it as absence', async () => {
  h.stat.mockRejectedValueOnce(
    Object.assign(new Error('descriptor exhaustion'), { code: 'EMFILE' }),
  );
  await expect(reconcileRemoteOnRead(repo)).rejects.toMatchObject({ status: 503 });
  expect(h.git).not.toHaveBeenCalled();
});
it('pins sweep defaults and rotates bounded pages without overlapping passes', async () => {
  vi.useFakeTimers();
  expect(REMOTE_SWEEP_BATCH).toBe(25);
  expect(REMOTE_SWEEP_INTERVAL_MS).toBe(30_000);
  h.pending = false;
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
    expect(pages.mock.calls[0]![0]).toMatchObject({ limit: 1, where: undefined });
    await vi.advanceTimersByTimeAsync(10);
    expect(pages.mock.calls[1]![0].where).toBeDefined();
    await vi.advanceTimersByTimeAsync(10);
    expect(pages.mock.calls[2]![0].where).toBeUndefined();
    expect(h.fresh).not.toHaveBeenCalled();
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

it('skips other non-regular marker entries without running git', async () => {
  vi.useFakeTimers();
  h.stat.mockImplementation(async (_root, rel) => ({
    kind: rel === '.haive' ? 'directory' : 'other',
  }));
  h.db = { query: { repositories: { findMany: vi.fn().mockResolvedValue([repo]) } } };
  const stop = startRemoteReconcileSweep({ intervalMs: 10 });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(h.git).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
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
import { configService, logger } from '@haive/shared';
import { acquireRootClaim, type Database, schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  isRemoteConnectionError,
  markRemoteIntent,
  clearRemoteIntent,
  reconcileRemote,
  beginRelinkWriter,
  startRemoteReconcileSweep,
  REMOTE_SWEEP_BATCH,
  REMOTE_SWEEP_INTERVAL_MS,
  REMOTE_SKIP_LOG_INTERVAL_MS,
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
    status: 'ready',
    ...repo,
    name: 'owned',
    remoteUrl: 'https://saved.test/repo',
    remoteRelinkIntent: '00000000-0000-4000-8000-000000000003',
  });
  h.db = fake.db;
  h.fresh.mockImplementation((run: (db: unknown) => Promise<unknown>) =>
    run({
      ...fake.db,
      transaction: (work: (tx: unknown) => Promise<unknown>) =>
        fake.db.transaction(async (tx) =>
          work(
            new Proxy(tx, {
              get(target, prop) {
                if (prop !== 'execute') return Reflect.get(target, prop);
                return (query: any) =>
                  new PgDialect().sqlToQuery(query).sql.includes('pg_try_advisory_xact_lock')
                    ? Promise.resolve([{ taken: true }])
                    : target.execute(query);
              },
            }),
          ),
        ),
    }),
  );
  h.git.mockImplementation(async (_root, args: string[]) => ({
    ok: !args.includes('add'),
    exitedClean: !args.includes('add'),
    code: args.includes('add') ? 3 : 0,
    stdout: '',
    stderr: '',
  }));
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
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

it('leaves a repository to a relink in this process whose Git writes may still run', async () => {
  const end = beginRelinkWriter(id);
  await reconcileRemote(id, userId, { skipLocked: true });
  expect(h.git).not.toHaveBeenCalled();
  expect(fake.rows(schema.repositories)[0]!.remoteRelinkIntent).not.toBeNull();
  // The relink's own reconcile is not fenced.
  await reconcileRemote(id, userId);
  expect(h.git).toHaveBeenCalled();
  end();
  end();
  h.git.mockClear();
  fake.patch(schema.repositories, id, {
    remoteRelinkIntent: '00000000-0000-4000-8000-000000000004',
  });
  await reconcileRemote(id, userId, { skipLocked: true });
  expect(h.git).toHaveBeenCalled();
});

it.each(['fenced', 'locked'] as const)(
  'logs a %s sweep skip with a bounded per-repository rate',
  async (reason) => {
    vi.useFakeTimers();
    vi.spyOn(fake.db.query.repositories!, 'findMany').mockResolvedValue([repo] as never);
    const end = reason === 'fenced' ? beginRelinkWriter(id) : () => {};
    if (reason === 'locked') {
      // A SKIP LOCKED read returns no row, while an ordinary MVCC read still sees intent.
      const read = Object.assign(Promise.resolve([]), {
        from() {
          return this;
        },
        where() {
          return this;
        },
        for() {
          return this;
        },
      });
      const tx = {
        execute: async () => [{ taken: true }],
        select: () => read,
        query: { repositories: { findFirst: async () => ({ id }) } },
      };
      h.fresh.mockImplementation((run: (db: unknown) => Promise<unknown>) =>
        run({ transaction: (work: (value: unknown) => Promise<unknown>) => work(tx) }),
      );
    }
    const stop = startRemoteReconcileSweep({ intervalMs: 10, skipLogIntervalMs: 25 });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(info).toHaveBeenCalledExactlyOnceWith(
        { repositoryId: id, reason },
        'remote reconciliation skipped',
      );
      expect(REMOTE_SKIP_LOG_INTERVAL_MS).toBe(300_000);
      expect(h.git).not.toHaveBeenCalled();
      expect(pending()).toBeTruthy();
      await vi.advanceTimersByTimeAsync(20);
      expect(info).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(info).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      end();
    }
  },
);

it('does not report a deleted repository as locked in a sweep', async () => {
  vi.useFakeTimers();
  vi.spyOn(fake.db.query.repositories!, 'findMany').mockResolvedValue([repo] as never);
  await fake.db.delete(schema.repositories).where(eq(schema.repositories.id, id));
  const stop = startRemoteReconcileSweep({ intervalMs: 10 });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(info).not.toHaveBeenCalled();
    expect(h.git).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it.each(['cloning', 'claimed'])(
  'holds reconciliation during %s without consuming intent',
  async (state) => {
    fake.patch(
      schema.repositories,
      id,
      state === 'cloning'
        ? { status: 'cloning' }
        : { rootClaimedAt: new Date(), rootClaimKind: 'rebuild', rootClaimOwner: 'foreign' },
    );
    await expect(reconcileRemote(id, userId)).rejects.toMatchObject({
      code: 'checkout_unavailable',
    });
    expect(h.git).not.toHaveBeenCalled();
    expect(pending()).toBeTruthy();
  },
);

it('retains the root lease until Git settles after its transaction rejects', async () => {
  let entered!: () => void;
  let resume!: () => void;
  let rejectDriver!: (error: Error) => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const continued = new Promise<void>((r) => {
    resume = r;
  });
  let callback: Promise<unknown> | undefined;
  h.fresh.mockImplementation((run: (db: unknown) => Promise<unknown>) =>
    run({
      ...fake.db,
      transaction(fn: Parameters<typeof fake.db.transaction>[0]) {
        callback = fake.db.transaction(fn);
        return new Promise((_, reject) => {
          rejectDriver = reject;
        });
      },
    }),
  );
  h.git.mockImplementationOnce(async () => {
    entered();
    await continued;
    return { ok: true, exitedClean: true, code: 0, stdout: '', stderr: '' };
  });
  let returned = false;
  const result = reconcileRemote(id, userId).catch((error: unknown) => {
    returned = true;
    return error;
  });
  await started;
  const error = new Error('connection lost');
  rejectDriver(error);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  try {
    expect(returned).toBe(false);
    expect(fake.rows(schema.repositories)[0]!.rootClaimedAt).not.toBeNull();
  } finally {
    resume();
    await callback;
    await result;
  }
  expect(await result).toBe(error);
  expect(fake.rows(schema.repositories)[0]!.rootClaimedAt).toBeNull();
});

it('sweep logs a held mutation once, retains intent and reconciles after release', async () => {
  vi.useFakeTimers();
  const owner = (await acquireRootClaim(fake.db as unknown as Database, id, 'edit', userId))!;
  vi.spyOn(fake.db.query.repositories!, 'findMany').mockResolvedValue([repo] as never);
  const stop = startRemoteReconcileSweep({ intervalMs: 10 });
  try {
    await vi.advanceTimersByTimeAsync(20);
    expect(h.git).not.toHaveBeenCalled();
    expect(pending()).toBeTruthy();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    await owner.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.git).toHaveBeenCalled();
    expect(pending()).toBeNull();
  } finally {
    stop();
    await owner.release();
  }
});

it.each(['draining', 'maintenance'])(
  'skips a locked-out reconcile while %s without a claim or Git, and the sweep logs it at info',
  async (state) => {
    vi.spyOn(configService, 'getFresh').mockResolvedValue(state);
    let repositoryWrites = 0;
    fake.hooks.beforeUpdate = (table) => {
      if (table === schema.repositories) repositoryWrites += 1;
    };
    await expect(reconcileRemote(id, userId, { skipLocked: true })).resolves.toBe('maintenance');
    expect(repositoryWrites).toBe(0);
    expect(h.git).not.toHaveBeenCalled();
    expect(pending()).toBeTruthy();

    vi.useFakeTimers();
    vi.spyOn(fake.db.query.repositories!, 'findMany').mockResolvedValue([repo] as never);
    const stop = startRemoteReconcileSweep({ intervalMs: 10 });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(
        { repositoryId: id, reason: 'maintenance' },
        'remote reconciliation skipped',
      );
    } finally {
      stop();
    }
  },
);

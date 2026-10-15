import { afterEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  realStore: false,
  openOptions: [] as unknown[],
  statements: [] as Array<{ statement: string; params: unknown[] | undefined }>,
  batches: [0] as Array<number | { code: string }>,
  hang: false,
  ended: 0,
  awaiting: false,
  awaitingSeq: [] as boolean[],
  probeError: false,
  existingOpened: [] as string[],
  internalExists: false,
  tableMissing: false,
  onStatement: null as ((statement: string) => void) | null,
  logged: [] as unknown[][],
}));

const lockFake = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  const record = (...args: unknown[]) => void h.logged.push(args);
  const child = { trace: record, debug: record, info: record, warn: record, error: record };
  return { ...actual, logger: Object.create(actual.logger, { child: { value: () => child } }) };
});
vi.mock('@haive/shared/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/rag')>();
  const { createFakeRagLock } = await import('./rag-lock-fake.js');
  const fake = createFakeRagLock(actual);
  lockFake.value = fake;
  return {
    ...actual,
    tryAcquireRagSyncLock: fake.tryAcquireRagSyncLock,
    openExistingRagDatabase: async (_db: unknown, dbName: string) => {
      h.existingOpened.push(dbName);
      if (!h.internalExists) return null;
      return {
        mode: 'internal',
        embeddingDimensions: 8,
        pg: {
          begin: async () => {
            throw Object.assign(new Error('relation does not exist'), {
              code: h.tableMissing ? '42P01' : 'XX000',
            });
          },
          end: async () => {},
        },
        close: async () => {},
      };
    },
    resolveRagConnection: async (...args: Parameters<typeof actual.resolveRagConnection>) => {
      h.openOptions.push(args[3]);
      if (h.realStore) return actual.resolveRagConnection(...args);
      return {
        mode: 'external',
        embeddingDimensions: 8,
        pg: (() => {
          const unsafe = async (statement: string, params?: unknown[]) => {
            h.statements.push({ statement, params });
            h.onStatement?.(statement);
            if (statement.startsWith('SELECT')) {
              if (h.probeError) throw new Error('store read failed');
              const awaiting = h.awaitingSeq.length > 0 ? h.awaitingSeq.shift() : h.awaiting;
              return awaiting ? [{ found: 1 }] : [];
            }
            if (!statement.startsWith('UPDATE')) return [];
            if (h.hang) return new Promise(() => {});
            const next = h.batches.shift() ?? 0;
            if (typeof next !== 'number') throw Object.assign(new Error('canceled'), next);
            return Object.assign([], { count: next });
          };
          return {
            unsafe,
            begin: async (run: (tx: { unsafe: typeof unsafe }) => unknown) => run({ unsafe }),
            end: async () => {
              h.ended += 1;
            },
          };
        })(),
        close: async () => {},
      };
    },
  };
});

import net from 'node:net';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { userSecretsService } from '@haive/shared';
import { createFakeDb } from '@haive/database/testing';
import { ONBOARDING_TOOLING_SCHEMA_VERSION } from '@haive/shared';
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
import type { createFakeRagLock } from './rag-lock-fake.js';

const fakeLock = lockFake.value as ReturnType<typeof createFakeRagLock>;

const REPO = '00000000-0000-4000-8000-0000000000c1';

const app = new Hono<AppEnv>();
app.route('/', toolingUpgradeRoutes);
app.onError(errorHandler);

function setup(
  ragConnectionString: string,
  configured = true,
  degraded = false,
  tooling: Record<string, unknown> = {
    ragMode: 'external',
    ragConnectionString,
    embeddingDimensions: 8,
  },
) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
    auditEvents: schema.auditEvents,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'r',
    source: 'local_path',
    ...(degraded
      ? { ragEmbedDegradedAt: new Date(0), ragEmbedDegradedReason: 'Ollama is unreachable' }
      : {}),
    onboardingTooling: configured
      ? {
          schemaVersion: ONBOARDING_TOOLING_SCHEMA_VERSION,
          tooling,
        }
      : null,
  });
  h.db = fake.db;
  h.realStore = false;
  h.openOptions = [];
  h.statements = [];
  h.batches = [0];
  h.hang = false;
  h.ended = 0;
  h.awaiting = false;
  h.awaitingSeq = [];
  h.probeError = false;
  h.onStatement = null;
  h.logged = [];
  return fake;
}

const rebuild = () =>
  app.request(`/${REPO}/tooling`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ragEmbedAction: 'rebuild_index' }),
  });

const retry = () =>
  app.request(`/${REPO}/tooling`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ragEmbedAction: 'retry' }),
  });

const stores: Array<() => Promise<void>> = [];

afterEach(async () => {
  fakeLock.reset();
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((close) => close()));
});

/** A Postgres that accepts the connection and never speaks. */
async function mutePostgres() {
  const sockets = new Set<net.Socket>();
  const seen = { connections: 0 };
  const server = net.createServer((socket) => {
    seen.connections += 1;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stores.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as net.AddressInfo;
  return { url: `postgres://rag:rag@127.0.0.1:${port}/rag`, seen };
}

describe('forcing a re-embed of a repository', () => {
  it('resets the chunk hashes of that repository in batches, on a store opened with a connect timeout', async () => {
    setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [500, 500, 120, 0];

    const res = await rebuild();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reembedQueued: true });
    const updates = h.statements.filter((s) => s.statement.startsWith('UPDATE'));
    expect(updates).toHaveLength(4);
    for (const update of updates) {
      expect(update.statement).toContain('chunk_hash = NULL');
      expect(update.statement).toContain('chunk_hash IS NOT NULL');
      expect(update.statement).toContain('LIMIT 500');
      expect(update.params).toEqual([REPO]);
    }
    expect(h.openOptions).toEqual([{ connectTimeoutSeconds: 3, fetchTypes: false }]);
  });

  it('leaves the repository marked degraded until the re-embed lands', async () => {
    const fake = setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [500, 0];

    const res = await rebuild();

    expect(res.status).toBe(200);
    const [row] = fake.rows(schema.repositories);
    expect(row!.ragEmbedDegradedAt).toBeInstanceOf(Date);
    expect(row!.ragEmbedDegradedReason).toEqual(expect.any(String));
    expect(row!.ragEmbedLexicalOnly).toBe(false);
  });

  it('does not mark a repository degraded when there is no store to re-embed', async () => {
    const fake = setup('postgres://rag:rag@127.0.0.1:1/rag', false);

    const res = await rebuild();

    expect(await res.json()).toMatchObject({ reembedQueued: false });
    expect(fake.rows(schema.repositories)[0]!.ragEmbedDegradedAt ?? null).toBeNull();
  });

  it('sets a statement timeout inside every batch transaction, before its UPDATE', async () => {
    setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [500, 500, 0];

    await rebuild();

    expect(h.statements.map((s) => s.statement.split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'SET LOCAL',
      'UPDATE ai_rag_embeddings',
      'SET LOCAL',
      'UPDATE ai_rag_embeddings',
      'SET LOCAL',
      'UPDATE ai_rag_embeddings',
    ]);
    expect(h.statements[0]!.statement).toBe("SET LOCAL statement_timeout = '3000ms'");
  });

  it('leaves the repository marked degraded when the reset fails part-way', async () => {
    const fake = setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [500, { code: '57014' }];

    expect((await rebuild()).status).toBe(503);
    const [row] = fake.rows(schema.repositories);
    expect(row!.ragEmbedDegradedAt).toBeInstanceOf(Date);
    expect(row!.ragEmbedDegradedReason).toEqual(expect.any(String));
  });

  it('answers 503 with the number of chunks already marked when a batch hits the statement timeout', async () => {
    setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [500, { code: '57014' }];

    const res = await rebuild();

    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('after 500 chunks were marked'),
    });
  });

  it('answers 503 at the deadline when the store accepts a statement and never answers', async () => {
    vi.useFakeTimers();
    try {
      setup('postgres://rag:rag@127.0.0.1:1/rag');
      h.hang = true;

      const pending = rebuild();
      await vi.advanceTimersByTimeAsync(60_000);
      const res = await pending;

      expect(res.status).toBe(503);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining('not finished'),
      });
      expect(h.ended).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a failure that is not a timeout a 500', async () => {
    setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [{ code: '42P01' }];

    expect((await rebuild()).status).toBe(500);
  });

  it('answers its error within the connect timeout when the store accepts the connection and never speaks', async () => {
    const store = await mutePostgres();
    setup(store.url);
    h.realStore = true;

    const started = Date.now();
    const res = await rebuild();
    const elapsed = Date.now() - started;

    expect(res.status).toBe(500);
    expect(store.seen.connections).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5_000);
  }, 40_000);
});

describe('retrying the embedding of a degraded repository', () => {
  const STORE = 'postgres://rag:rag@127.0.0.1:1/rag';

  const internalSetup = () => {
    const fake = setup(STORE, true, true, { ragMode: 'internal', embeddingDimensions: 8 });
    h.existingOpened = [];
    h.internalExists = false;
    h.tableMissing = false;
    return fake;
  };

  it('opens an internal store only if it exists, and clears when there is none', async () => {
    const fake = internalSetup();

    const res = await retry();

    expect(h.existingOpened).toHaveLength(2);
    expect(h.openOptions).toEqual([]);
    expect(fake.rows(schema.repositories)[0]!.ragEmbedDegradedAt ?? null).toBeNull();
    expect(await res.json()).toMatchObject({ degradationKept: false });
  });

  it('clears when the internal store has no index table yet', async () => {
    const fake = internalSetup();
    h.internalExists = true;
    h.tableMissing = true;

    await retry();

    expect(fake.rows(schema.repositories)[0]!.ragEmbedDegradedAt ?? null).toBeNull();
  });

  it('keeps the degradation while the store holds rows awaiting re-embed', async () => {
    const fake = setup(STORE, true, true);
    h.awaiting = true;

    const res = await retry();

    expect(res.status).toBe(200);
    const [row] = fake.rows(schema.repositories);
    expect(row!.ragEmbedDegradedAt).toBeInstanceOf(Date);
    expect(row!.ragEmbedDegradedReason).toBe('Ollama is unreachable');
    expect(await res.json()).toMatchObject({ degradationKept: true, reembedQueued: false });
  });

  it('restores the degradation when rows appear between the probe and the clear', async () => {
    const fake = setup(STORE, true, true);
    h.awaitingSeq = [false, true];

    const res = await retry();

    const [row] = fake.rows(schema.repositories);
    expect(row!.ragEmbedDegradedAt).toBeInstanceOf(Date);
    expect(row!.ragEmbedDegradedReason).toBe('Ollama is unreachable');
    expect(await res.json()).toMatchObject({ degradationKept: true });
  });

  it('restores nothing and answers 409 when the lock is lost during the second probe', async () => {
    const fake = setup(STORE, true, true);
    h.awaitingSeq = [false, true];
    let selects = 0;
    h.onStatement = (statement) => {
      if (statement.startsWith('SELECT') && ++selects === 2) fakeLock.state.handles[0]!.lost = true;
    };

    const res = await retry();

    expect(res.status).toBe(409);
    expect(selects).toBe(2);
    expect(fake.rows(schema.repositories)[0]!.ragEmbedDegradedAt).toBeNull();
  });

  it('keeps the degradation when the probe fails', async () => {
    const fake = setup(STORE, true, true);
    h.probeError = true;

    const res = await retry();

    expect(fake.rows(schema.repositories)[0]!.ragEmbedDegradedAt).toBeInstanceOf(Date);
    expect(await res.json()).toMatchObject({ degradationKept: true });
  });

  it('keeps the degradation, within the connect timeout, when the store accepts the connection and never speaks', async () => {
    const store = await mutePostgres();
    const fake = setup(store.url, true, true);
    h.realStore = true;

    const started = Date.now();
    const res = await retry();

    expect(await res.json()).toMatchObject({ degradationKept: true });
    expect(fake.rows(schema.repositories)[0]!.ragEmbedDegradedAt).toBeInstanceOf(Date);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 40_000);

  it('clears the degradation when the store holds no row awaiting re-embed', async () => {
    const fake = setup(STORE, true, true);

    const res = await retry();

    expect(await res.json()).toMatchObject({ reembedQueued: false });
    const [row] = fake.rows(schema.repositories);
    expect(row!.ragEmbedDegradedAt ?? null).toBeNull();
    expect(row!.ragEmbedDegradedReason ?? null).toBeNull();
  });

  it('clears the degradation when the repository has no RAG store configured', async () => {
    const fake = setup(STORE, false, true);

    const res = await retry();

    expect(res.status).toBe(200);
    expect(fake.rows(schema.repositories)[0]!.ragEmbedDegradedAt ?? null).toBeNull();
    expect(h.statements).toEqual([]);
  });

  it('probes with a bounded, repository-scoped read that skips task rows, again after it clears', async () => {
    setup(STORE, true, true);

    await retry();

    const bounds = { connectTimeoutSeconds: 3, fetchTypes: false };
    expect(h.openOptions).toEqual([bounds, bounds]);
    expect(h.statements.map((s) => s.statement.split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'SET LOCAL',
      'SELECT 1',
      'SET LOCAL',
      'SELECT 1',
    ]);
    expect(h.statements[1]!.statement).toContain('chunk_hash IS NULL');
    expect(h.statements[1]!.params).toEqual([REPO, 'task']);
  });

  it('opens no store for a repository that is not degraded', async () => {
    setup(STORE);

    await retry();

    expect(h.openOptions).toEqual([]);
  });
});

describe('a RAG embed action while a sync of the repository runs', () => {
  const patch = (body: Record<string, unknown>) =>
    app.request(`/${REPO}/tooling`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it.each(['retry', 'rebuild_index'] as const)(
    'refuses %s with 409 and writes nothing',
    async (ragEmbedAction) => {
      const fake = setup('postgres://rag:rag@127.0.0.1:1/rag', true, true);
      const before = structuredClone(fake.rows(schema.repositories));
      const secrets = vi.spyOn(userSecretsService, 'set').mockResolvedValue(undefined as never);
      fakeLock.state.held.add(REPO);

      const res = await patch({ ragEmbedAction, appAuthPassword: 'pw', rtkEnabled: false });

      expect(res.status).toBe(409);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: expect.stringMatching(/RAG sync of this repository is running/i),
      });
      expect(fake.rows(schema.repositories)).toEqual(before);
      expect(h.statements).toEqual([]);
      expect(secrets).not.toHaveBeenCalled();
    },
  );

  it('answers 503 and writes nothing when Redis cannot be reached', async () => {
    const fake = setup('postgres://rag:rag@127.0.0.1:1/rag', true, true);
    const before = structuredClone(fake.rows(schema.repositories));
    fakeLock.state.redisDown = true;

    const res = await patch({ ragEmbedAction: 'retry' });

    expect(res.status).toBe(503);
    expect(fake.rows(schema.repositories)).toEqual(before);
    expect(h.statements).toEqual([]);
  });

  it('answers 503 and writes nothing when Redis does not answer the lock command', async () => {
    const fake = setup('postgres://rag:rag@127.0.0.1:1/rag', true, true);
    const before = structuredClone(fake.rows(schema.repositories));
    fakeLock.state.stalled = true;

    const res = await patch({ ragEmbedAction: 'retry' });

    expect(res.status).toBe(503);
    expect(fake.rows(schema.repositories)).toEqual(before);
    expect(h.statements).toEqual([]);
  }, 3_000);

  it('holds the lock across the work and releases it after success', async () => {
    setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [500, 0];

    expect((await rebuild()).status).toBe(200);

    expect(fakeLock.state.tried.map((t) => t.repositoryId)).toEqual([REPO]);
    expect(fakeLock.state.handles.map((handle) => handle.released)).toEqual([1]);
    expect(fakeLock.state.held.size).toBe(0);
  });

  it('releases it when the work fails', async () => {
    setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [500, { code: '57014' }];

    expect((await rebuild()).status).toBe(503);

    expect(fakeLock.state.handles.map((handle) => handle.released)).toEqual([1]);
  });

  it('does not take the lock for a request without a RAG action', async () => {
    const fake = setup('postgres://rag:rag@127.0.0.1:1/rag');
    fakeLock.state.held.add(REPO);

    const res = await patch({ rtkEnabled: false });

    expect(res.status).toBe(200);
    expect(fakeLock.state.tried).toEqual([]);
    expect(fake.rows(schema.repositories)[0]!.rtkEnabled).toBe(false);
  });

  it('stops resetting and answers 409 once the lock is lost between two batches', async () => {
    const fake = setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [500, 500, 0];
    h.onStatement = (statement) => {
      if (statement.startsWith('UPDATE')) fakeLock.state.handles[0]!.lost = true;
    };

    const res = await rebuild();

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/lock of this repository was lost/i),
    });
    expect(h.statements.filter((s) => s.statement.startsWith('UPDATE'))).toHaveLength(1);
    expect(fake.rows(schema.repositories)[0]!.ragEmbedDegradedReason).toMatch(/rebuild pending/i);
    expect(fakeLock.state.handles.map((handle) => handle.released)).toEqual([1]);
  });

  it('keeps the degradation and answers 409 when the lock is lost during the retry probe', async () => {
    const fake = setup('postgres://rag:rag@127.0.0.1:1/rag', true, true);
    const before = structuredClone(fake.rows(schema.repositories));
    h.onStatement = (statement) => {
      if (statement.startsWith('SELECT')) fakeLock.state.handles[0]!.lost = true;
    };

    const res = await retry();

    expect(res.status).toBe(409);
    expect(fake.rows(schema.repositories)).toEqual(before);
  });

  it('answers a different repository while another is syncing', async () => {
    setup('postgres://rag:rag@127.0.0.1:1/rag');
    fakeLock.state.held.add('00000000-0000-4000-8000-0000000000c2');
    h.batches = [0];

    expect((await retry()).status).toBe(200);
  });
});

describe('saving or clearing the app-login credentials of a repository', () => {
  const STORE = 'postgres://rag:rag@127.0.0.1:1/rag';
  const USERNAME = 'audit-user-7f3';
  const PASSWORD = 'audit-pass-9c1';
  const ACTION = 'repository.app_auth.update';

  const patch = (body: Record<string, unknown>) =>
    app.request(`/${REPO}/tooling`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const spySecrets = () => ({
    set: vi.spyOn(userSecretsService, 'set').mockResolvedValue(undefined as never),
    remove: vi.spyOn(userSecretsService, 'delete').mockResolvedValue(undefined as never),
  });

  const auditLines = () =>
    h.logged
      .map(([fields]) => fields as { action?: string } | undefined)
      .filter((fields) => fields?.action === ACTION);

  const auditedMetadata = (fake: ReturnType<typeof setup>) => {
    const rows = fake.rows(schema.auditEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: USER,
      action: ACTION,
      targetType: 'repository',
      targetId: REPO,
    });
    return rows[0]!.metadata;
  };

  it('records one event naming both fields as set, and neither value', async () => {
    const fake = setup(STORE);
    const { set, remove } = spySecrets();

    const res = await patch({ appAuthUsername: USERNAME, appAuthPassword: PASSWORD });

    expect(res.status).toBe(200);
    expect(set.mock.calls).toEqual([
      [USER, `app_auth:${REPO}:username`, USERNAME, 'App login username', expect.anything()],
      [USER, `app_auth:${REPO}:password`, PASSWORD, 'App login password', expect.anything()],
    ]);
    const [first, second] = set.mock.calls;
    expect(second![4]).toBe(first![4]);
    expect(first![4]).not.toBe(fake.db);
    expect(remove).not.toHaveBeenCalled();
    expect(auditedMetadata(fake)).toStrictEqual({ username: 'set', password: 'set' });
    expect(auditLines()).toEqual([
      expect.objectContaining({
        actorUserId: USER,
        targetType: 'repository',
        targetId: REPO,
        username: 'set',
        password: 'set',
      }),
    ]);
    for (const value of [USERNAME, PASSWORD]) {
      expect(JSON.stringify(fake.rows(schema.auditEvents))).not.toContain(value);
      expect(JSON.stringify(h.logged)).not.toContain(value);
    }
  });

  it('records a cleared password as cleared and leaves the untouched username out', async () => {
    const fake = setup(STORE);
    const { set, remove } = spySecrets();

    const res = await patch({ appAuthPassword: '' });

    expect(res.status).toBe(200);
    expect(remove.mock.calls).toEqual([[USER, `app_auth:${REPO}:password`, expect.anything()]]);
    expect(remove.mock.calls[0]![2]).not.toBe(fake.db);
    expect(set).not.toHaveBeenCalled();
    expect(auditedMetadata(fake)).toStrictEqual({ password: 'cleared' });
    expect(auditLines()).toEqual([expect.objectContaining({ password: 'cleared' })]);
  });

  it('records no event when the password write fails after the username write', async () => {
    const fake = setup(STORE);
    vi.spyOn(userSecretsService, 'set')
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error('secret store unavailable'));

    const res = await patch({ appAuthUsername: USERNAME, appAuthPassword: PASSWORD });

    expect(res.status).toBe(500);
    expect(fake.rows(schema.auditEvents)).toEqual([]);
    expect(auditLines()).toEqual([]);
  });

  it.each([[{ rtkEnabled: false }], [{ appAuthUsername: null, appAuthPassword: 7 }]])(
    'records no event when the request sets or clears neither field: %j',
    async (body) => {
      const fake = setup(STORE);
      const { set, remove } = spySecrets();

      const res = await patch(body);

      expect(res.status).toBe(200);
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(fake.rows(schema.auditEvents)).toEqual([]);
      expect(auditLines()).toEqual([]);
    },
  );

  const refusals: Array<[string, number, () => void]> = [
    ['the sync lock is held', 409, () => fakeLock.state.held.add(REPO)],
    ['Redis cannot be reached', 503, () => (fakeLock.state.redisDown = true)],
    ['Redis does not answer the lock command', 503, () => (fakeLock.state.stalled = true)],
  ];

  it.each(refusals)('writes no secret and no event when %s', async (_why, status, arrange) => {
    const fake = setup(STORE, true, true);
    const before = structuredClone(fake.rows(schema.repositories));
    const { set, remove } = spySecrets();
    arrange();

    const res = await patch({
      ragEmbedAction: 'retry',
      appAuthUsername: USERNAME,
      appAuthPassword: '',
    });

    expect(res.status).toBe(status);
    expect(fake.rows(schema.repositories)).toEqual(before);
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(fake.rows(schema.auditEvents)).toEqual([]);
    expect(auditLines()).toEqual([]);
  });
});

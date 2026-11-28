import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import { eq, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/logger/index.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { logger } from '../src/logger/index.js';
import { CONFIG_KEYS, configService } from '../src/config/config.service.js';
import { SecretUnreadableError } from '../src/config/secret-unreadable.js';
import { SECRET_KEYS, SecretsService } from '../src/config/secrets.service.js';
import { decrypt, encrypt } from '../src/crypto/index.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const NAMES = [
  SECRET_KEYS.MASTER_KEK,
  SECRET_KEYS.JWT_SECRET,
  SECRET_KEYS.EMAIL_BLIND_INDEX_PEPPER,
];
const SOURCES = [
  'system_secrets',
  'users',
  'user_secrets',
  'cli_provider_secrets',
  'repo_credentials',
  'integration_provider_configs',
  'integration_connections',
];

const hex = (bytes = 32) => randomBytes(bytes).toString('hex');
let keyA: string;
let keyB: string;
/** Plain values behind the unreadable rows; never printed. */
const plain = new Map<string, string>();

function unreadableValue(name: string): string {
  const value = hex(16);
  plain.set(name, value);
  return encrypt(value, keyA);
}

interface TxRecord {
  audits: Record<string, unknown>[];
  deletes: number;
}

/** In-memory system_secrets + audit_events behind the db surface the service may use. */
function fakeDb() {
  const rows = new Map<string, string>();
  const audits = new Map<string, Record<string, unknown>>();
  const c = { reads: 0, inserts: 0, deletes: 0, transactions: 0, probes: 0 };
  const txs: TxRecord[] = [];
  const hooks: { afterFirstProbe: (() => void) | null; failProbe: Error | null } = {
    afterFirstProbe: null,
    failProbe: null,
  };

  const keyOf = (where: SQL) => new PgDialect().sqlToQuery(where).params[0] as string;

  const execute = vi.fn(async (query: SQL) => {
    const text = new PgDialect().sqlToQuery(query).sql.toLowerCase();
    if (text.includes('to_regclass')) return [{ providers: true, connections: true }];
    if (text.includes('lock table')) return [];
    if (text.includes('system_secrets') && text.includes('encrypted_value')) {
      c.probes += 1;
      c.reads += 1;
      if (hooks.failProbe) throw hooks.failProbe;
      const result = [...rows].map(([key, encrypted_value]) => ({ key, encrypted_value }));
      if (c.probes === 1) hooks.afterFirstProbe?.();
      return result;
    }
    return SOURCES.map((source) => ({
      source,
      count: String(source === 'system_secrets' ? rows.size : 0),
    }));
  });

  function deleteBuilder(onCall: () => void) {
    let key: string | null = null;
    const run = () => {
      onCall();
      const removed = key === null ? [...rows.keys()] : rows.has(key) ? [key] : [];
      for (const k of removed) rows.delete(k);
      return removed.map((k) => ({ key: k }));
    };
    const builder = {
      where(where: SQL) {
        key = keyOf(where);
        return builder;
      },
      returning: async () => run(),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  }

  function insertBuilder(table: unknown, onCall: () => void) {
    return {
      values(row: Record<string, unknown>) {
        const write = () => {
          onCall();
          if (table === schema.auditEvents) {
            const id = (row.id as string | undefined) ?? hex(8);
            if (audits.has(id)) return [];
            audits.set(id, row);
            return [{ id }];
          }
          rows.set(row.key as string, row.encryptedValue as string);
          return [];
        };
        return {
          onConflictDoUpdate: async () => {
            write();
          },
          onConflictDoNothing: () => ({ returning: async () => write() }),
        };
      },
    };
  }

  const db = {
    execute,
    query: {
      systemSecrets: {
        findFirst: async ({ where }: { where: SQL }) => {
          c.reads += 1;
          const value = rows.get(keyOf(where));
          return value === undefined ? undefined : { encryptedValue: value };
        },
      },
    },
    insert: (table: unknown) =>
      insertBuilder(table, () => {
        c.inserts += 1;
      }),
    delete: () =>
      deleteBuilder(() => {
        c.deletes += 1;
      }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      c.transactions += 1;
      const rowsBefore = new Map(rows);
      const auditsBefore = new Map(audits);
      const record: TxRecord = { audits: [], deletes: 0 };
      txs.push(record);
      const tx = {
        execute,
        insert: (table: unknown) => {
          const builder = insertBuilder(table, () => {});
          return {
            values(row: Record<string, unknown>) {
              if (table === schema.auditEvents) record.audits.push(row);
              return builder.values(row);
            },
          };
        },
        delete: () =>
          deleteBuilder(() => {
            record.deletes += 1;
          }),
      };
      try {
        return await fn(tx);
      } catch (error) {
        rows.clear();
        for (const [k, v] of rowsBefore) rows.set(k, v);
        audits.clear();
        for (const [k, v] of auditsBefore) audits.set(k, v);
        throw error;
      }
    },
  };

  return {
    db: db as unknown as Database,
    rows,
    audits,
    counts: c,
    txs,
    hooks,
    /** Replace the table content. */
    set(next: Record<string, string>) {
      rows.clear();
      for (const [k, v] of Object.entries(next)) rows.set(k, v);
    },
    resetCounters() {
      c.reads = c.inserts = c.deletes = c.transactions = c.probes = 0;
      txs.length = 0;
    },
    writes: () => c.inserts + c.deletes + c.transactions,
  };
}

function unreadableRows(names: readonly string[] = NAMES): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, unreadableValue(name)]));
}

type Outcome = { kind: 'resolved' } | { kind: 'rejected'; error: unknown };
/** Never carries a resolved value: a secret must not reach an assertion message. */
async function settle(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    () => ({ kind: 'resolved' }) as const,
    (error: unknown) => ({ kind: 'rejected', error }) as const,
  );
}

async function expectRefusal(promise: Promise<unknown>, names: readonly string[]) {
  const outcome = await settle(promise);
  expect(outcome.kind).toBe('rejected');
  const error = (outcome as { error: unknown }).error;
  expect(error).toBeInstanceOf(SecretUnreadableError);
  expect([...(error as SecretUnreadableError).secretKeys].sort()).toEqual([...names].sort());
  return error as SecretUnreadableError;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** SHA-256 per row, so an assertion failure prints hashes and never a stored value. */
function snapshot(rows: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...rows].map(([name, value]) => [name, sha(value)]));
}

let keyStub: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  keyA = hex();
  keyB = hex();
  plain.clear();
  vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '');
  vi.stubEnv('NODE_ENV', 'development');
  keyStub = vi.spyOn(configService, 'getEncryptionKey').mockResolvedValue(keyB);
});
afterEach(() => {
  keyStub.mockRestore();
  vi.unstubAllEnvs();
});

/** An initialized service over a table that is healthy (empty) at boot, then holds `next`. */
async function serviceWith(next: Record<string, string>) {
  const fixture = fakeDb();
  const svc = new SecretsService();
  await svc.initialize(fixture.db);
  fixture.set(next);
  fixture.resetCounters();
  return { svc, fixture };
}

describe('an unreadable stored secret is never an absent one', () => {
  it.each(['test', 'development', 'production'])(
    'A1 get and getFresh refuse under NODE_ENV=%s, write nothing and cache nothing',
    async (env) => {
      vi.stubEnv('NODE_ENV', env);
      for (const method of ['get', 'getFresh'] as const) {
        const name = SECRET_KEYS.MASTER_KEK;
        const { svc, fixture } = await serviceWith(unreadableRows([name]));
        const before = snapshot(fixture.rows);
        await expectRefusal(svc[method](name), [name]);
        expect(fixture.writes()).toBe(0);
        const readsAfterFirst = fixture.counts.reads;
        await expectRefusal(svc[method](name), [name]);
        expect(fixture.counts.reads).toBeGreaterThan(readsAfterFirst);
        expect(fixture.writes()).toBe(0);
        expect(snapshot(fixture.rows)).toEqual(before);
      }
    },
  );

  type KekReader = Pick<
    SecretsService,
    'getMasterKek' | 'getJwtSecret' | 'getEmailBlindIndexPepper'
  >;

  async function expectA2(
    svc: KekReader,
    fixture: ReturnType<typeof fakeDb>,
    method: keyof KekReader,
    name: string,
  ) {
    const before = snapshot(fixture.rows);
    await expectRefusal(svc[method](), [name]);
    expect(snapshot(fixture.rows)).toEqual(before);
    expect(fixture.writes()).toBe(0);
  }

  const READERS = [
    ['getMasterKek', SECRET_KEYS.MASTER_KEK],
    ['getJwtSecret', SECRET_KEYS.JWT_SECRET],
    ['getEmailBlindIndexPepper', SECRET_KEYS.EMAIL_BLIND_INDEX_PEPPER],
  ] as const;

  it.each(READERS)(
    'A2 %s refuses on an unreadable row and leaves it byte-identical',
    async (method, name) => {
      const { svc, fixture } = await serviceWith(unreadableRows([name]));
      await expectA2(svc, fixture, method, name);
    },
  );

  it('A2 self-check: the same assertions hold for a hand-built correct double', async () => {
    const { fixture } = await serviceWith(unreadableRows());
    const read = async (name: string) => {
      const row = await fixture.db.query.systemSecrets.findFirst({
        where: eq(schema.systemSecrets.key, name),
        columns: { encryptedValue: true },
      });
      if (!row) throw new Error('unexpected absent row');
      try {
        return decrypt(row.encryptedValue, keyB);
      } catch (cause) {
        throw new SecretUnreadableError('unreadable', [name], { cause });
      }
    };
    const double: KekReader = {
      getMasterKek: () => read(SECRET_KEYS.MASTER_KEK),
      getJwtSecret: () => read(SECRET_KEYS.JWT_SECRET),
      getEmailBlindIndexPepper: () => read(SECRET_KEYS.EMAIL_BLIND_INDEX_PEPPER),
    };
    for (const [method, name] of READERS) await expectA2(double, fixture, method, name);
  });

  it.each([
    ['getMasterKek', SECRET_KEYS.MASTER_KEK, 64],
    ['getJwtSecret', SECRET_KEYS.JWT_SECRET, 128],
    ['getEmailBlindIndexPepper', SECRET_KEYS.EMAIL_BLIND_INDEX_PEPPER, 64],
  ] as const)(
    'A3 %s generates once on an absent row and reads a readable one',
    async (method, name, length) => {
      const { svc, fixture } = await serviceWith({});
      const generated = await svc[method]();
      expect(generated).toMatch(new RegExp(`^[0-9a-f]{${length}}$`));
      expect(fixture.counts.inserts).toBe(1);
      expect(await svc[method]()).toBe(generated);
      expect(fixture.counts.inserts).toBe(1);

      const readable = hex(16);
      fixture.set({ [name]: encrypt(readable, keyB) });
      fixture.resetCounters();
      svc.clearCache();
      expect(await svc[method]()).toBe(readable);
      expect(fixture.writes()).toBe(0);
    },
  );

  it('A4 initialize refuses when every stored row is unreadable, writes nothing and stays uninitialized', async () => {
    const fixture = fakeDb();
    fixture.set(unreadableRows());
    const before = snapshot(fixture.rows);
    const svc = new SecretsService();
    const error = await expectRefusal(svc.initialize(fixture.db), NAMES);
    // The key came from Redis, so the way back names the Redis key to remove.
    expect(error.message).toContain(CONFIG_KEYS.ENCRYPTION_KEY);
    expect(fixture.writes()).toBe(0);
    expect(snapshot(fixture.rows)).toEqual(before);
    await expect(svc.get(SECRET_KEYS.MASTER_KEK)).rejects.toThrow('not initialized');

    fixture.set({ [SECRET_KEYS.MASTER_KEK]: encrypt(hex(16), keyB) });
    await svc.initialize(fixture.db);
    expect(await svc.get(SECRET_KEYS.MASTER_KEK)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('A5 initialize resolves on zero rows', async () => {
    const fixture = fakeDb();
    await new SecretsService().initialize(fixture.db);
    expect(fixture.counts.transactions).toBe(0);
  });

  describe('one readable row among unreadable rows', () => {
    async function mixed() {
      const fixture = fakeDb();
      const readable = hex(16);
      fixture.set({
        ...unreadableRows([SECRET_KEYS.JWT_SECRET, SECRET_KEYS.EMAIL_BLIND_INDEX_PEPPER]),
        [SECRET_KEYS.MASTER_KEK]: encrypt(readable, keyB),
      });
      const svc = new SecretsService();
      return { fixture, svc, readable };
    }

    it('A5 initialize resolves and the readable row reads', async () => {
      const { fixture, svc, readable } = await mixed();
      await svc.initialize(fixture.db);
      expect(await svc.get(SECRET_KEYS.MASTER_KEK)).toBe(readable);
    });

    it('A5 get of an unreadable name refuses', async () => {
      const { fixture, svc } = await mixed();
      await svc.initialize(fixture.db);
      await expectRefusal(svc.get(SECRET_KEYS.JWT_SECRET), [SECRET_KEYS.JWT_SECRET]);
    });
  });
});

describe('the explicit discard override', () => {
  it('A6 discards every unreadable system secret in one audited transaction', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    const fixture = fakeDb();
    fixture.set(unreadableRows());
    const svc = new SecretsService();
    await svc.initialize(fixture.db);
    expect(fixture.counts.transactions).toBe(1);
    expect(fixture.txs[0]!.audits).toHaveLength(1);
    expect(fixture.txs[0]!.audits[0]).toMatchObject({
      actorUserId: NIL_UUID,
      action: 'config.discard_unreadable_secrets',
      targetType: 'system',
      metadata: { discardedSystemSecretCount: 3, keyPresent: true },
    });
    expect(fixture.txs[0]!.deletes).toBe(1);
    expect(fixture.rows.size).toBe(0);
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.some(
          ([fields, message]) =>
            typeof fields === 'object' &&
            fields !== null &&
            Object.values(fields).includes(3) &&
            typeof message === 'string' &&
            message.includes('Discarding unreadable secrets'),
        ),
    ).toBe(true);

    const generated = await svc.getMasterKek();
    expect(fixture.rows.size).toBe(1);
    expect(decrypt(fixture.rows.get(SECRET_KEYS.MASTER_KEK)!, keyB)).toBe(generated);
  });

  it.each(['true', '', '0', '2'])('A6 the setting %j is not the override', async (setting) => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', setting);
    const fixture = fakeDb();
    fixture.set(unreadableRows());
    const before = snapshot(fixture.rows);
    await expectRefusal(new SecretsService().initialize(fixture.db), NAMES);
    expect(fixture.writes()).toBe(0);
    expect(fixture.audits.size).toBe(0);
    expect(snapshot(fixture.rows)).toEqual(before);
  });

  it('A6b a peer that finished first is respected by the transaction re-probe', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    const fixture = fakeDb();
    fixture.set(unreadableRows());
    const peerValue = encrypt(hex(16), keyB);
    fixture.hooks.afterFirstProbe = () => fixture.set({ [SECRET_KEYS.MASTER_KEK]: peerValue });
    await new SecretsService().initialize(fixture.db);
    expect(fixture.audits.size).toBe(0);
    expect(fixture.txs.every((tx) => tx.deletes === 0)).toBe(true);
    // The swap fires on the first probe; before the fix nothing probes and nothing is deleted.
    if (fixture.counts.probes > 0) {
      expect(sha(fixture.rows.get(SECRET_KEYS.MASTER_KEK) ?? '')).toBe(sha(peerValue));
    }
  });
});

describe('the probe', () => {
  it('A7 a probe failure rejects initialize with that error and writes nothing', async () => {
    const fixture = fakeDb();
    fixture.set(unreadableRows());
    const failure = new Error('probe unavailable');
    fixture.hooks.failProbe = failure;
    const before = snapshot(fixture.rows);
    const outcome = await settle(new SecretsService().initialize(fixture.db));
    expect(outcome.kind).toBe('rejected');
    const error = (outcome as { error: Error }).error;
    expect(error).not.toBeInstanceOf(SecretUnreadableError);
    expect(error === failure || error.cause === failure).toBe(true);
    expect(fixture.writes()).toBe(0);
    expect(snapshot(fixture.rows)).toEqual(before);
  });

  it('A9 initialize resolves without reading rows when the system_secrets table does not exist', async () => {
    const fixture = fakeDb();
    const inner = fixture.db.execute.bind(fixture.db);
    const rowReads = vi.fn();
    Object.assign(fixture.db, {
      execute: async (query: SQL) => {
        const text = new PgDialect().sqlToQuery(query).sql.toLowerCase();
        if (text.includes('to_regclass')) return [{ present: false }];
        if (text.includes('encrypted_value')) {
          rowReads();
          throw new Error('relation "system_secrets" does not exist');
        }
        return inner(query);
      },
    });
    await new SecretsService().initialize(fixture.db);
    expect(rowReads).not.toHaveBeenCalled();
  });
});

describe('A8 a refusal discloses neither the ciphertext nor the plaintext', () => {
  function leakChecks(stored: string[], error: unknown) {
    const secrets = [...stored, ...stored.flatMap((s) => s.split(':')), ...plain.values()].filter(
      (s) => s.length >= 8,
    );
    const replacer = (_k: string, v: unknown) =>
      v instanceof Error ? { message: v.message, stack: v.stack, cause: v.cause } : v;
    const texts: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) texts.push(e.message);
    for (const call of [logger.info, logger.warn, logger.error].flatMap(
      (f) => vi.mocked(f).mock.calls,
    ))
      texts.push(JSON.stringify(call, replacer));
    for (const text of texts)
      for (const secret of secrets) expect(text.includes(secret)).toBe(false);
  }

  it.each(['get', 'getFresh'] as const)('%s', async (method) => {
    const name = SECRET_KEYS.MASTER_KEK;
    const { svc, fixture } = await serviceWith(unreadableRows([name]));
    const error = await expectRefusal(svc[method](name), [name]);
    leakChecks([...fixture.rows.values()], error);
  });

  it('getMasterKek', async () => {
    const name = SECRET_KEYS.MASTER_KEK;
    const { svc, fixture } = await serviceWith(unreadableRows([name]));
    const error = await expectRefusal(svc.getMasterKek(), [name]);
    leakChecks([...fixture.rows.values()], error);
  });

  it('initialize on all-unreadable rows', async () => {
    const fixture = fakeDb();
    fixture.set(unreadableRows());
    const error = await expectRefusal(new SecretsService().initialize(fixture.db), NAMES);
    leakChecks([...fixture.rows.values()], error);
  });

  it('initialize with an invalid override setting', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', 'true');
    const fixture = fakeDb();
    fixture.set(unreadableRows());
    const error = await expectRefusal(new SecretsService().initialize(fixture.db), NAMES);
    leakChecks([...fixture.rows.values()], error);
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

const h = vi.hoisted(() => {
  process.env.CONFIG_ENCRYPTION_KEY = 'ab'.repeat(32);
  const warn = vi.fn();
  return {
    db: undefined as unknown,
    getDb: vi.fn(),
    redis: (() => {
      throw new Error('Redis not initialized');
    }) as () => unknown,
    warn,
  };
});

const FIELD_KEY = 'cd'.repeat(32);
const PEPPER = 'ef'.repeat(32);

vi.mock('../src/db.js', () => ({ getDb: h.getDb }));
vi.mock('../src/redis.js', () => ({
  getRedis: () => h.redis(),
  getBullRedis: () => h.redis(),
}));
vi.mock('../src/auth/password.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/auth/password.js')>();
  return {
    hashPassword: vi.fn(real.hashPassword),
    verifyPassword: vi.fn(real.verifyPassword),
  };
});
vi.mock('@haive/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared')>();
  const log: object = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'warn') return h.warn;
        if (prop === 'child') return () => log;
        return () => undefined;
      },
    },
  );
  return {
    ...real,
    logger: log,
    configService: {
      get: async (key: string) => (key === real.CONFIG_KEYS.REGISTRATION_MODE ? reg.mode : null),
      getFresh: async () => null,
      getBoolean: async (_key: string, fallback: boolean) => fallback,
      getEncryptionKey: async () => FIELD_KEY,
    },
  };
});

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { computeEmailBlindIndex, encryptEmail, secretsService } from '@haive/shared';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { createApiApp } from '../src/index.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';
const WRONG = 'definitely not the password';
const PREFIX = 'haive:auth-throttle:';

type Scope = 'login' | 'register';
const acctKey = (scope: Scope, email: string) =>
  `${PREFIX}${scope}:acct:${computeEmailBlindIndex(email, PEPPER)}`;
const ipKey = (scope: Scope, ip: string) => `${PREFIX}${scope}:ip:${ip}`;
const peer = (i: number) => `8.8.${Math.floor(i / 250)}.${(i % 250) + 1}`;
const mail = (tag: string | number) => `user-${tag}@throttle.test`;

let app: ReturnType<typeof createApiApp>;
let passwordHash: string;
let fake: ReturnType<typeof makeFake>;
const reg = { userCount: 1, existing: false, mode: 'closed' as 'closed' | 'open' };

function makeFake() {
  return createFakeDb({
    users: schema.users,
    refreshTokens: schema.refreshTokens,
    auditEvents: schema.auditEvents,
  });
}

function installDb() {
  fake = makeFake();
  const regTx = {
    execute: async () => undefined,
    query: {
      users: { findFirst: async () => (reg.existing ? { id: randomUUID() } : undefined) },
      userInvites: { findFirst: async () => undefined },
    },
    select: () => ({ from: async () => [{ n: reg.userCount }] }),
    insert: (table: any) =>
      table !== schema.users
        ? fake.db.insert(table)
        : {
            values: () => ({
              returning: async () => [
                {
                  id: randomUUID(),
                  role: reg.userCount === 0 ? 'admin' : 'user',
                  status: 'active',
                  tokenVersion: 0,
                  createdAt: new Date(),
                },
              ],
            }),
          },
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  };
  h.db = {
    query: fake.db.query,
    select: fake.db.select,
    insert: fake.db.insert,
    update: fake.db.update,
    delete: fake.db.delete,
    execute: fake.db.execute,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(regTx),
  };
  h.getDb.mockImplementation(() => h.db);
}

function addUser(email: string) {
  fake.insert(schema.users, {
    id: randomUUID(),
    emailEncrypted: encryptEmail(email, FIELD_KEY),
    emailBlindIndex: computeEmailBlindIndex(email, PEPPER),
    passwordHash,
    role: 'user',
    status: 'active',
    tokenVersion: 0,
  });
}

interface Opts {
  peer?: string;
  headers?: Record<string, string>;
}
const post = async (path: string, body: unknown, o: Opts = {}): Promise<Response> =>
  app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...o.headers },
      body: JSON.stringify(body),
    },
    o.peer === undefined ? undefined : { incoming: { socket: { remoteAddress: o.peer } } },
  );
const login = (email: string, password: string, o: Opts = {}) =>
  post('/auth/login', { email, password }, o);
const register = (email: string, o: Opts = {}, password = PASSWORD) =>
  post('/auth/register', { email, password }, o);

interface RefusedBody {
  error: string;
  code: string;
  retryAfterSeconds: number;
}

async function expectRefused(
  send: () => Promise<Response>,
  seconds?: number,
  scope: Scope = 'login',
): Promise<number> {
  const before = fake.rows(schema.auditEvents).length;
  h.getDb.mockClear();
  vi.mocked(verifyPassword).mockClear();
  vi.mocked(hashPassword).mockClear();
  const res = await send();
  expect(res.status).toBe(429);
  const header = res.headers.get('retry-after');
  expect(header).toMatch(/^[1-9][0-9]*$/);
  const body = (await res.json()) as RefusedBody;
  expect(body.code).toBe('rate_limited');
  expect(body.retryAfterSeconds).toBe(Number(header));
  expect(body.error).toContain(String(body.retryAfterSeconds));
  expect(res.headers.get('set-cookie')).toBeNull();
  if (scope === 'register') expect(h.getDb).not.toHaveBeenCalled();
  else {
    const added = fake.rows(schema.auditEvents).slice(before);
    expect(added.length).toBeLessThanOrEqual(1);
    for (const row of added)
      expect(row).toMatchObject({
        action: 'auth.login.throttled',
        metadata: { reason: 'throttled' },
      });
  }
  expect(verifyPassword).not.toHaveBeenCalled();
  expect(hashPassword).not.toHaveBeenCalled();
  if (seconds !== undefined) expect(body.retryAfterSeconds).toBe(seconds);
  return body.retryAfterSeconds;
}

const statuses = async (sends: Promise<Response>[]) =>
  (await Promise.all(sends)).map((r) => r.status);
const count = (list: number[], status: number) => list.filter((s) => s === status).length;

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  passwordHash = await hashPassword(PASSWORD);
  app = createApiApp('http://localhost:3000');
});

beforeEach(() => {
  vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('12'.repeat(32));
  vi.spyOn(secretsService, 'getEmailBlindIndexPepper').mockResolvedValue(PEPPER);
  reg.userCount = 1;
  reg.existing = false;
  reg.mode = 'closed';
  installDb();
  h.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const REDIS_URL = process.env.AUTH_THROTTLE_TEST_REDIS_URL;

describe.skipIf(!REDIS_URL)('auth throttle on a real Redis', () => {
  let client: Redis;
  let T0: number;
  const at = (offsetMs: number) => vi.setSystemTime(T0 + offsetMs);
  const keys = async () => (await client.keys(`${PREFIX}*`)).sort();

  beforeAll(async () => {
    const { Redis: IoRedis } = await import('ioredis');
    client = new IoRedis(REDIS_URL as string);
    await client.ping();
  });

  afterAll(async () => {
    await client.flushdb();
    client.disconnect();
  });

  beforeEach(async () => {
    await client.flushdb();
    h.redis = () => client;
    T0 = Math.floor(Date.now() / 1000) * 1000 + 250;
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
  });

  describe('audit bound', () => {
    const throttled = () =>
      fake.rows(schema.auditEvents).filter((r) => r.action === 'auth.login.throttled');
    it('writes one row and does one lookup for a parallel burst on the rejected account key', async () => {
      const email = mail('audit-account');
      for (let i = 0; i < 10; i++) await login(email, WRONG);
      const lookup = vi.spyOn((h.db as any).query.users, 'findFirst');
      lookup.mockClear();
      const got = await statuses(Array.from({ length: 20 }, () => login(email, WRONG)));
      expect(got).toEqual(Array(20).fill(429));
      expect(throttled()).toHaveLength(1);
      expect(lookup).toHaveBeenCalledTimes(1);
      const gate = `${acctKey('login', email)}:audit`;
      expect(await client.get(gate)).toBe('1');
      expect(await client.pttl(gate)).toBeGreaterThan(0);
      expect(await client.pttl(gate)).toBeLessThanOrEqual(60_000);
      await client.del(gate);
      at(61_000);
      for (let i = 0; i < 10; i++) await login(email, WRONG);
      await expectRefused(() => login(email, WRONG));
      expect(throttled()).toHaveLength(2);
    });
    it('uses the rejected address key even for distinct login identifiers', async () => {
      for (let i = 0; i < 30; i++) await login(mail(`audit-ip-${i}`), WRONG, { peer: peer(1) });
      for (let i = 0; i < 20; i++)
        await expectRefused(() => login(mail(`audit-new-${i}`), WRONG, { peer: peer(1) }));
      expect(throttled()).toHaveLength(1);
      expect(await client.get(`${ipKey('login', peer(1))}:audit`)).toBe('1');
    });
    it('preserves 429 and skips the database when the Redis audit gate fails', async () => {
      const email = mail('audit-gate-error');
      for (let i = 0; i < 10; i++) await login(email, WRONG);
      const set = vi.spyOn(client, 'set').mockRejectedValue(new Error('gate unavailable'));
      h.getDb.mockClear();
      try {
        await expectRefused(() => login(email, WRONG), 60);
        expect(h.getDb).not.toHaveBeenCalled();
        expect(throttled()).toEqual([]);
      } finally {
        set.mockRestore();
      }
    });
    it('preserves 429 when the admitted audit lookup fails', async () => {
      const email = mail('audit-lookup-error');
      for (let i = 0; i < 10; i++) await login(email, WRONG);
      const lookup = vi
        .spyOn((h.db as any).query.users, 'findFirst')
        .mockRejectedValue(new Error('lookup unavailable'));
      try {
        await expectRefused(() => login(email, WRONG), 60);
      } finally {
        lookup.mockRestore();
      }
      expect(throttled()).toEqual([]);
    });
    it('register throttle never opens the database', async () => {
      const email = mail('register-no-db');
      for (let i = 0; i < 10; i++) await register(email);
      await expectRefused(() => register(email), 60, 'register');
    });
  });

  describe('TH-1 per account', () => {
    it('refuses the 11th wrong login for one account, from any address, and keeps counting only admitted ones', async () => {
      const email = mail('victim');
      addUser(email);
      for (let i = 0; i < 10; i++) {
        expect((await login(email, WRONG, { peer: peer(i) })).status).toBe(401);
      }
      await expectRefused(() => login(email, WRONG, { peer: peer(10) }));
      await expectRefused(() => login(email, WRONG, { peer: peer(11) }));
      expect(await client.zcard(acctKey('login', email))).toBe(10);
      expect((await login(mail('other'), WRONG, { peer: peer(0) })).status).toBe(401);
    });
  });

  describe('TH-2 per address', () => {
    it('refuses the 31st attempt from one peer, and only for that peer', async () => {
      for (let i = 0; i < 30; i++) {
        expect((await login(mail(`ip-${i}`), WRONG, { peer: peer(1) })).status).toBe(401);
      }
      await expectRefused(() => login(mail('ip-new'), WRONG, { peer: peer(1) }));
      expect(await client.zcard(ipKey('login', peer(1)))).toBe(30);
      expect((await login(mail('ip-0'), WRONG, { peer: peer(2) })).status).toBe(401);
    });
  });

  describe('TH-3 a success is refunded', () => {
    it('does not count 12 correct logins in a row', async () => {
      const email = mail('good');
      addUser(email);
      for (let i = 0; i < 4; i++) {
        expect((await login(email, WRONG, { peer: peer(3) })).status).toBe(401);
      }
      for (let i = 0; i < 12; i++) {
        expect((await login(email, PASSWORD, { peer: peer(3) })).status).toBe(200);
      }
      expect(await client.zcard(acctKey('login', email))).toBe(4);
      expect(await client.zcard(ipKey('login', peer(3)))).toBe(4);
    });

    it('counts the 9 wrong and the 10th wrong but not the correct one in between, then refuses even the correct password', async () => {
      const email = mail('mixed');
      addUser(email);
      for (let i = 0; i < 9; i++) {
        expect((await login(email, WRONG, { peer: peer(i) })).status).toBe(401);
      }
      expect((await login(email, PASSWORD, { peer: peer(9) })).status).toBe(200);
      expect((await login(email, WRONG, { peer: peer(10) })).status).toBe(401);
      expect(await client.zcard(acctKey('login', email))).toBe(10);
      await expectRefused(() => login(email, PASSWORD, { peer: peer(11) }));
    });
  });

  describe('TH-4 sliding window', () => {
    it('admits again once the window has slid past the refused attempt', async () => {
      const email = mail('slide');
      for (let i = 0; i < 10; i++) await login(email, WRONG, { peer: peer(i) });
      await expectRefused(() => login(email, WRONG, { peer: peer(10) }), 60);
      at(61_000);
      expect((await login(email, WRONG, { peer: peer(10) })).status).toBe(401);
    });

    it('answers Retry-After as the seconds until the oldest counted attempt leaves the window, never below 1', async () => {
      const email = mail('retry');
      for (let i = 0; i < 5; i++) await login(email, WRONG, { peer: peer(i) });
      at(10_000);
      for (let i = 5; i < 10; i++) await login(email, WRONG, { peer: peer(i) });
      at(30_250);
      await expectRefused(
        () => login(email, WRONG, { peer: peer(20) }),
        Math.ceil((T0 + 60_000 - (T0 + 30_250)) / 1000),
      );
      at(59_999);
      await expectRefused(() => login(email, WRONG, { peer: peer(21) }), 1);
      expect(await client.zcard(acctKey('login', email))).toBe(10);
      at(60_001);
      expect((await login(email, WRONG, { peer: peer(22) })).status).toBe(401);
      expect((await login(email, WRONG, { peer: peer(23) })).status).toBe(401);
    });

    it('answers the larger wait when the account bucket is the slower one', async () => {
      const email = mail('both-a');
      for (let i = 0; i < 20; i++) await login(mail(`fill-a-${i}`), WRONG, { peer: peer(1) });
      at(20_000);
      for (let i = 0; i < 10; i++) await login(email, WRONG, { peer: peer(1) });
      at(30_000);
      const ipWait = Math.ceil((T0 + 60_000 - (T0 + 30_000)) / 1000);
      const acctWait = Math.ceil((T0 + 20_000 + 60_000 - (T0 + 30_000)) / 1000);
      expect(acctWait).toBeGreaterThan(ipWait);
      await expectRefused(() => login(email, WRONG, { peer: peer(1) }), acctWait);
    });

    it('answers the larger wait when the address bucket is the slower one', async () => {
      const email = mail('both-b');
      for (let i = 0; i < 10; i++) await login(email, WRONG, { peer: peer(30 + i) });
      at(20_000);
      for (let i = 0; i < 30; i++) await login(mail(`fill-b-${i}`), WRONG, { peer: peer(2) });
      at(30_000);
      const acctWait = Math.ceil((T0 + 60_000 - (T0 + 30_000)) / 1000);
      const ipWait = Math.ceil((T0 + 20_000 + 60_000 - (T0 + 30_000)) / 1000);
      expect(ipWait).toBeGreaterThan(acctWait);
      await expectRefused(() => login(email, WRONG, { peer: peer(2) }), ipWait);
    });
  });

  describe('TH-5 concurrency', () => {
    it('admits exactly 10 of 25 parallel wrong logins for one account', async () => {
      const email = mail('race');
      addUser(email);
      const got = await statuses(
        Array.from({ length: 25 }, (_, i) => login(email, WRONG, { peer: peer(i) })),
      );
      expect(count(got, 401)).toBe(10);
      expect(count(got, 429)).toBe(15);
      expect(await client.zcard(acctKey('login', email))).toBe(10);
    });

    it('admits exactly 30 of 40 parallel wrong logins from one peer with distinct emails', async () => {
      const got = await statuses(
        Array.from({ length: 40 }, (_, i) => login(mail(`par-${i}`), WRONG, { peer: peer(5) })),
      );
      expect(count(got, 401)).toBe(30);
      expect(count(got, 429)).toBe(10);
      expect(await client.zcard(ipKey('login', peer(5)))).toBe(30);
    });
  });

  describe('TH-6 registration', () => {
    it('keeps a separate budget from login, and counts 403 and 409 refusals', async () => {
      const email = mail('reg');
      reg.userCount = 1;
      for (let i = 0; i < 3; i++)
        expect((await register(email, { peer: peer(i) })).status).toBe(403);
      reg.existing = true;
      // A known email is also refused by the closed gate, and those attempts still count.
      for (let i = 3; i < 5; i++)
        expect((await register(email, { peer: peer(i) })).status).toBe(403);
      expect(await client.zcard(acctKey('register', email))).toBe(5);
      expect(await client.zcard(ipKey('register', peer(3)))).toBe(1);
      // Only an admitted request reaches the duplicate-email check.
      reg.mode = 'open';
      for (let i = 5; i < 10; i++)
        expect((await register(email, { peer: peer(i) })).status).toBe(409);
      reg.existing = false;
      await expectRefused(() => register(email, { peer: peer(10) }), undefined, 'register');
      expect(await client.zcard(acctKey('register', email))).toBe(10);
      expect((await login(email, WRONG, { peer: peer(11) })).status).toBe(401);
      expect(await client.zcard(acctKey('login', email))).toBe(1);
    });

    it('refunds a created account', async () => {
      const email = mail('reg-ok');
      for (let i = 0; i < 3; i++) {
        expect((await register(email, { peer: peer(6) })).status).toBe(403);
      }
      reg.userCount = 0;
      for (let i = 0; i < 12; i++) {
        expect((await register(email, { peer: peer(6) })).status).toBe(201);
      }
      expect(await client.zcard(acctKey('register', email))).toBe(3);
      expect(await client.zcard(ipKey('register', peer(6)))).toBe(3);
    });

    it('rejects an invalid body before the throttle and counts nothing', async () => {
      const email = mail('reg-bad');
      for (let i = 0; i < 12; i++) {
        expect((await register(email, { peer: peer(7) }, 'short')).status).toBe(400);
      }
      expect(await keys()).toEqual([]);
      expect((await register(email, { peer: peer(7) })).status).toBe(403);
      expect(await keys()).toEqual([acctKey('register', email), ipKey('register', peer(7))].sort());
      expect(await client.zcard(acctKey('register', email))).toBe(1);
    });

    it('rejects an invalid login body before the throttle and counts nothing', async () => {
      for (let i = 0; i < 12; i++) {
        expect((await login('not-an-email', WRONG, { peer: peer(7) })).status).toBe(400);
      }
      expect(await keys()).toEqual([]);
      const email = mail('login-bad');
      expect((await login(email, WRONG, { peer: peer(7) })).status).toBe(401);
      expect(await keys()).toEqual([acctKey('login', email), ipKey('login', peer(7))].sort());
      expect(await client.zcard(ipKey('login', peer(7)))).toBe(1);
    });
  });

  describe('TH-7 client address', () => {
    it('ignores X-Forwarded-For when no proxy is trusted', async () => {
      for (let i = 0; i < 30; i++) {
        const res = await login(mail(`xff-${i}`), WRONG, {
          peer: peer(8),
          headers: { 'x-forwarded-for': `93.184.216.${i + 1}` },
        });
        expect(res.status).toBe(401);
      }
      await expectRefused(() =>
        login(mail('xff-31'), WRONG, {
          peer: peer(8),
          headers: { 'x-forwarded-for': '93.184.216.99' },
        }),
      );
      expect(await client.zcard(ipKey('login', peer(8)))).toBe(30);
      expect(await client.exists(ipKey('login', '93.184.216.1'))).toBe(0);
    });

    it('reads the right-most untrusted hop when the peer is a trusted proxy', async () => {
      vi.stubEnv('HAIVE_TRUSTED_PROXIES', '10.0.0.0/8,192.0.2.1');
      await login(mail('t1'), WRONG, {
        peer: '10.1.2.3',
        headers: { 'x-forwarded-for': '93.184.216.9, 10.9.9.9' },
      });
      await login(mail('t2'), WRONG, {
        peer: '10.1.2.3',
        headers: { 'x-forwarded-for': '1.1.1.1, 93.184.216.9, 10.9.9.9' },
      });
      await login(mail('t3'), WRONG, {
        peer: '192.0.2.1',
        headers: { 'x-forwarded-for': '93.184.216.7' },
      });
      expect(await client.zcard(ipKey('login', '93.184.216.9'))).toBe(2);
      expect(await client.zcard(ipKey('login', '93.184.216.7'))).toBe(1);
      expect(await client.exists(ipKey('login', '1.1.1.1'))).toBe(0);
      expect(await client.exists(ipKey('login', '10.1.2.3'))).toBe(0);
    });

    it('falls back to the peer for an unparsable chain, and ignores the header from an untrusted peer', async () => {
      vi.stubEnv('HAIVE_TRUSTED_PROXIES', '10.0.0.0/8,192.0.2.1');
      await login(mail('u1'), WRONG, { peer: '10.1.2.3', headers: { 'x-forwarded-for': 'bogus' } });
      await login(mail('u2'), WRONG, {
        peer: '93.184.217.4',
        headers: { 'x-forwarded-for': '93.184.216.50' },
      });
      expect(await client.exists(ipKey('login', '10.1.2.3'))).toBe(0);
      expect(await client.zcard(ipKey('login', '93.184.217.4'))).toBe(1);
      expect(await client.exists(ipKey('login', '93.184.216.50'))).toBe(0);
    });

    it('reads the trusted list on every request', async () => {
      await login(mail('r1'), WRONG, {
        peer: '10.1.2.3',
        headers: { 'x-forwarded-for': '93.184.216.9' },
      });
      vi.stubEnv('HAIVE_TRUSTED_PROXIES', '10.0.0.0/8');
      await login(mail('r2'), WRONG, {
        peer: '10.1.2.3',
        headers: { 'x-forwarded-for': '93.184.216.9' },
      });
      expect(await client.exists(ipKey('login', '10.1.2.3'))).toBe(0);
      expect(await client.zcard(ipKey('login', '93.184.216.9'))).toBe(1);
    });

    it('shares one bucket between an IPv4-mapped peer and the plain address', async () => {
      await login(mail('m1'), WRONG, { peer: '::ffff:8.8.4.4' });
      await login(mail('m2'), WRONG, { peer: '8.8.4.4' });
      await login(mail('m3'), WRONG, { peer: '::ffff:808:404' });
      expect(await client.zcard(ipKey('login', '8.8.4.4'))).toBe(3);
    });

    it('buckets IPv6 peers by their /64', async () => {
      await login(mail('v1'), WRONG, { peer: '2606:4700:1:2:aaaa::1' });
      await login(mail('v2'), WRONG, { peer: '2606:4700:1:2:bbbb::2' });
      await login(mail('v3'), WRONG, { peer: '2606:4700:1:3::1' });
      expect(await client.zcard(ipKey('login', '2606:4700:1:2'))).toBe(2);
      expect(await client.zcard(ipKey('login', '2606:4700:1:3'))).toBe(1);
    });

    it('applies only the account bucket when no address can be determined', async () => {
      const email = mail('noenv');
      for (let i = 0; i < 10; i++) expect((await login(email, WRONG)).status).toBe(401);
      await expectRefused(() => login(email, WRONG));
      await expectRefused(async () =>
        app.request(
          '/auth/login',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, password: WRONG }),
          },
          { incoming: { socket: {} } },
        ),
      );
      expect(await keys()).toEqual(
        [acctKey('login', email), `${acctKey('login', email)}:audit`].sort(),
      );
    });
  });

  describe('TH-13 a private peer shares no address bucket', () => {
    const BRIDGE = '172.20.0.1';
    const PUBLIC_PEER = '8.8.4.4';

    it('A1 admits 31 failures for different accounts from one private peer, and still limits one account', async () => {
      for (let i = 0; i < 31; i++) {
        expect((await login(mail(`br-${i}`), WRONG, { peer: BRIDGE })).status).toBe(401);
      }
      expect(await client.exists(ipKey('login', BRIDGE))).toBe(0);
      const email = mail('br-one');
      for (let i = 0; i < 10; i++) {
        expect((await login(email, WRONG, { peer: BRIDGE })).status).toBe(401);
      }
      await expectRefused(() => login(email, WRONG, { peer: BRIDGE }));
    });

    it('A1 treats the IPv4-mapped hex form of a private peer the same way', async () => {
      for (let i = 0; i < 31; i++) {
        expect((await login(mail(`bh-${i}`), WRONG, { peer: '::ffff:ac14:1' })).status).toBe(401);
      }
      expect(await keys()).not.toContain(ipKey('login', BRIDGE));
    });

    it('A1 skips the bucket for loopback, link-local and a unique-local peer', async () => {
      for (const [n, p] of ['127.0.0.1', '169.254.1.1', 'fd00::1', 'fe80::1'].entries()) {
        for (let i = 0; i < 31; i++) {
          expect((await login(mail(`pp${n}-${i}`), WRONG, { peer: p })).status).toBe(401);
        }
      }
    });

    it('A2 keeps the 30 per minute bucket for a public peer', async () => {
      for (let i = 0; i < 30; i++) {
        expect((await login(mail(`pub-${i}`), WRONG, { peer: PUBLIC_PEER })).status).toBe(401);
      }
      await expectRefused(() => login(mail('pub-31'), WRONG, { peer: PUBLIC_PEER }));
      expect(await client.zcard(ipKey('login', PUBLIC_PEER))).toBe(30);
    });

    it('A3 counts a private address a trusted proxy supplied, per address', async () => {
      vi.stubEnv('HAIVE_TRUSTED_PROXIES', '172.20.0.0/16');
      const headers = { 'x-forwarded-for': '10.5.5.5' };
      for (let i = 0; i < 30; i++) {
        expect((await login(mail(`px-${i}`), WRONG, { peer: BRIDGE, headers })).status).toBe(401);
      }
      await expectRefused(() => login(mail('px-31'), WRONG, { peer: BRIDGE, headers }));
      expect(await client.zcard(ipKey('login', '10.5.5.5'))).toBe(30);
      const other = { 'x-forwarded-for': '10.5.5.6' };
      expect((await login(mail('px-other'), WRONG, { peer: BRIDGE, headers: other })).status).toBe(
        401,
      );
    });
  });

  describe('TH-8 keys', () => {
    it('writes one account and one address key per scope, expiring, with unique members', async () => {
      const email = mail('keys');
      await login(email, WRONG, { peer: peer(9) });
      await register(email, { peer: peer(9) });
      expect(await keys()).toEqual(
        [
          acctKey('login', email),
          ipKey('login', peer(9)),
          acctKey('register', email),
          ipKey('register', peer(9)),
        ].sort(),
      );
      for (const key of await keys()) {
        expect(await client.type(key)).toBe('zset');
        const ttl = await client.pttl(key);
        expect(ttl).toBeGreaterThanOrEqual(1);
        expect(ttl).toBeLessThanOrEqual(60_000);
      }
      expect(await client.zcard(acctKey('login', email))).toBe(1);
      expect(await client.zcard(acctKey('register', email))).toBe(1);
    });

    it('leaves one member per attempt even when two arrive in the same millisecond', async () => {
      const email = mail('members');
      await Promise.all([
        login(email, WRONG, { peer: peer(9) }),
        login(email, WRONG, { peer: peer(9) }),
      ]);
      expect(await client.zcard(acctKey('login', email))).toBe(2);
      expect(await client.zcard(ipKey('login', peer(9)))).toBe(2);
      expect(new Set(await client.zrange(acctKey('login', email), '0', '-1')).size).toBe(2);
    });
  });

  describe('TH-11 a stalled Redis', () => {
    it('does not keep the slot an admitted attempt takes once the stall ends', async () => {
      const email = mail('stall');
      addUser(email);
      const { Redis: IoRedis } = await import('ioredis');
      const pauser = new IoRedis(REDIS_URL as string);
      try {
        await pauser.call('CLIENT', 'PAUSE', '1000', 'WRITE');
        const got = await statuses(
          Array.from({ length: 3 }, () => login(email, PASSWORD, { peer: peer(1) })),
        );
        expect(got).toEqual([200, 200, 200]);
        await new Promise((resolve) => setTimeout(resolve, 1800));
        expect(await client.zcard(acctKey('login', email))).toBe(0);
        expect(await client.zcard(ipKey('login', peer(1)))).toBe(0);
      } finally {
        pauser.disconnect();
      }
    });
  });

  describe('TH-12 a skewed clock', () => {
    it('never answers a wait longer than the window', async () => {
      const email = mail('skew');
      const key = acctKey('login', email);
      for (let i = 0; i < 10; i++) await client.zadd(key, T0 + 600_000 + i, `future-${i}`);
      await client.pexpire(key, 60_000);
      const seconds = await expectRefused(() => login(email, WRONG, { peer: peer(1) }));
      expect(seconds).toBeLessThanOrEqual(60);
    });
  });
});

describe('TH-9 the throttle fails open', () => {
  type Mode = [string, () => unknown];
  const stub = (status: string, command: (name: string) => Promise<unknown>) =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'status') return status;
          if (prop === 'then') return undefined;
          return (..._args: unknown[]) => command(String(prop));
        },
      },
    );
  const never = () => new Promise<unknown>(() => undefined);
  const modes: Mode[] = [
    [
      'getRedis throws',
      () => {
        throw new Error('Redis not initialized');
      },
    ],
    ['the client is not ready', () => stub('end', async () => 0)],
    ['a command rejects', () => stub('ready', async () => Promise.reject(new Error('boom')))],
    ['a command never answers', () => stub('ready', never)],
  ];

  const settle = async <T>(p: Promise<T>): Promise<T> => {
    let done = false;
    void p.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 4000 && !done; i++) {
      await vi.advanceTimersByTimeAsync(50);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return p;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    addUser(mail('open'));
  });

  describe.each(modes)('%s', (_name, redis) => {
    beforeEach(() => {
      h.redis = redis as () => unknown;
    });

    it('answers a wrong password with 401 and a correct one with 200', async () => {
      expect((await settle(login(mail('open'), WRONG, { peer: peer(1) }))).status).toBe(401);
      expect((await settle(login(mail('open'), PASSWORD, { peer: peer(1) }))).status).toBe(200);
    });

    it('lets a registration through', async () => {
      reg.userCount = 0;
      expect((await settle(register(mail('open-reg'), { peer: peer(1) }))).status).toBe(201);
    });

    it('logs exactly one warning for the failed throttle call of a refused password', async () => {
      await settle(login(mail('open'), WRONG, { peer: peer(1) }));
      expect(h.warn).toHaveBeenCalledTimes(1);
    });
  });

  it('does not let a reply that arrives after the timeout change an admitted request', async () => {
    h.redis = () =>
      stub(
        'ready',
        () => new Promise((resolve) => setTimeout(() => resolve([0, 59_000, 'late']), 3_000)),
      );
    const res = await settle(login(mail('open'), WRONG, { peer: peer(1) }));
    expect(res.status).toBe(401);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(res.status).toBe(401);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });
});

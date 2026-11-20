import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { isLockNotAvailable } from '@haive/database';
import { audits, cleanActor, createDatabase, KEK, makeActor, schema } from './security-audit-db.js';

const url = process.env.CLI_SECRETS_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/cli_secrets_audit_test'))
  throw new Error('Use a dedicated cli_secrets_audit_test database');
const h = vi.hoisted(() => ({
  db: undefined as any,
  actor: '',
  add: vi.fn(),
  poll: vi.fn(),
  insert: vi.fn(),
  log: vi.fn(),
  exchange: vi.fn(),
  stash: '',
  loseAt: undefined as number | undefined,
  checks: 0,
}));
vi.mock('@haive/database', async (original) => {
  const real = await original<any>();
  return {
    ...real,
    tryCliAuthLock: async (...args: any[]) => {
      const lock = await real.tryCliAuthLock(...args);
      if (!lock || typeof h.loseAt !== 'number') return lock;
      return Object.assign(() => lock(), lock, {
        assertHeld: async () => {
          h.checks += 1;
          if (h.checks >= h.loseAt!) throw new real.CliAuthLockLostError();
          await lock.assertHeld();
        },
      });
    },
  };
});
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/audit.js', async (original) => {
  const real = await original<any>();
  return {
    ...real,
    insertAuditEvent: async (db: any, event: any, options?: { id?: string }) => {
      h.insert(event);
      return real.insertAuditEvent(db, event, options);
    },
    logAuditEvent: (event: any) => {
      h.log(event);
      real.logAuditEvent(event);
    },
  };
});
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: any, next: any) => {
    c.set('userId', h.actor);
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({
  getUsagePollQueue: () => ({ add: h.poll }),
  getCliExecQueue: () => ({ add: h.add }),
}));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ eval: async () => h.stash }) }));
vi.mock('@haive/shared/claude-oauth', async (original) => ({
  ...(await original<any>()),
  exchangeClaudeAuthCode: h.exchange,
}));
import {
  configService,
  envelopeDecrypt,
  secretsService,
  upsertProviderSecret,
} from '@haive/shared';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { deleteUsageGrantFromSet, writeUsageGrantToSet } from '../src/lib/usage-grant-set.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { HttpError, type AppEnv } from '../src/context.js';

const rnd = () => randomBytes(16).toString('hex');
const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
const USAGE = 'CLAUDE_USAGE_OAUTH';
const OTHER = 'ANTHROPIC_AUTH_TOKEN';
const SET_ACTION = 'cli_provider.secret.set';
const DELETE_ACTION = 'cli_provider.secret.delete';
type Row = typeof schema.cliProviders.$inferSelect;
type Key = 'A' | 'B' | 'C' | 'H' | 'D' | 'E' | 'F' | 'G';
/** The login set of A: every claude-code subscription row of the user that is not isolated. */
const SET: Key[] = ['A', 'B', 'C', 'H'];
const HOLDERS: Key[] = ['A', 'B', 'C'];
const OUTSIDE: Key[] = ['D', 'E', 'F', 'G'];
const ALL: Key[] = [...SET, ...OUTSIDE];
const grant = () =>
  JSON.stringify({
    accessToken: rnd(),
    refreshToken: rnd(),
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:profile'],
  });

describe.skipIf(!url)('every writer of the Claude usage connection covers the login set', () => {
  let db: ReturnType<typeof createDatabase>;
  let U: string;
  let V: string;
  let rows: Record<Key, Row>;
  const app = new Hono<AppEnv>().onError(errorHandler).route('/cli-providers', cliProviderRoutes);
  const idsOf = (keys: Key[]) => keys.map((k) => rows[k].id);
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`/cli-providers${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const postUsage = (id: string, value: string) =>
    call('POST', `/${id}/secrets`, { secretName: USAGE, value });
  const delUsage = (id: string) => call('DELETE', `/${id}/secrets/${USAGE}`);
  const disconnect = (id: string) => call('DELETE', `/${id}/usage-auth`);
  const freshTokens = () => JSON.parse(grant()) as Record<string, unknown>;
  const connect = async (id: string) => {
    const tokens = freshTokens();
    h.exchange.mockResolvedValue(tokens);
    const res = await call('POST', `/${id}/usage-auth/complete`, { code: 'code#state' });
    return { res, tokens };
  };
  const createBody = (token: string | null, extra: object = {}) => ({
    name: 'claude-code',
    label: `new-${rnd()}`,
    authMode: 'subscription',
    isolateAuth: false,
    envVars: token ? { [TOKEN]: token } : { KEEP: 'new' },
    ...extra,
  });
  const provider = (id: string) =>
    db.query.cliProviders.findFirst({ where: eq(schema.cliProviders.id, id) }).then((r) => r!);
  const findNew = (label: string) =>
    db.query.cliProviders
      .findFirst({
        where: and(eq(schema.cliProviders.userId, U), eq(schema.cliProviders.label, label)),
      })
      .then((r) => r!);
  const secretRows = (pids: string[]) =>
    db
      .select()
      .from(schema.cliProviderSecrets)
      .where(inArray(schema.cliProviderSecrets.providerId, pids))
      .orderBy(asc(schema.cliProviderSecrets.id));
  /** The usage grants of `pids` as stored, the update stamp through text so no precision is cut. */
  const usageCopies = (pids: string[]) =>
    db
      .select({
        providerId: schema.cliProviderSecrets.providerId,
        encryptedValue: schema.cliProviderSecrets.encryptedValue,
        encryptedDek: schema.cliProviderSecrets.encryptedDek,
        fingerprint: schema.cliProviderSecrets.fingerprint,
        at: sql<string>`${schema.cliProviderSecrets.updatedAt}::text`,
      })
      .from(schema.cliProviderSecrets)
      .where(
        and(
          inArray(schema.cliProviderSecrets.providerId, pids),
          eq(schema.cliProviderSecrets.secretName, USAGE),
        ),
      )
      .orderBy(asc(schema.cliProviderSecrets.providerId));
  const noOwner = <T extends { providerId: string }>(c: T) => ({ ...c, providerId: '' });
  const snapshotRows = (pids: string[]) =>
    db
      .select()
      .from(schema.usageWindowSnapshots)
      .where(inArray(schema.usageWindowSnapshots.providerId, pids))
      .orderBy(asc(schema.usageWindowSnapshots.providerId));
  const plain = async (id: string, name: string) => {
    const [s] = (await secretRows([id])).filter((r) => r.secretName === name);
    return s && envelopeDecrypt(s, KEK);
  };
  const byAction = async (action: string) =>
    (await audits(db)).filter((a) => a.actorUserId === U && a.action === action);
  const usageEvents = async (action: string) =>
    (await byAction(action)).filter((a) => (a.metadata as any)?.secretName === USAGE);
  const health = (p: Row) => [p.authGeneration, p.authStatus, p.authMessage, p.authLastCheckedAt];
  const snapshot = async (pids: string[]) => ({
    providers: await Promise.all(pids.map(provider)),
    secrets: await secretRows(pids),
    usage: await snapshotRows(pids),
    audits: (await audits(db)).filter((a) => pids.includes(a.targetId!)),
  });
  const outside = (keys: Key[]) => snapshot(idsOf(keys));
  const world = async () => ({
    providers: await db
      .select()
      .from(schema.cliProviders)
      .where(inArray(schema.cliProviders.userId, [U, V]))
      .orderBy(asc(schema.cliProviders.id)),
    secrets: await secretRows(idsOf(ALL)),
    usage: await snapshotRows(idsOf(ALL)),
    audits: (await audits(db)).filter(
      (a) => a.actorUserId === U || idsOf(ALL).includes(a.targetId!),
    ),
  });
  const others = async (keys: Key[]) =>
    (await secretRows(idsOf(keys))).filter((s) => s.secretName !== USAGE);
  const shape = (a: { targetId: string | null; action: string; metadata: unknown }) => ({
    actorUserId: U,
    action: a.action,
    targetType: 'cli_provider',
    targetId: a.targetId,
    metadata: a.metadata,
  });
  const expectSpies = (events: Parameters<typeof shape>[0][]) => {
    for (const spy of [h.insert, h.log])
      for (const e of events) expect(spy.mock.calls.map((c) => c[0])).toContainEqual(shape(e));
  };

  /** Every member holds the one grant, and one new generation shared by all differs from each old one. */
  const expectGrantEverywhere = async (members: Key[], expected: unknown) => {
    const copies = await usageCopies(idsOf(members));
    expect(copies).toHaveLength(members.length);
    for (const c of copies) expect(noOwner(c)).toEqual(noOwner(copies[0]!));
    for (const m of members)
      expect(JSON.parse((await plain(rows[m].id, USAGE))!), m).toEqual(expected);
    const gens = new Set<string>();
    for (const m of members) {
      const p = await provider(rows[m].id);
      gens.add(p.authGeneration);
      expect(p.authGeneration, m).not.toBe(rows[m].authGeneration);
    }
    expect(gens.size).toBe(1);
  };
  /** One event per row in `members`: the clicked row's plain one, a sibling's with `via` and `setSize`. */
  const expectUsageEvents = async (
    action: string,
    source: string,
    via: Key,
    members: Key[],
    setSize: number,
  ) => {
    const events = await usageEvents(action);
    expect(events.map((e) => e.targetId).sort()).toEqual(idsOf(members).sort());
    for (const e of events)
      expect(e.metadata, e.targetId!).toEqual(
        e.targetId === rows[via].id
          ? { source, secretName: USAGE }
          : { source, secretName: USAGE, viaProviderId: rows[via].id, setSize },
      );
    expectSpies(events);
  };
  const expectNoUsageEvents = async () => {
    expect(await usageEvents(SET_ACTION)).toEqual([]);
    expect(await usageEvents(DELETE_ACTION)).toEqual([]);
  };
  /** `id` holds the copy of the grant of `from`, ciphertext and stamp included, and one join event says so. */
  const expectSeeded = async (id: string, from: Key, setSize: number) => {
    const [mine] = await usageCopies([id]);
    const [src] = await usageCopies([rows[from].id]);
    expect(mine).toBeDefined();
    expect(noOwner(mine!)).toEqual(noOwner(src!));
    const joins = (await usageEvents(SET_ACTION)).filter((a) => a.targetId === id);
    expect(joins.map((a) => a.metadata)).toEqual([
      { source: 'join', secretName: USAGE, viaProviderId: rows[from].id, setSize },
    ]);
    expect((await usageEvents(SET_ACTION)).length).toBe(1);
    expectSpies(joins);
    expect(h.poll).toHaveBeenCalledTimes(1);
    expect(h.poll.mock.calls[0]![0]).toBe('usage-poll-tick');
  };
  const expectNotSeeded = async (id: string) => {
    expect(await usageCopies([id])).toEqual([]);
    expect(await usageEvents(SET_ACTION)).toEqual([]);
    expect(h.poll).not.toHaveBeenCalled();
  };
  const dropGrants = (keys: Key[]) =>
    db
      .delete(schema.cliProviderSecrets)
      .where(
        and(
          inArray(schema.cliProviderSecrets.providerId, idsOf(keys)),
          eq(schema.cliProviderSecrets.secretName, USAGE),
        ),
      );
  const stampGrant = (key: Key, at: Date) =>
    db
      .update(schema.cliProviderSecrets)
      .set({ updatedAt: at })
      .where(
        and(
          eq(schema.cliProviderSecrets.providerId, rows[key].id),
          eq(schema.cliProviderSecrets.secretName, USAGE),
        ),
      );
  /** Dates the grants of A, B and C and returns the member whose copy a joiner must take: never the
   *  smallest id, and in a tie the smallest id of the newest. Outside the set every grant is newer still. */
  const ageHolders = async (mode: 'newest' | 'tie') => {
    const [h0, h1, h2] = [...HOLDERS].sort((x, y) => (rows[x].id < rows[y].id ? -1 : 1)) as [
      Key,
      Key,
      Key,
    ];
    await stampGrant(h0, new Date('2021-01-01T00:00:00Z'));
    await stampGrant(h1, new Date('2024-01-01T00:00:00Z'));
    await stampGrant(
      h2,
      new Date(mode === 'tie' ? '2024-01-01T00:00:00Z' : '2022-01-01T00:00:00Z'),
    );
    return h1;
  };
  const trigger = async (body: string) => {
    const fn = `usage_set_${rnd()}`;
    await db.execute(
      sql.raw(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`,
      ),
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER ${fn} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
      ),
    );
    return async () => {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON audit_events`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
    };
  };
  const refuseAuditOf = (key: Key) =>
    trigger(
      `IF NEW.target_id = '${rows[key].id}'::uuid THEN RAISE EXCEPTION 'audit insert refused'; END IF;`,
    );
  const refuseSiblingAudit = () => refuseAuditOf('B');
  const refuseUsageAudit = (source: 'join' | 'leave') =>
    trigger(
      `IF NEW.metadata ->> 'source' = '${source}' AND NEW.metadata ->> 'secretName' = '${USAGE}' THEN RAISE EXCEPTION 'audit insert refused'; END IF;`,
    );
  const refuseUsageJoinAudit = () => refuseUsageAudit('join');
  const refuseUsageLeaveAudit = () => refuseUsageAudit('leave');

  beforeAll(() => {
    db = createDatabase(url!);
    h.db = db;
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  const setup = async () => {
    h.loseAt = undefined;
    h.checks = 0;
    h.insert.mockClear();
    h.log.mockClear();
    h.poll.mockReset().mockResolvedValue(undefined);
    h.add.mockReset().mockResolvedValue({ id: 'job-id' });
    h.exchange.mockReset();
    h.stash = JSON.stringify({ verifier: rnd(), state: 'state' });
    vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    U = (await makeActor(db)).id;
    V = (await makeActor(db)).id;
    h.actor = U;
    const spec = {
      A: [U, 'claude-code', 'subscription', false, true],
      B: [U, 'claude-code', 'subscription', false, true],
      C: [U, 'claude-code', 'subscription', false, false],
      H: [U, 'claude-code', 'subscription', false, true],
      D: [U, 'claude-code', 'subscription', true, true],
      E: [U, 'claude-code', 'api_key', false, true],
      F: [V, 'claude-code', 'subscription', false, true],
      G: [U, 'codex', 'subscription', false, true],
    } as const;
    const made: any = {};
    for (const [key, [userId, name, authMode, isolateAuth, enabled]] of Object.entries(spec)) {
      const [row] = await db
        .insert(schema.cliProviders)
        .values({ userId, name, authMode, isolateAuth, enabled, label: key })
        .returning();
      made[key] = row;
      const names = [
        ...(key !== 'H' ? [USAGE] : []),
        ...(key === 'A' || key === 'B' ? [TOKEN] : []),
        ...(['A', 'B', 'D', 'E'].includes(key) ? [OTHER] : []),
      ];
      for (const secret of names)
        await upsertProviderSecret(db, {
          providerId: row!.id,
          name: secret,
          value: secret === USAGE ? grant() : rnd(),
          masterKek: KEK,
          onExisting: 'overwrite',
        });
      await db.insert(schema.usageWindowSnapshots).values({
        providerId: row!.id,
        userId,
        providerName: name,
        status: 'ok',
        fiveHourPct: 10,
      });
    }
    rows = made;
    for (const key of OUTSIDE) await stampGrant(key, new Date('2030-01-01T00:00:00Z'));
  };
  beforeEach(setup);
  const teardown = async () => {
    await cleanActor(db, U);
    await cleanActor(db, V);
  };
  afterEach(async () => {
    h.loseAt = undefined;
    await teardown();
    vi.restoreAllMocks();
  });

  describe('Connect', () => {
    it('writes the exchanged grant to every row of the set and bumps one shared generation', async () => {
      const before = await outside(OUTSIDE);
      const keep = await others(SET);
      let seenAtTick: number | undefined;
      h.poll.mockImplementation(async () => {
        seenAtTick = (await usageCopies(idsOf(SET))).length;
      });
      const { res, tokens } = await connect(rows.A.id);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(String(tokens.accessToken));
      await expectGrantEverywhere(SET, tokens);
      expect(await others(SET)).toEqual(keep);
      await expectUsageEvents(SET_ACTION, 'usage_oauth', 'A', SET, 4);
      expect(await outside(OUTSIDE)).toEqual(before);
      expect(h.poll).toHaveBeenCalledTimes(1);
      expect(seenAtTick).toBe(4);
    });

    it.each([
      ['an isolated row', 'D'],
      ['an API-key row', 'E'],
    ] as [string, Key][])('through %s writes and bumps that row only', async (_n, key) => {
      const rest = ALL.filter((k) => k !== key);
      const before = await outside(rest);
      const { res, tokens } = await connect(rows[key].id);
      expect(res.status).toBe(200);
      await expectGrantEverywhere([key], tokens);
      await expectUsageEvents(SET_ACTION, 'usage_oauth', key, [key], 1);
      expect(await outside(rest)).toEqual(before);
    });
  });

  describe('Disconnect', () => {
    it('deletes the grant and the usage snapshot of every row of the set without touching generations', async () => {
      const before = await outside(OUTSIDE);
      const healthBefore = (await Promise.all(idsOf(SET).map(provider))).map(health);
      const keep = await others(SET);
      expect((await disconnect(rows.A.id)).status).toBe(200);
      expect(await usageCopies(idsOf(SET))).toEqual([]);
      expect(await snapshotRows(idsOf(SET))).toEqual([]);
      expect((await Promise.all(idsOf(SET).map(provider))).map(health)).toEqual(healthBefore);
      expect(await others(SET)).toEqual(keep);
      await expectUsageEvents(DELETE_ACTION, 'usage_oauth', 'A', HOLDERS, 4);
      expect(await outside(OUTSIDE)).toEqual(before);
    });

    it('through an isolated row deletes that row only', async () => {
      const rest = ALL.filter((k) => k !== 'D');
      const before = await outside(rest);
      expect((await disconnect(rows.D.id)).status).toBe(200);
      expect(await usageCopies([rows.D.id])).toEqual([]);
      expect(await snapshotRows([rows.D.id])).toEqual([]);
      await expectUsageEvents(DELETE_ACTION, 'usage_oauth', 'D', ['D'], 1);
      expect(await outside(rest)).toEqual(before);
    });

    it('answers 200 and writes no audit when no row of the set holds a grant', async () => {
      await dropGrants(SET);
      const before = await outside(OUTSIDE);
      const res = await disconnect(rows.A.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ connected: false });
      await expectNoUsageEvents();
      expect(await outside(OUTSIDE)).toEqual(before);
    });
  });

  describe('a manual write of the grant', () => {
    it('through a row of the set writes every row and reports each', async () => {
      const before = await outside(OUTSIDE);
      const value = grant();
      const res = await postUsage(rows.B.id, value);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(JSON.parse(value).accessToken);
      await expectGrantEverywhere(SET, JSON.parse(value));
      await expectUsageEvents(SET_ACTION, 'manual', 'B', SET, 4);
      expect(await outside(OUTSIDE)).toEqual(before);
    });

    it.each([
      ['an isolated row', 'D'],
      ['an API-key row', 'E'],
    ] as [string, Key][])('through %s writes that row only', async (_n, key) => {
      const rest = ALL.filter((k) => k !== key);
      const before = await outside(rest);
      const value = grant();
      expect((await postUsage(rows[key].id, value)).status).toBe(200);
      await expectGrantEverywhere([key], JSON.parse(value));
      await expectUsageEvents(SET_ACTION, 'manual', key, [key], 1);
      expect(await outside(rest)).toEqual(before);
    });

    // The value variants are unit tests of isUsageGrantValue; this one proves the route's refusal.
    it('refuses a value that is not a usage grant and writes nothing', async () => {
      const value = JSON.stringify({ ...JSON.parse(grant()), accessToken: '' });
      const before = await world();
      const res = await postUsage(rows.B.id, value);
      expect(res.status).toBe(400);
      const body = await res.text();
      for (const part of [value, ...Object.values(JSON.parse(value))])
        if (typeof part === 'string' && part) expect(body).not.toContain(part);
      expect(await world()).toEqual(before);
      expect(h.poll).not.toHaveBeenCalled();
    });
  });

  describe('a manual delete of the grant', () => {
    it('through a row of the set removes it, with the usage snapshot, from every row that holds it', async () => {
      const before = await outside(OUTSIDE);
      const healthBefore = (await Promise.all(idsOf(SET).map(provider))).map(health);
      expect((await delUsage(rows.B.id)).status).toBe(200);
      expect(await usageCopies(idsOf(SET))).toEqual([]);
      // The same rule as Disconnect: the snapshot of H goes too, though H held no grant and gets no audit.
      expect(await snapshotRows(idsOf(SET))).toEqual([]);
      expect((await Promise.all(idsOf(SET).map(provider))).map(health)).toEqual(healthBefore);
      await expectUsageEvents(DELETE_ACTION, 'manual', 'B', HOLDERS, 4);
      expect(await outside(OUTSIDE)).toEqual(before);
      const events = (await audits(db)).filter((a) => a.actorUserId === U).length;
      expect((await delUsage(rows.B.id)).status).toBe(404);
      expect((await audits(db)).filter((a) => a.actorUserId === U).length).toBe(events);
    });

    it('deletes through a row that holds none when a sibling does', async () => {
      const before = await outside(OUTSIDE);
      expect((await delUsage(rows.H.id)).status).toBe(200);
      expect(await usageCopies(idsOf(SET))).toEqual([]);
      await expectUsageEvents(DELETE_ACTION, 'manual', 'H', HOLDERS, 4);
      expect(await outside(OUTSIDE)).toEqual(before);
    });

    it('through an isolated row removes that row only', async () => {
      const rest = ALL.filter((k) => k !== 'D');
      const before = await outside(rest);
      expect((await delUsage(rows.D.id)).status).toBe(200);
      expect(await usageCopies([rows.D.id])).toEqual([]);
      expect(await snapshotRows([rows.D.id])).toEqual([]);
      await expectUsageEvents(DELETE_ACTION, 'manual', 'D', ['D'], 1);
      expect(await outside(rest)).toEqual(before);
    });
  });

  it('reports the connection per row', async () => {
    const connected = async (key: Key) =>
      ((await (await call('GET', `/${rows[key].id}/usage-auth`)).json()) as { connected: boolean })
        .connected;
    expect(await connected('B')).toBe(true);
    expect(await connected('H')).toBe(false);
  });

  it('refuses to disconnect a non-Claude row and leaves the usage snapshots of its set alone', async () => {
    const [second] = await db
      .insert(schema.cliProviders)
      .values({
        userId: U,
        name: 'codex',
        authMode: 'subscription',
        isolateAuth: false,
        enabled: true,
        label: 'G2',
      })
      .returning();
    await db.insert(schema.usageWindowSnapshots).values({
      providerId: second!.id,
      userId: U,
      providerName: 'codex',
      status: 'ok',
      fiveHourPct: 20,
    });
    const pids = [rows.G.id, second!.id];
    const before = await snapshotRows(pids);
    expect(before).toHaveLength(2);
    const audited = (await audits(db)).length;
    const res = await disconnect(rows.G.id);
    expect(res.status).toBe(400);
    expect(await snapshotRows(pids)).toEqual(before);
    expect((await audits(db)).length).toBe(audited);
    expect(h.poll).not.toHaveBeenCalled();
  });

  it('refuses a manual grant whose expiry is not a finite number and writes nothing', async () => {
    const value = `{"accessToken":"${rnd()}","refreshToken":"${rnd()}","expiresAt":1e999,"scopes":["user:profile"]}`;
    expect(JSON.parse(value).expiresAt).toBe(Infinity);
    const before = await world();
    const res = await postUsage(rows.B.id, value);
    expect(res.status).toBe(400);
    expect(await world()).toEqual(before);
    expect(h.poll).not.toHaveBeenCalled();
  });

  describe('a writer called with a set that does not hold the clicked row', () => {
    const refused = async (run: (tx: any) => Promise<unknown>) => {
      const before = await world();
      const error = await db.transaction(run).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(409);
      expect((error as HttpError).code).toBe('cli_auth_busy');
      expect(await world()).toEqual(before);
    };
    it('writeUsageGrantToSet is refused and writes nothing', async () => {
      await refused((tx) =>
        writeUsageGrantToSet(tx, {
          userId: U,
          viaId: rows.A.id,
          members: [{ id: rows.B.id }, { id: rows.C.id }],
          source: 'manual',
          value: grant(),
          masterKek: KEK,
          assertHeld: async () => {},
        }),
      );
    });
    it('deleteUsageGrantFromSet is refused and deletes nothing', async () => {
      await refused((tx) =>
        deleteUsageGrantFromSet(tx, {
          userId: U,
          viaId: rows.A.id,
          members: [{ id: rows.B.id }, { id: rows.C.id }],
          source: 'manual',
          assertHeld: async () => {},
        }),
      );
    });
  });

  describe.each([
    ['another row of the set', 'A', 'B', SET],
    ['a set of one', 'D', 'D', ['D']],
  ] as [string, Key, Key, Key[]][])(
    'when a write for %s fails',
    (_label, via, refused, members) => {
      const ids = () => idsOf(members);
      const written = async (seeded: { encryptedValue: string }[]) => {
        const copies = await usageCopies(ids());
        expect(copies).toHaveLength(members.length);
        expect(new Set(copies.map((c) => c.encryptedValue)).size).toBe(1);
        // A grant that is not one the fixture seeded.
        for (const c of copies)
          expect(seeded.map((x) => x.encryptedValue)).not.toContain(c.encryptedValue);
      };
      const gone = async (_seeded: unknown[]) => expect(await usageCopies(ids())).toEqual([]);
      const writers: [
        string,
        () => Response | Promise<Response>,
        (seeded: { encryptedValue: string }[]) => Promise<void>,
        number,
      ][] = [
        // One check before the set lock, one per member before its write, one after the last write.
        ['Connect', async () => (await connect(rows[via].id)).res, written, members.length + 2],
        ['a manual write', () => postUsage(rows[via].id, grant()), written, members.length + 2],
        // One check before the set lock and one after the delete.
        ['Disconnect', () => disconnect(rows[via].id), gone, 2],
        ['a manual delete', () => delUsage(rows[via].id), gone, 2],
      ];

      it.each(writers)('%s is refused when an audit insert is refused', async (_n, run) => {
        const before = await world();
        const drop = await refuseAuditOf(refused);
        try {
          expect((await run()).status).toBeGreaterThanOrEqual(400);
        } finally {
          await drop();
        }
        expect(await world()).toEqual(before);
        expect(h.poll).not.toHaveBeenCalled();
      });

      it.each(writers)(
        '%s is refused and changes nothing at every lost-lock check',
        async (_n, run, done, expected) => {
          const seeded = await usageCopies(ids());
          h.loseAt = Infinity;
          h.checks = 0;
          expect((await run()).status).toBeLessThan(300);
          await done(seeded);
          const max = h.checks;
          expect(max).toBeGreaterThanOrEqual(2);
          expect(max).toBe(expected);
          for (let k = 1; k <= max; k++) {
            await teardown();
            await setup();
            const before = await world();
            h.loseAt = k;
            h.checks = 0;
            const res = await run();
            h.loseAt = undefined;
            expect(res.status, `check ${k}`).toBe(409);
            expect(((await res.json()) as { code?: string }).code, `check ${k}`).toBe(
              'cli_auth_busy',
            );
            expect(await world(), `check ${k}`).toEqual(before);
            await expectNoUsageEvents();
            expect(h.poll, `check ${k}`).not.toHaveBeenCalled();
          }
        },
      );
    },
  );

  describe('the set lock comes first, beside an id-ordered lock holder', () => {
    // Rows share a prefix and differ in the last digits: X < R1 < R2 < R3. The image job locks provider rows in id
    // order without the auth lock, so a writer holding one row while it waits for a lower id could deadlock with it.
    let peer: ReturnType<typeof createDatabase>;
    beforeAll(() => {
      peer = createDatabase(url!);
    });
    afterAll(async () => {
      await peer.$client.end({ timeout: 5 });
    });

    const seedW = async () => {
      const W = (await makeActor(db)).id;
      const base = randomUUID().slice(0, -4);
      const ids = { X: `${base}0001`, R1: `${base}0002`, R2: `${base}0003`, R3: `${base}0004` };
      for (const key of ['R3', 'R1', 'X', 'R2'] as const)
        await db.insert(schema.cliProviders).values({
          id: ids[key],
          userId: W,
          name: 'claude-code',
          authMode: 'subscription',
          isolateAuth: key === 'X',
          label: key,
        });
      for (const key of ['R1', 'R2'] as const) {
        await upsertProviderSecret(db, {
          providerId: ids[key],
          name: USAGE,
          value: grant(),
          masterKek: KEK,
          onExisting: 'overwrite',
        });
        await db.insert(schema.usageWindowSnapshots).values({
          providerId: ids[key],
          userId: W,
          providerName: 'claude-code',
          status: 'ok',
        });
      }
      h.actor = W;
      return { W, ids };
    };
    const backendPid = async (tx: { execute: typeof db.execute }) => {
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      return row!.pid;
    };
    /** Whether some backend waits for a lock the backend `pid` holds. */
    const blockedBy = async (pid: number) => {
      const [row] = await db.execute<{ blocked: boolean }>(sql`
        select exists (
          select 1 from pg_stat_activity
          where wait_event_type = 'Lock' and ${pid}::int = any (pg_blocking_pids(pid))
        ) as blocked`);
      return row?.blocked === true;
    };
    /** The rows of `ids` that someone holds right now. FOR UPDATE, since only it conflicts with a KEY SHARE. */
    const rowsHeld = async (ids: string[]) => {
      const held: string[] = [];
      for (const id of ids)
        await db
          .transaction((tx) =>
            tx.execute(sql`select id from cli_providers where id = ${id} for update nowait`),
          )
          .catch((error: unknown) => {
            if (!isLockNotAvailable(error)) throw error;
            held.push(id);
          });
      return held;
    };
    /** Starts `run` while a second connection holds `heldId`. `waited` says whether the request ended up
     *  waiting for the peer; `held` the rows of `probeIds` it holds while it does. The peer is always released. */
    const besideHolder = async (
      heldId: string,
      probeIds: string[],
      run: () => Response | Promise<Response>,
    ) => {
      let holds!: () => void;
      const holding = new Promise<void>((resolve) => (holds = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let pid = 0;
      const peerRun = peer.transaction(async (tx) => {
        pid = await backendPid(tx);
        await tx.execute(sql`select id from cli_providers where id = ${heldId} for update`);
        holds();
        await released;
      });
      await Promise.race([holding, peerRun]);
      let response: Promise<Response> | undefined;
      let held: string[] = [];
      let waited = false;
      try {
        response = Promise.resolve(run());
        let settled = false;
        void response.then(
          () => (settled = true),
          () => (settled = true),
        );
        // A wait on database state, the exception the testing guide allows; the deadline is kept small.
        const deadline = Date.now() + 5000;
        while (!settled && !waited && Date.now() < deadline) {
          waited = await blockedBy(pid);
          if (!waited) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (waited) held = await rowsHeld(probeIds);
      } finally {
        release();
        await peerRun;
        await response?.catch(() => undefined);
      }
      return { held, waited, res: await response! };
    };
    const finish = async (W: string, body: () => Promise<void>) => {
      try {
        await body();
      } finally {
        h.actor = U;
        await cleanActor(db, W);
      }
    };
    const copiesOf = (ids: string[]) => usageCopies(ids);

    const lockFirst = (
      name: string,
      run: (ids: Record<string, string>) => Response | Promise<Response>,
      check: (ids: Record<string, string>, res: Response) => Promise<void>,
    ) =>
      it(`${name} waits for a lower-id holder without holding a higher id`, async () => {
        const { W, ids } = await seedW();
        await finish(W, async () => {
          const xBefore = await copiesOf([ids.X]);
          const { held, waited, res } = await besideHolder(ids.R1, [ids.R2, ids.R3], () =>
            run(ids),
          );
          expect(waited).toBe(true);
          expect(held).toEqual([]);
          expect(res.status).toBeLessThan(300);
          await check(ids, res);
          expect(await copiesOf([ids.X])).toEqual(xBefore);
        });
      });

    lockFirst(
      'Connect through the highest id',
      async (ids) => (await connect(ids.R3!)).res,
      async (ids) => {
        const copies = await copiesOf([ids.R1!, ids.R2!, ids.R3!]);
        expect(copies).toHaveLength(3);
        expect(new Set(copies.map((c) => c.encryptedValue)).size).toBe(1);
      },
    );
    lockFirst(
      'a manual write through the highest id',
      (ids) => postUsage(ids.R3!, grant()),
      async (ids) => {
        const copies = await copiesOf([ids.R1!, ids.R2!, ids.R3!]);
        expect(copies).toHaveLength(3);
        expect(new Set(copies.map((c) => c.encryptedValue)).size).toBe(1);
      },
    );
    lockFirst(
      'Disconnect through the highest id',
      (ids) => disconnect(ids.R3!),
      async (ids) => expect(await copiesOf([ids.R1!, ids.R2!, ids.R3!])).toEqual([]),
    );
    lockFirst(
      'a manual delete through the highest id',
      (ids) => delUsage(ids.R3!),
      async (ids) => expect(await copiesOf([ids.R1!, ids.R2!, ids.R3!])).toEqual([]),
    );
  });

  describe('a row that joins the set takes the newest grant of the set', () => {
    it.each(['newest', 'tie'] as const)(
      'a created row without a typed token takes the copy of the member with the %s grant',
      async (mode) => {
        const from = await ageHolders(mode);
        const before = await outside([...SET, ...OUTSIDE]);
        const body = createBody(null);
        const res = await call('POST', '', body);
        expect(res.status).toBe(201);
        const created = await findNew(body.label);
        await expectSeeded(created.id, from, 5);
        expect(await outside([...SET, ...OUTSIDE])).toEqual(before);
      },
    );

    it('a created row that types the login token also takes the newest grant of the set', async () => {
      const from = await ageHolders('newest');
      const token = rnd();
      const body = createBody(token);
      const res = await call('POST', '', body);
      expect(res.status).toBe(201);
      const created = await findNew(body.label);
      expect(await plain(created.id, TOKEN)).toBe(token);
      await expectSeeded(created.id, from, 5);
    });

    it.each([
      ['without a typed token', null],
      ['with a typed token', rnd()],
    ] as [string, string | null][])(
      'a created row %s is refused entirely when the audit of its seed is refused',
      async (_n, token) => {
        await ageHolders('newest');
        const before = await world();
        const drop = await refuseUsageJoinAudit();
        try {
          expect((await call('POST', '', createBody(token))).status).toBeGreaterThanOrEqual(400);
        } finally {
          await drop();
        }
        expect(await world()).toEqual(before);
        expect(h.poll).not.toHaveBeenCalled();
      },
    );

    it('a settings save that joins is refused entirely when the audit of its usage seed is refused', async () => {
      await ageHolders('newest');
      const before = await world();
      const drop = await refuseUsageJoinAudit();
      try {
        expect(
          (await call('PATCH', `/${rows.D.id}`, { isolateAuth: false })).status,
        ).toBeGreaterThanOrEqual(400);
      } finally {
        await drop();
      }
      expect(await world()).toEqual(before);
      expect(h.poll).not.toHaveBeenCalled();
    });

    it('a settings save that leaves is refused entirely when the audit of its usage leave is refused', async () => {
      const before = await world();
      const drop = await refuseUsageLeaveAudit();
      try {
        expect(
          (await call('PATCH', `/${rows.A.id}`, { isolateAuth: true })).status,
        ).toBeGreaterThanOrEqual(400);
      } finally {
        await drop();
      }
      expect(await world()).toEqual(before);
      expect(h.poll).not.toHaveBeenCalled();
    });

    it('a clone that joins leaves no row behind when the audit of its usage seed is refused', async () => {
      await ageHolders('newest');
      const before = await world();
      const drop = await refuseUsageJoinAudit();
      try {
        expect((await call('POST', `/${rows.A.id}/clone`)).status).toBeGreaterThanOrEqual(400);
      } finally {
        await drop();
      }
      expect(await world()).toEqual(before);
      expect(h.poll).not.toHaveBeenCalled();
    });

    it.each([
      ['isolated', { isolateAuth: true }],
      ['API-key', { authMode: 'api_key' }],
      ['codex', { name: 'codex' }],
    ] as [string, object][])(
      'a created %s row is not seeded and ticks nothing',
      async (_n, extra) => {
        await ageHolders('newest');
        const body = createBody(null, extra);
        expect((await call('POST', '', body)).status).toBe(201);
        await expectNotSeeded((await findNew(body.label)).id);
      },
    );

    it('a created row is not seeded and ticks nothing when the set holds no grant', async () => {
      await dropGrants(SET);
      const body = createBody(null);
      expect((await call('POST', '', body)).status).toBe(201);
      await expectNotSeeded((await findNew(body.label)).id);
    });

    it('a clone of a member takes the newest grant of the set, not the copy of its source', async () => {
      await stampGrant('A', new Date('2021-01-01T00:00:00Z'));
      await stampGrant('B', new Date('2024-01-01T00:00:00Z'));
      await stampGrant('C', new Date('2022-01-01T00:00:00Z'));
      const before = await outside([...SET, ...OUTSIDE]);
      const res = await call('POST', `/${rows.A.id}/clone`);
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { provider: { id: string } }).provider.id;
      await expectSeeded(id, 'B', 5);
      expect(await outside([...SET, ...OUTSIDE])).toEqual(before);
    });

    it('a clone of an isolated subscription row gets no grant but its other secrets', async () => {
      const res = await call('POST', `/${rows.D.id}/clone`);
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { provider: { id: string } }).provider.id;
      await expectNotSeeded(id);
      expect((await plain(id, OTHER)) === (await plain(rows.D.id, OTHER))).toBe(true);
    });

    it('a clone of an API-key row copies every secret as before', async () => {
      const res = await call('POST', `/${rows.E.id}/clone`);
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { provider: { id: string } }).provider.id;
      for (const name of [USAGE, OTHER])
        expect((await plain(id, name)) === (await plain(rows.E.id, name)), name).toBe(true);
      expect(await usageEvents(SET_ACTION)).toEqual([]);
      expect(h.poll).not.toHaveBeenCalled();
    });

    it.each([
      ['isolation turned off', 'D', { isolateAuth: false }],
      ['the auth mode moved to subscription', 'E', { authMode: 'subscription' }],
    ] as [string, Key, object][])(
      'a settings save with %s replaces the grant of the row with the newest of the set',
      async (_n, key, change) => {
        const from = await ageHolders('newest');
        const own = await plain(rows[key].id, USAGE);
        const rest = ALL.filter((k) => k !== key);
        const before = await outside(rest);
        expect((await call('PATCH', `/${rows[key].id}`, change)).status).toBe(200);
        expect((await plain(rows[key].id, USAGE)) === own).toBe(false);
        await expectSeeded(rows[key].id, from, 5);
        // Moving scope also drops the row's own old grant: one leave event, and no other delete event.
        const left = await usageEvents(DELETE_ACTION);
        expect(left.map((e) => [e.targetId, e.metadata])).toEqual([
          [rows[key].id, { source: 'leave', secretName: USAGE }],
        ]);
        expectSpies(left);
        expect(await outside(rest)).toEqual(before);
      },
    );

    it.each([
      ['isolation turned off', 'D', { isolateAuth: false }],
      ['the auth mode moved to subscription', 'E', { authMode: 'subscription' }],
    ] as [string, Key, object][])(
      'a settings save with %s into a set without a grant leaves the row with none',
      async (_n, key, change) => {
        await dropGrants(SET);
        const rest = ALL.filter((k) => k !== key);
        const before = await outside(rest);
        expect((await call('PATCH', `/${rows[key].id}`, change)).status).toBe(200);
        expect(await usageCopies([rows[key].id])).toEqual([]);
        expect(await snapshotRows([rows[key].id])).toEqual([]);
        const left = await usageEvents(DELETE_ACTION);
        expect(left.map((e) => [e.targetId, e.metadata])).toEqual([
          [rows[key].id, { source: 'leave', secretName: USAGE }],
        ]);
        expectSpies(left);
        expect(await usageEvents(SET_ACTION)).toEqual([]);
        expect(h.poll).not.toHaveBeenCalled();
        expect(await outside(rest)).toEqual(before);
      },
    );

    it('a settings save that keeps the row in its set seeds nothing', async () => {
      await ageHolders('newest');
      const before = await world();
      const res = await call('PATCH', `/${rows.A.id}`, {
        label: `kept-${rnd()}`,
        authMode: 'subscription',
        isolateAuth: false,
      });
      expect(res.status).toBe(200);
      const after = await world();
      expect(after.secrets).toEqual(before.secrets);
      expect(after.usage).toEqual(before.usage);
      await expectNoUsageEvents();
      expect(h.poll).not.toHaveBeenCalled();
    });

    it.each([
      ['isolation turned on', 'A', { isolateAuth: true }],
      ['the auth mode moved to API key', 'B', { authMode: 'api_key' }],
    ] as [string, Key, object][])(
      'a settings save with %s drops the grant and usage snapshot of the leaving row only',
      async (_n, key, change) => {
        const rest = ALL.filter((k) => k !== key);
        const before = await outside(rest);
        expect((await call('PATCH', `/${rows[key].id}`, change)).status).toBe(200);
        expect(await usageCopies([rows[key].id])).toEqual([]);
        expect(await snapshotRows([rows[key].id])).toEqual([]);
        const events = await usageEvents(DELETE_ACTION);
        expect(events.map((e) => [e.targetId, e.metadata])).toEqual([
          [rows[key].id, { source: 'leave', secretName: USAGE }],
        ]);
        expectSpies(events);
        expect(await usageEvents(SET_ACTION)).toEqual([]);
        expect(await outside(rest)).toEqual(before);
      },
    );

    it('a settings save that joins and types the login token still takes the grant from the set', async () => {
      const from = await ageHolders('newest');
      const token = rnd();
      const res = await call('PATCH', `/${rows.D.id}`, {
        isolateAuth: false,
        envVars: { [TOKEN]: token },
      });
      expect(res.status).toBe(200);
      expect(await plain(rows.D.id, TOKEN)).toBe(token);
      await expectSeeded(rows.D.id, from, 5);
    });

    it('a settings save that joins and types an env entry named like the grant keeps it as plaintext', async () => {
      // B holds the newest login and the newest grant, so any seed names the same member.
      await stampGrant('A', new Date('2021-01-01T00:00:00Z'));
      await stampGrant('B', new Date('2024-01-01T00:00:00Z'));
      await stampGrant('C', new Date('2022-01-01T00:00:00Z'));
      for (const [key, at] of [
        ['A', '2020-01-01T00:00:00Z'],
        ['B', '2024-01-01T00:00:00Z'],
      ] as const)
        await db
          .update(schema.cliProviderSecrets)
          .set({ updatedAt: new Date(at) })
          .where(
            and(
              eq(schema.cliProviderSecrets.providerId, rows[key].id),
              eq(schema.cliProviderSecrets.secretName, TOKEN),
            ),
          );
      const typed = rnd();
      const res = await call('PATCH', `/${rows.D.id}`, {
        isolateAuth: false,
        envVars: { [USAGE]: typed },
      });
      expect(res.status).toBe(200);
      const d = await provider(rows.D.id);
      expect(d.envVars).toEqual({ [USAGE]: typed });
      expect(d.authGeneration).toBe(rows.B.authGeneration);
      await expectSeeded(rows.D.id, 'B', 5);
    });
  });

  describe.each([
    ['a created row that joins the set', 201, () => call('POST', '', createBody(null))],
    ['a clone of a member', 201, () => call('POST', `/${rows.A.id}/clone`)],
    [
      'a settings save that joins',
      200,
      () => call('PATCH', `/${rows.D.id}`, { isolateAuth: false }),
    ],
    [
      'a settings save that leaves',
      200,
      () => call('PATCH', `/${rows.A.id}`, { isolateAuth: true }),
    ],
  ] as [string, number, () => Promise<Response>][])(
    'when %s loses the auth lock',
    (_n, ok, run) => {
      it('is refused and changes nothing at every lost-lock check', async () => {
        h.loseAt = Infinity;
        h.checks = 0;
        expect((await run()).status).toBe(ok);
        const max = h.checks;
        expect(max).toBeGreaterThanOrEqual(2);
        for (let k = 1; k <= max; k++) {
          await teardown();
          await setup();
          const before = await world();
          h.loseAt = k;
          h.checks = 0;
          const res = await run();
          h.loseAt = undefined;
          expect(res.status, `check ${k}`).toBe(409);
          expect(((await res.json()) as { code?: string }).code, `check ${k}`).toBe(
            'cli_auth_busy',
          );
          expect(await world(), `check ${k}`).toEqual(before);
          await expectNoUsageEvents();
          expect(h.poll, `check ${k}`).not.toHaveBeenCalled();
        }
      });
    },
  );

  it('keeps every token out of responses, audit rows, audit calls and error text', async () => {
    const seen: string[] = [];
    const keep = async (res: Response) => void seen.push(await res.text());
    const values = [grant(), grant(), grant()];
    const connected = await connect(rows.A.id);
    await keep(connected.res);
    const parts = [
      ...values.flatMap((v) => [v, JSON.parse(v).accessToken, JSON.parse(v).refreshToken]),
      String(connected.tokens.accessToken),
      String(connected.tokens.refreshToken),
    ] as string[];
    await keep(await postUsage(rows.B.id, values[0]!));
    await keep(await disconnect(rows.A.id));
    await keep(await postUsage(rows.B.id, values[1]!));
    await keep(await delUsage(rows.B.id));
    const drop = await refuseSiblingAudit();
    try {
      await keep(await postUsage(rows.A.id, values[2]!));
    } finally {
      await drop();
    }
    seen.push(
      JSON.stringify(await audits(db)),
      JSON.stringify([h.insert.mock.calls, h.log.mock.calls]),
    );
    for (const text of seen) for (const part of parts) expect(text).not.toContain(part);
  });
});

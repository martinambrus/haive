import { inspect } from 'node:util';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { createDatabase, schema, tryCliAuthLock } from '@haive/database';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
import {
  computeKeyFingerprint,
  configService,
  envelopeDecrypt,
  envelopeEncrypt,
  secretsService,
} from '@haive/shared';

const logs = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@haive/shared', async (original) => {
  const actual = await original<typeof import('@haive/shared')>();
  const stub: Record<string, unknown> = { level: 'info', isLevelEnabled: () => true };
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    stub[level] = (...args: unknown[]) => void logs.calls.push(args);
  stub.child = () => stub;
  return { ...actual, logger: Object.assign(Object.create(actual.logger), { child: () => stub }) };
});
import { pickGrantHolder } from '../src/usage-window/usage-grant-set.js';
import { runUsagePollTick } from '../src/queues/usage-poll-queue.js';
import { handleSignOutJob } from '../src/queues/cli-exec/handlers.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

const url = process.env.USAGE_SET_POLL_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/cli_secrets_audit_test'))
  throw new Error('Use a dedicated test database');
const KEK = 'ab'.repeat(32);
const MIN = 60_000;
const HOUR = 60 * MIN;
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const SECRET = 'CLAUDE_USAGE_OAUTH';
const rnd = () => randomBytes(16).toString('hex');
type Row = typeof schema.cliProviders.$inferSelect;
type Key = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';
type Grant = { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] };
type GrantOptions = { expired?: boolean; live?: boolean; refreshable?: boolean };

// Every token any test below creates, and everything the tests leave behind to be read.
const allTokens = new Set<string>();
const leftBehind: string[] = [];

/** The vendor boundary: the token and usage endpoints behind the global fetch. */
function makeVendor() {
  const v = {
    tokenCalls: [] as string[],
    usageCalls: [] as string[],
    live: new Set<string>(),
    refreshable: new Set<string>(),
    status: new Map<string, number>(),
    issuedStatus: undefined as undefined | number,
    tokenFailure: undefined as undefined | number | Error,
    onUsage: undefined as undefined | ((token: string) => Promise<void>),
    callsWith: (token: string) => v.usageCalls.filter((t) => t === token).length,
    reset() {
      v.tokenCalls.length = 0;
      v.usageCalls.length = 0;
    },
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (target === TOKEN_URL) {
        const spent = new URLSearchParams(String(init?.body)).get('refresh_token') ?? '';
        v.tokenCalls.push(spent);
        if (v.tokenFailure instanceof Error) throw v.tokenFailure;
        if (v.tokenFailure)
          return Response.json({ error: 'temporarily_unavailable' }, { status: v.tokenFailure });
        if (!v.refreshable.delete(spent))
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const issued = { access: rnd(), refresh: rnd() };
        v.live.add(issued.access);
        if (v.issuedStatus) v.status.set(issued.access, v.issuedStatus);
        v.refreshable.add(issued.refresh);
        allTokens.add(issued.access).add(issued.refresh);
        return Response.json({
          access_token: issued.access,
          refresh_token: issued.refresh,
          expires_in: 28800,
          scope: 'user:profile user:inference',
        });
      }
      if (target === USAGE_URL) {
        const token = (new Headers(init?.headers).get('authorization') ?? '').replace(
          /^Bearer /,
          '',
        );
        v.usageCalls.push(token);
        await v.onUsage?.(token);
        const status = v.status.get(token) ?? (v.live.has(token) ? 200 : 401);
        if (status !== 200) return new Response('{}', { status });
        const resets = new Date(Date.now() + 3 * HOUR).toISOString();
        return Response.json({
          five_hour: { utilization: 12, resets_at: resets },
          seven_day: { utilization: 3, resets_at: resets },
        });
      }
      throw new Error(`unexpected request to ${target}`);
    },
  };
  return v;
}

let clock = Date.now();

describe.skipIf(!url)('the usage poller treats one login set as one usage connection', () => {
  let db: ReturnType<typeof createDatabase>;
  let vendor: ReturnType<typeof makeVendor>;
  let U: string;
  let V: string;
  let rows: Record<Key, Row>;
  let dGrant: Grant;

  const step = (ms: number) => {
    clock += ms;
    vi.setSystemTime(clock);
  };
  const tick = () => runUsagePollTick(db);
  const mkGrant = (o: GrantOptions = {}): Grant => {
    const g = {
      accessToken: rnd(),
      refreshToken: rnd(),
      expiresAt: clock + (o.expired ? -HOUR : 8 * HOUR),
      scopes: ['user:profile'],
    };
    allTokens.add(g.accessToken).add(g.refreshToken);
    if (o.live ?? true) vendor.live.add(g.accessToken);
    if (o.refreshable ?? true) vendor.refreshable.add(g.refreshToken);
    return g;
  };
  /** One encrypted grant inserted as an identical copy into every named row. */
  const store = async (g: Grant, keys: Key[], stamp = new Date(clock - 2 * HOUR)) => {
    const json = JSON.stringify(g);
    const env = envelopeEncrypt(json, KEK);
    for (const k of keys)
      await db.insert(schema.cliProviderSecrets).values({
        providerId: rows[k].id,
        secretName: SECRET,
        encryptedValue: env.encryptedValue,
        encryptedDek: env.encryptedDek,
        fingerprint: computeKeyFingerprint(json),
        createdAt: stamp,
        updatedAt: stamp,
      });
  };
  const seed = (
    key: Key,
    status: 'ok' | 'error' | 'needs_reconnect',
    fetchedAt = new Date(clock - HOUR),
  ) =>
    db.insert(schema.usageWindowSnapshots).values({
      providerId: rows[key].id,
      userId: rows[key].userId,
      providerName: rows[key].name,
      status,
      errorMessage: status === 'ok' ? null : 'earlier failure',
      fiveHourPct: 5,
      fetchedAt,
    });
  const pids = (keys: Key[]) => keys.map((k) => rows[k].id);
  const secretsOf = (keys: Key[]) =>
    db
      .select()
      .from(schema.cliProviderSecrets)
      .where(inArray(schema.cliProviderSecrets.providerId, pids(keys)))
      .orderBy(asc(schema.cliProviderSecrets.id));
  const snapshotsOf = (keys: Key[]) =>
    db
      .select()
      .from(schema.usageWindowSnapshots)
      .where(inArray(schema.usageWindowSnapshots.providerId, pids(keys)))
      .orderBy(asc(schema.usageWindowSnapshots.id));
  const dump = async (keys: Key[]) => ({
    providers: await db
      .select()
      .from(schema.cliProviders)
      .where(inArray(schema.cliProviders.id, pids(keys)))
      .orderBy(asc(schema.cliProviders.id)),
    secrets: await secretsOf(keys),
    snapshots: await snapshotsOf(keys),
  });
  /** Rows no poll of the set may touch: E, F, G and H whole, D's grant only (D polls itself). */
  const fence = async () => ({
    others: await dump(['E', 'F', 'G', 'H']),
    dSecrets: await secretsOf(['D']),
  });
  const usageRow = async (k: Key) => (await secretsOf([k])).find((s) => s.secretName === SECRET)!;
  const grantOf = async (k: Key) => JSON.parse(envelopeDecrypt(await usageRow(k), KEK)) as Grant;
  const statuses = async (keys: Key[]) =>
    Promise.all(keys.map(async (k) => (await snapshotsOf([k]))[0]?.status));
  const audits = () =>
    db.select().from(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, U));
  const sameGrant = (r: Awaited<ReturnType<typeof usageRow>>) => ({
    encryptedValue: r.encryptedValue,
    encryptedDek: r.encryptedDek,
    fingerprint: r.fingerprint,
    updatedAt: r.updatedAt,
  });
  const expectNoTokens = (text: string) => {
    for (const t of allTokens) expect(text.includes(t), 'a token leaked').toBe(false);
  };
  const trigger = async (table: string, when: string, body: string) => {
    const fn = `usage_set_poll_${rnd()}`;
    await db.execute(
      sql.raw(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`,
      ),
    );
    await db.execute(
      sql.raw(`CREATE TRIGGER ${fn} ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`),
    );
    return async () => {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON ${table}`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
    };
  };
  /** A holds a live grant, B and C hold grants the vendor rejects, H holds none. */
  const liveHolder = async () => {
    const gA = mkGrant();
    await store(gA, ['A'], new Date(clock - 10 * MIN));
    await store(mkGrant({ live: false, refreshable: false }), ['B'], new Date(clock - 3 * HOUR));
    await store(mkGrant({ live: false, refreshable: false }), ['C'], new Date(clock - 4 * HOUR));
    await seed('A', 'ok');
    await seed('B', 'needs_reconnect');
    await seed('C', 'needs_reconnect');
    return gA;
  };
  /** A, B and C hold identical copies of one grant that needs a refresh. */
  const expiredSet = async (o: GrantOptions = { expired: true, live: false }) => {
    const g0 = mkGrant({ expired: true, ...o });
    await store(g0, ['A', 'B', 'C']);
    return g0;
  };
  const expectSetConverged = async () => {
    const [a, b, c] = [await usageRow('A'), await usageRow('B'), await usageRow('C')];
    expect(sameGrant(b)).toEqual(sameGrant(a));
    expect(sameGrant(c)).toEqual(sameGrant(a));
    expect(await statuses(['A', 'B', 'C'])).toEqual(['ok', 'ok', 'ok']);
  };

  beforeAll(() => {
    db = createDatabase(url!);
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clock += HOUR;
    vi.setSystemTime(clock);
    vendor = makeVendor();
    vi.stubGlobal('fetch', vendor.fetch);
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    vi.spyOn(configService, 'get').mockResolvedValue('off');
    vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
    const users = await db
      .insert(schema.users)
      .values(
        [1, 2].map(() => ({ emailEncrypted: rnd(), emailBlindIndex: rnd(), passwordHash: 'x' })),
      )
      .returning();
    [U, V] = [users[0]!.id, users[1]!.id];
    const spec = {
      A: [U, 'claude-code', 'subscription', false, true],
      B: [U, 'claude-code', 'subscription', false, true],
      C: [U, 'claude-code', 'subscription', false, false],
      H: [U, 'claude-code', 'subscription', false, true],
      D: [U, 'claude-code', 'subscription', true, true],
      E: [U, 'claude-code', 'api_key', false, false],
      F: [V, 'claude-code', 'subscription', false, false],
      G: [U, 'codex', 'subscription', false, false],
    } as const;
    const made: any = {};
    for (const [key, [userId, name, authMode, isolateAuth, enabled]] of Object.entries(spec)) {
      const [row] = await db
        .insert(schema.cliProviders)
        .values({ userId, name, authMode, isolateAuth, enabled, label: key })
        .returning();
      made[key] = row;
    }
    rows = made;
    dGrant = mkGrant();
    await store(dGrant, ['D']);
    await store(mkGrant(), ['E']);
    await store(mkGrant(), ['F']);
    await store(mkGrant(), ['G']);
    await seed('F', 'ok');
    await seed('G', 'ok');
  });
  afterEach(async () => {
    leftBehind.push(
      JSON.stringify(await audits()),
      JSON.stringify(
        (await db.select().from(schema.usageWindowSnapshots)).map((s) => s.errorMessage),
      ),
    );
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, U));
    await db.delete(schema.users).where(inArray(schema.users.id, [U, V]));
  });

  it.each([false, true])(
    'never polls an API-key Claude row holding an expired grant (isolated=%s)',
    async (isolateAuth) => {
      await db
        .delete(schema.cliProviderSecrets)
        .where(eq(schema.cliProviderSecrets.providerId, rows.E.id));
      const g = mkGrant({ expired: true, live: false });
      await store(g, ['E']);
      await db
        .update(schema.cliProviders)
        .set({ enabled: true, isolateAuth })
        .where(eq(schema.cliProviders.id, rows.E.id));
      const before = await dump(['E']);
      await tick();
      expect(vendor.tokenCalls).not.toContain(g.refreshToken);
      expect(vendor.usageCalls).toEqual([dGrant.accessToken]);
      expect(await dump(['E'])).toEqual(before);
    },
  );

  it.each([503, 429, new TypeError('synthetic network failure')])(
    'never uses the stale access token after refresh failure (%s), and retries next tick',
    async (failure) => {
      const g = await expiredSet();
      const before = await secretsOf(['A', 'B', 'C']);
      vendor.tokenFailure = failure;
      await tick();
      expect(vendor.tokenCalls).toEqual([g.refreshToken]);
      expect(vendor.usageCalls).not.toContain(g.accessToken);
      expect(await secretsOf(['A', 'B', 'C'])).toEqual(before);
      expect(await snapshotsOf(['A', 'B', 'C'])).toEqual([]);
      vendor.tokenFailure = undefined;
      await tick();
      expect(vendor.tokenCalls).toEqual([g.refreshToken, g.refreshToken]);
      expect(vendor.usageCalls).toContain((await grantOf('A')).accessToken);
      await expectSetConverged();
    },
  );

  it('commits the single-use rotation before usage, surviving a failed fetch and snapshot write', async () => {
    const g = await expiredSet();
    const drop = await trigger(
      'usage_window_snapshots',
      'BEFORE INSERT',
      "RAISE EXCEPTION 'synthetic snapshot failure';",
    );
    let atUsage: { token: string; copies: Grant[]; oldRefreshLive: boolean } | undefined;
    vendor.onUsage = async (token) => {
      if (token === dGrant.accessToken) return;
      atUsage = {
        token,
        copies: await Promise.all((['A', 'B', 'C'] as const).map(grantOf)),
        oldRefreshLive: vendor.refreshable.has(g.refreshToken),
      };
      throw new Error('synthetic interruption before snapshot');
    };
    try {
      await tick();
    } finally {
      await drop();
    }
    const stored = await grantOf('A');
    expect(atUsage).toEqual({
      token: stored.accessToken,
      copies: [stored, stored, stored],
      oldRefreshLive: false,
    });
    expect(stored.refreshToken === g.refreshToken).toBe(false);
    expect(await snapshotsOf(['A', 'B', 'C'])).toEqual([]);
    vendor.onUsage = undefined;
    step(5 * MIN);
    await tick();
    // Reusing g's single-use refresh would fail. The committed rotated grant is read instead.
    expect(vendor.tokenCalls).toEqual([g.refreshToken]);
    expect(vendor.callsWith(stored.accessToken)).toBe(2);
    await expectSetConverged();
  });

  it.each(['error', null, 'needs_reconnect'] as const)(
    'holder ordering keeps the no-snapshot tier between error and needs_reconnect (%s)',
    async (status) => {
      const older = new Date(clock - 3 * HOUR);
      await store(mkGrant(), ['A'], older);
      await store(mkGrant(), ['B'], new Date(clock - HOUR));
      if (status) await seed('A', status);
      await seed('B', 'needs_reconnect');
      const holder = await pickGrantHolder(db, rows.A);
      // At needs_reconnect B wins by secret age; otherwise A's tier wins.
      expect(holder?.providerId).toBe(status === 'needs_reconnect' ? rows.B.id : rows.A.id);
    },
  );

  it('an error snapshot outranks a newer grant with no snapshot', async () => {
    await store(mkGrant(), ['A'], new Date(clock - 3 * HOUR));
    await store(mkGrant(), ['B'], new Date(clock - HOUR));
    await seed('A', 'error');
    expect((await pickGrantHolder(db, rows.A))?.providerId).toBe(rows.A.id);
  });

  it.each(['ok', 'error', null, 'needs_reconnect'] as const)(
    'holder tie breaks in tier %s use newest secret then smallest id',
    async (status) => {
      const sorted = (['A', 'B', 'C'] as const).toSorted((a, b) =>
        rows[a].id.localeCompare(rows[b].id),
      );
      const [small, middle, large] = sorted;
      await store(mkGrant(), [small!, large!], new Date(clock - HOUR));
      await store(mkGrant(), [middle!], new Date(clock - 2 * HOUR));
      if (status) for (const key of sorted) await seed(key, status, new Date(clock - HOUR));
      expect((await pickGrantHolder(db, rows.A))?.providerId).toBe(rows[small!].id);
      await db
        .update(schema.cliProviderSecrets)
        .set({ updatedAt: new Date(clock) })
        .where(eq(schema.cliProviderSecrets.providerId, rows[large!].id));
      expect((await pickGrantHolder(db, rows.A))?.providerId).toBe(rows[large!].id);
    },
  );

  it('one refresh serves every identical copy of a grant', async () => {
    const g0 = await expiredSet();
    const guard = await fence();
    await tick();
    expect(vendor.tokenCalls).toEqual([g0.refreshToken]);
    expect(vendor.usageCalls).toHaveLength(2);
    const rotated = await grantOf('A');
    expect(rotated.refreshToken).not.toBe(g0.refreshToken);
    expect([...vendor.usageCalls].sort()).toEqual([rotated.accessToken, dGrant.accessToken].sort());
    await expectSetConverged();
    const fetched = (await snapshotsOf(['A', 'B', 'C'])).map((s) => s.fetchedAt.getTime());
    expect(new Set(fetched).size).toBe(1);
    expect(await secretsOf(['H'])).toEqual([]);
    expect(await fence()).toEqual(guard);
  });

  it('fetches once per set per tick, then waits out the poll interval', async () => {
    const g0 = await expiredSet();
    await tick();
    expect(vendor.tokenCalls).toEqual([g0.refreshToken]);
    expect(vendor.usageCalls).toHaveLength(2);
    expect(await statuses(['A', 'B', 'C'])).toEqual(['ok', 'ok', 'ok']);
    vendor.reset();
    step(MIN);
    await tick();
    expect([vendor.tokenCalls, vendor.usageCalls]).toEqual([[], []]);
    step(5 * MIN);
    await tick();
    expect(vendor.tokenCalls).toEqual([]);
    expect(vendor.usageCalls).toHaveLength(2);
    expect(vendor.usageCalls).toContain((await grantOf('A')).accessToken);
    expect(vendor.usageCalls).toContain(dGrant.accessToken);
  });

  it('a 429 backs the whole set off', async () => {
    const g = mkGrant();
    await store(g, ['A', 'B', 'C']);
    vendor.status.set(g.accessToken, 429);
    await tick();
    expect(vendor.callsWith(g.accessToken)).toBe(1);
    step(4 * MIN);
    await tick();
    expect(vendor.callsWith(g.accessToken)).toBe(1);
    expect(vendor.callsWith(dGrant.accessToken)).toBe(2);
  });

  it('three denials in a row mark the whole set as needing a reconnect', async () => {
    const g = mkGrant({ live: false });
    await store(g, ['A', 'B', 'C']);
    for (const k of ['A', 'B', 'C'] as const) await seed(k, 'ok');
    const before = await snapshotsOf(['A', 'B', 'C']);
    for (const calls of [1, 2, 3]) {
      await tick();
      expect(vendor.callsWith(g.accessToken), `tick ${calls}`).toBe(calls);
      if (calls < 3) expect(await snapshotsOf(['A', 'B', 'C']), `tick ${calls}`).toEqual(before);
      step(4 * MIN);
    }
    expect(await statuses(['A', 'B', 'C'])).toEqual(Array(3).fill('needs_reconnect'));
    await tick();
    expect(vendor.callsWith(g.accessToken)).toBe(3);
  });

  it('a proven-live holder gives its grant to every row of the set, disabled ones included', async () => {
    const gA = await liveHolder();
    const guard = await fence();
    const aBefore = await usageRow('A');
    await tick();
    expect(vendor.usageCalls.filter((t) => t !== dGrant.accessToken)).toEqual([gA.accessToken]);
    expect(await usageRow('A')).toEqual(aBefore);
    expect(sameGrant(await usageRow('B'))).toEqual(sameGrant(aBefore));
    expect(sameGrant(await usageRow('C'))).toEqual(sameGrant(aBefore));
    expect(await statuses(['A', 'B', 'C'])).toEqual(['ok', 'ok', 'ok']);
    const audit = await audits();
    expect(audit.map((r) => r.targetId).sort()).toEqual([rows.B.id, rows.C.id].sort());
    for (const r of audit)
      expect(r).toMatchObject({
        action: 'cli_provider.secret.set',
        targetType: 'cli_provider',
        actorUserId: U,
        metadata: { source: 'usage-poll', viaProviderId: rows.A.id },
      });
    expectNoTokens(JSON.stringify(audit));
    expect(await fence()).toEqual(guard);
  });

  it('a refused audit entry rolls the whole convergence back', async () => {
    await liveHolder();
    const before = await dump(['A', 'B', 'C']);
    const drop = await trigger('audit_events', 'BEFORE INSERT', `RAISE EXCEPTION 'audit refused';`);
    try {
      await tick();
    } finally {
      await drop();
    }
    expect(await dump(['A', 'B', 'C'])).toEqual(before);
    expect(await audits()).toEqual([]);
    step(6 * MIN);
    await tick();
    await expectSetConverged();
    expect(await audits()).toHaveLength(2);
  });

  it('a holder the vendor answers with a server error converges nothing and keeps its readings', async () => {
    const gA = mkGrant({ live: false });
    vendor.status.set(gA.accessToken, 500);
    await store(gA, ['A'], new Date(clock - 10 * MIN));
    await store(mkGrant({ live: false, refreshable: false }), ['B'], new Date(clock - 3 * HOUR));
    await store(mkGrant({ live: false, refreshable: false }), ['C'], new Date(clock - 4 * HOUR));
    await seed('A', 'ok');
    const secrets = await secretsOf(['A', 'B', 'C']);
    await tick();
    expect(await secretsOf(['A', 'B', 'C'])).toEqual(secrets);
    expect(await audits()).toEqual([]);
    expect((await snapshotsOf(['A']))[0]).toMatchObject({ status: 'error', fiveHourPct: 5 });
    expect(await snapshotsOf(['B', 'C'])).toEqual([]);
  });

  it('a holder whose refresh token is refused converges nothing and asks for a reconnect', async () => {
    await store(
      mkGrant({ expired: true, live: false, refreshable: false }),
      ['A'],
      new Date(clock - 10 * MIN),
    );
    await store(mkGrant({ live: false, refreshable: false }), ['B'], new Date(clock - 3 * HOUR));
    await store(mkGrant({ live: false, refreshable: false }), ['C'], new Date(clock - 4 * HOUR));
    await seed('A', 'ok');
    const secrets = await secretsOf(['A', 'B', 'C']);
    await tick();
    expect(await secretsOf(['A', 'B', 'C'])).toEqual(secrets);
    expect(await audits()).toEqual([]);
    expect((await snapshotsOf(['A']))[0]?.status).toBe('needs_reconnect');
    expect(await snapshotsOf(['B', 'C'])).toEqual([]);
  });

  it('a transient error on the live copy does not hand the set to a newer-stamped dead copy', async () => {
    const gA = mkGrant();
    await store(gA, ['A'], new Date(clock - 6 * HOUR));
    await store(mkGrant({ live: false, refreshable: false }), ['B'], new Date(clock - 10 * MIN));
    await store(mkGrant({ live: false, refreshable: false }), ['C'], new Date(clock - 20 * MIN));
    await seed('A', 'error');
    await seed('B', 'needs_reconnect');
    await seed('C', 'needs_reconnect');
    await tick();
    expect(vendor.usageCalls.filter((t) => t !== dGrant.accessToken)).toEqual([gA.accessToken]);
    await expectSetConverged();
  });

  it.each([
    ['is not a grant', () => `plain-${rnd()}`],
    [
      'has an empty access token',
      () => JSON.stringify({ ...mkGrant({ live: false }), accessToken: '' }),
    ],
  ])(
    'a top-ranked copy that %s is passed over, and the next live grant replaces it',
    async (_n, make) => {
      // An earlier manual write could store any value and leave the row's ok reading in place.
      const bad = make();
      const env = envelopeEncrypt(bad, KEK);
      await db.insert(schema.cliProviderSecrets).values({
        providerId: rows.A.id,
        secretName: SECRET,
        encryptedValue: env.encryptedValue,
        encryptedDek: env.encryptedDek,
        fingerprint: computeKeyFingerprint(bad),
        createdAt: new Date(clock - 5 * MIN),
        updatedAt: new Date(clock - 5 * MIN),
      });
      const gB = mkGrant();
      await store(gB, ['B'], new Date(clock - 3 * HOUR));
      await store(mkGrant({ live: false, refreshable: false }), ['C'], new Date(clock - 4 * HOUR));
      await seed('A', 'ok', new Date(clock - 10 * MIN));
      await seed('B', 'ok', new Date(clock - 2 * HOUR));
      await seed('C', 'needs_reconnect');
      await tick();
      expect(vendor.usageCalls.filter((t) => t !== dGrant.accessToken)).toEqual([gB.accessToken]);
      const b = sameGrant(await usageRow('B'));
      expect(sameGrant(await usageRow('A'))).toEqual(b);
      expect(sameGrant(await usageRow('C'))).toEqual(b);
      expect(await statuses(['A', 'B', 'C'])).toEqual(['ok', 'ok', 'ok']);
    },
  );

  it('the copy whose fetch last proved it live is the holder, however newer another copy is stamped', async () => {
    const gA = mkGrant();
    await store(gA, ['A'], new Date(clock - 6 * HOUR));
    await store(mkGrant({ live: false, refreshable: false }), ['B'], new Date(clock - 10 * MIN));
    await store(mkGrant({ live: false, refreshable: false }), ['C'], new Date(clock - 20 * MIN));
    await seed('A', 'ok', new Date(clock - 2 * MIN));
    await seed('B', 'ok', new Date(clock - 3 * HOUR));
    await seed('C', 'needs_reconnect');
    await tick();
    expect(vendor.usageCalls.filter((t) => t !== dGrant.accessToken)).toEqual([gA.accessToken]);
    await expectSetConverged();
  });

  it('a poll of an isolated row that joins a set during its fetch writes nothing', async () => {
    const dBefore = await secretsOf(['D']);
    vendor.onUsage = async (token) => {
      if (token !== dGrant.accessToken) return;
      await db
        .update(schema.cliProviders)
        .set({ isolateAuth: false })
        .where(eq(schema.cliProviders.id, rows.D.id));
    };
    await tick();
    expect(vendor.callsWith(dGrant.accessToken)).toBe(1);
    expect(await snapshotsOf(['D'])).toEqual([]);
    expect(await secretsOf(['D'])).toEqual(dBefore);
    expect(await audits()).toEqual([]);
  });

  it('a grant replaced while its fetch is in flight is neither converged nor recorded', async () => {
    const gA = mkGrant();
    const replacement = mkGrant();
    await store(gA, ['A'], new Date(clock - 10 * MIN));
    await store(mkGrant({ live: false, refreshable: false }), ['B'], new Date(clock - 3 * HOUR));
    await store(mkGrant({ live: false, refreshable: false }), ['C'], new Date(clock - 4 * HOUR));
    const others = await secretsOf(['B', 'C']);
    vendor.onUsage = async (token) => {
      if (token !== gA.accessToken) return;
      const json = JSON.stringify(replacement);
      await db
        .update(schema.cliProviderSecrets)
        .set({ ...envelopeEncrypt(json, KEK), fingerprint: computeKeyFingerprint(json) })
        .where(
          and(
            eq(schema.cliProviderSecrets.providerId, rows.A.id),
            eq(schema.cliProviderSecrets.secretName, SECRET),
          ),
        );
    };
    await tick();
    expect(await snapshotsOf(['A', 'B', 'C'])).toEqual([]);
    expect(await secretsOf(['B', 'C'])).toEqual(others);
    expect(await audits()).toEqual([]);
    expect(await grantOf('A')).toEqual(replacement);
    vendor.onUsage = undefined;
    vendor.reset();
    step(6 * MIN);
    await tick();
    expect(vendor.usageCalls).toContain(replacement.accessToken);
  });

  it('a refresh whose fetch fails rotates only the copies of the refreshed grant', async () => {
    vendor.issuedStatus = 500;
    const g0 = mkGrant({ expired: true, live: false });
    await store(g0, ['A', 'B']);
    await store(mkGrant({ live: false, refreshable: false }), ['C'], new Date(clock - 3 * HOUR));
    const cBefore = await secretsOf(['C']);
    await tick();
    expect(vendor.tokenCalls).toEqual([g0.refreshToken]);
    expect(sameGrant(await usageRow('B'))).toEqual(sameGrant(await usageRow('A')));
    expect((await grantOf('A')).refreshToken).not.toBe(g0.refreshToken);
    expect(await secretsOf(['C'])).toEqual(cBefore);
    expect(await audits()).toEqual([]);
    expect(await statuses(['A', 'B', 'C'])).toEqual(['error', 'error', undefined]);
  });

  it('a busy authentication lock skips the refresh and the write until it is released', async () => {
    const g0 = await expiredSet();
    const before = await dump(['A', 'B', 'C', 'H']);
    const held = await tryCliAuthLock(db, cliAuthScope(rows.A));
    expect(held).not.toBeNull();
    try {
      await tick();
      expect(vendor.tokenCalls).toEqual([]);
      expect(await dump(['A', 'B', 'C', 'H'])).toEqual(before);
    } finally {
      await held!();
    }
    step(4 * MIN);
    await tick();
    expect(vendor.tokenCalls).toEqual([g0.refreshToken]);
    await expectSetConverged();
  });

  it('puts no token into a log line, an audit entry or a snapshot message', async () => {
    await expiredSet({ live: false, refreshable: false });
    await failingHolder();
    await tick();
    step(4 * MIN);
    const runner = { volumeExists: async () => false } as unknown as DockerRunner;
    await handleSignOutJob(db, { providerId: rows.A.id, userId: U }, runner);
    expect(logs.calls.length).toBeGreaterThan(0);
    const rejected = await snapshotsOf(['A', 'B', 'C', 'D']);
    leftBehind.push(
      JSON.stringify(await audits()),
      JSON.stringify(rejected.map((s) => s.errorMessage)),
    );
    expectNoTokens(inspect(logs.calls, { depth: 8, maxArrayLength: null, maxStringLength: null }));
    for (const text of leftBehind) expectNoTokens(text);
  });

  it('refreshes and fetches a lone isolated row once and records its snapshot', async () => {
    await db
      .delete(schema.cliProviderSecrets)
      .where(eq(schema.cliProviderSecrets.providerId, rows.D.id));
    const g0 = mkGrant({ expired: true, live: false });
    await store(g0, ['D']);
    await tick();
    expect(vendor.tokenCalls).toEqual([g0.refreshToken]);
    expect(vendor.usageCalls).toEqual([(await grantOf('D')).accessToken]);
    expect(await statuses(['D'])).toEqual(['ok']);
  });

  /** A row of the set whose usage call fails with a server error, for log coverage. */
  async function failingHolder() {
    const failing = mkGrant({ live: false });
    vendor.status.set(failing.accessToken, 500);
    await store(failing, ['H']);
  }
});

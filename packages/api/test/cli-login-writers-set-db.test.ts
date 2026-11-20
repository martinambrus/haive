import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { isLockNotAvailable, tryCliAuthLock } from '@haive/database';
import * as authState from '@haive/shared/cli-auth-state';
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
  loseAt: undefined as number | undefined,
  checks: 0,
  afterLock: undefined as (() => Promise<void>) | undefined,
  joinWaitMs: 0,
  refused: undefined as (() => void) | undefined,
}));
vi.mock('@haive/database', async (original) => {
  const real = await original<any>();
  return {
    ...real,
    tryCliAuthLock: async (...args: any[]) => {
      const lock = await real.tryCliAuthLock(...args);
      if (!lock && h.refused) {
        const refused = h.refused;
        h.refused = undefined;
        refused();
      }
      if (lock && h.afterLock) {
        const hook = h.afterLock;
        h.afterLock = undefined;
        await hook();
      }
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
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ eval: async () => '' }) }));
vi.mock('../src/lib/cli-auth-write.js', async (original) => ({
  ...(await original<any>()),
  // Elapsed waiting is tested with fake timers in cli-auth-write.test.ts.
  // Here a control sets the wait it needs; otherwise there is none.
  get CLI_AUTH_JOIN_WAIT_MS() {
    return h.joinWaitMs;
  },
}));
import { CLI_EXEC_JOB_NAMES, configService, envelopeDecrypt, secretsService } from '@haive/shared';
import { lockLoginSet, upsertProviderSecret } from '@haive/shared';
import { writeLoginTokenToSet } from '../src/lib/cli-login-secret.js';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const rnd = () => randomBytes(16).toString('hex');
const PAST = new Date('2020-01-01T00:00:00Z');
const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
const USAGE = 'CLAUDE_USAGE_OAUTH';
// Rows hold no usage connection by default: its set-wide rules are pinned in cli-usage-grant-set-db.test.ts.
// A test that needs one seeds it with `seedGrants`.
const NAMES = [TOKEN, 'ANTHROPIC_AUTH_TOKEN'];
type Row = typeof schema.cliProviders.$inferSelect;
type Key = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
const SET_ACTION = 'cli_provider.secret.set';
const DELETE_ACTION = 'cli_provider.secret.delete';

describe.skipIf(!url)(
  'every writer of the Claude login token writes the whole credential set',
  () => {
    let db: ReturnType<typeof createDatabase>;
    let U: string;
    let V: string;
    let rows: Record<Key, Row>;
    const app = new Hono<AppEnv>().onError(errorHandler).route('/cli-providers', cliProviderRoutes);
    const ids = () => Object.values(rows).map((r) => r.id);
    const call = (method: string, path: string, body?: unknown) =>
      app.request(`/cli-providers${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const post = (key: Key, name: string, value: string) =>
      call('POST', `/${rows[key].id}/secrets`, { secretName: name, value });
    const del = (key: Key, name: string) => call('DELETE', `/${rows[key].id}/secrets/${name}`);
    const patch = (key: Key, body: unknown) => call('PATCH', `/${rows[key].id}`, body);
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
    const secretRows = (pids: string[]) =>
      db
        .select()
        .from(schema.cliProviderSecrets)
        .where(inArray(schema.cliProviderSecrets.providerId, pids))
        .orderBy(asc(schema.cliProviderSecrets.id));
    const world = async () => ({
      providers: await db
        .select()
        .from(schema.cliProviders)
        .where(inArray(schema.cliProviders.userId, [U, V]))
        .orderBy(asc(schema.cliProviders.id)),
      secrets: await secretRows(ids()),
      audits: (await audits(db)).filter((a) => a.actorUserId === U || ids().includes(a.targetId!)),
    });
    const plain = async (id: string, name: string) => {
      const [s] = (await secretRows([id])).filter((r) => r.secretName === name);
      return s && envelopeDecrypt(s, KEK);
    };
    const snapshot = async (pids: string[]) => ({
      providers: await Promise.all(pids.map(provider)),
      secrets: await secretRows(pids),
      audits: (await audits(db)).filter((a) => pids.includes(a.targetId!)),
    });
    const outside = (keys: Key[]) => snapshot(keys.map((k) => rows[k].id));
    /** A second codex row in F's set; F and G each hold their own login token. */
    const seedCodexSet = async () => {
      const [g] = await db
        .insert(schema.cliProviders)
        .values({
          userId: U,
          name: 'codex',
          authMode: 'subscription',
          isolateAuth: false,
          label: 'G',
          authLastCheckedAt: PAST,
        })
        .returning();
      for (const id of [rows.F.id, g!.id])
        await upsertProviderSecret(db, {
          providerId: id,
          name: TOKEN,
          value: rnd(),
          masterKek: KEK,
          onExisting: 'overwrite',
        });
      return g!;
    };
    const seedGrants = async (keys: Key[]) => {
      for (const key of keys)
        await upsertProviderSecret(db, {
          providerId: rows[key].id,
          name: USAGE,
          value: JSON.stringify({
            accessToken: rnd(),
            refreshToken: rnd(),
            expiresAt: Date.now() + 3_600_000,
            scopes: ['user:profile'],
          }),
          masterKek: KEK,
          onExisting: 'overwrite',
        });
    };
    const setRowsFor = async (pids: string[]) =>
      (await byAction(SET_ACTION)).filter((a) => pids.includes(a.targetId!));
    const health = (p: Row) => [p.authStatus, p.authMessage, p.authLastCheckedAt?.getTime()];
    const others = async (pids: string[]) =>
      (await secretRows(pids)).filter((s) => s.secretName !== TOKEN);
    const byAction = async (action: string) =>
      (await audits(db)).filter((a) => a.actorUserId === U && a.action === action);
    const findNew = (label: string) =>
      db.query.cliProviders
        .findFirst({
          where: and(eq(schema.cliProviders.userId, U), eq(schema.cliProviders.label, label)),
        })
        .then((r) => r!);
    /** Every member holds the token and one shared generation that differs from each old one. */
    const expectWritten = async (
      token: string,
      members: (Key | string)[],
      envs: Record<string, unknown> = {},
    ) => {
      const gens = new Set<string>();
      for (const m of members) {
        const old = rows[m as Key] as Row | undefined;
        const p = await provider(old ? old.id : m);
        expect((await plain(p.id, TOKEN)) === token, m).toBe(true);
        gens.add(p.authGeneration);
        if (old) {
          expect(p.authGeneration, m).not.toBe(old.authGeneration);
          expect(health(p), m).toEqual(health(old));
          expect(p.envVars, m).toEqual(m in envs ? envs[m] : old.envVars);
        }
      }
      expect(gens.size).toBe(1);
    };
    /** Exactly the clicked row's event plus one strict sibling event per other written row. */
    const expectEvents = async (
      action: string,
      source: string,
      via: string,
      siblings: string[],
      setSize: number,
      clicked: object | null = { source, secretName: TOKEN },
    ) => {
      const events = await byAction(action);
      expect(events.map((e) => e.targetId).sort()).toEqual(
        [...(clicked ? [via] : []), ...siblings].sort(),
      );
      if (clicked) expect(events.find((e) => e.targetId === via)!.metadata).toEqual(clicked);
      for (const s of siblings)
        expect(events.find((e) => e.targetId === s)!.metadata, s).toEqual({
          source,
          secretName: TOKEN,
          viaProviderId: via,
          setSize,
        });
      const shape = (a: (typeof events)[number]) => ({
        actorUserId: U,
        action: a.action,
        targetType: 'cli_provider',
        targetId: a.targetId,
        metadata: a.metadata,
      });
      for (const spy of [h.insert, h.log])
        for (const e of events) expect(spy.mock.calls.map((c) => c[0])).toContainEqual(shape(e));
    };
    const STAMP_NEW = '2024-06-07 08:09:10.123457';
    const STAMP_OLD = '2023-01-02 03:04:05.654321';
    const stampText = async (id: string) => {
      const [r] = await db.execute<{ t: string | null }>(
        sql`select auth_last_checked_at::text as t from cli_providers where id = ${id}`,
      );
      return r!.t;
    };
    /** A and B hold different logins, `newest` the newest token and the other an older one. */
    const differ = async (newest: 'A' | 'B') => {
      const older = newest === 'A' ? 'B' : 'A';
      for (const [key, status, message, stamp, at] of [
        [newest, 'ok', 'newest member', STAMP_NEW, new Date('2024-01-01T00:00:00Z')],
        [older, 'auth_expired', 'older member', STAMP_OLD, PAST],
      ] as const) {
        await db
          .update(schema.cliProviders)
          .set({
            authStatus: status,
            authMessage: message,
            authLastCheckedAt: sql`${stamp}::timestamp`,
            authGeneration: randomUUID(),
          })
          .where(eq(schema.cliProviders.id, rows[key].id));
        await db
          .update(schema.cliProviderSecrets)
          .set({ updatedAt: at })
          .where(
            and(
              eq(schema.cliProviderSecrets.providerId, rows[key].id),
              eq(schema.cliProviderSecrets.secretName, TOKEN),
            ),
          );
        rows[key] = await provider(rows[key].id);
      }
    };
    const joinEvents = async () =>
      (await byAction(SET_ACTION)).filter((a) => (a.metadata as any)?.source === 'join');
    /** `id` holds the token, status, message, stamp (as text) and generation of member `from`, and one join event says so. */
    const expectJoined = async (id: string, from: 'A' | 'B', setSize: number) => {
      const p = await provider(id);
      const src = rows[from];
      const token = await plain(id, TOKEN);
      expect(token).toBeDefined();
      expect(token === (await plain(src.id, TOKEN))).toBe(true);
      expect(token === (await plain(rows[from === 'A' ? 'B' : 'A'].id, TOKEN))).toBe(false);
      expect([p.authStatus, p.authMessage, p.authGeneration]).toEqual([
        src.authStatus,
        src.authMessage,
        src.authGeneration,
      ]);
      const stamp = await stampText(id);
      expect(stamp).not.toBeNull();
      expect(stamp).toBe(await stampText(src.id));
      const metadata = { source: 'join', secretName: TOKEN, viaProviderId: src.id, setSize };
      expect((await byAction(SET_ACTION)).filter((a) => a.targetId === id)).toHaveLength(1);
      expect((await joinEvents()).map((a) => [a.targetId, a.metadata])).toEqual([[id, metadata]]);
      const event = {
        actorUserId: U,
        action: SET_ACTION,
        targetType: 'cli_provider',
        targetId: id,
        metadata,
      };
      for (const spy of [h.insert, h.log])
        expect(spy.mock.calls.map((c) => c[0])).toContainEqual(event);
    };
    const cloneOf = (key: Key) => call('POST', `/${rows[key].id}/clone`);
    const cloneMetadata = async () =>
      (await byAction('cli_provider.clone'))[0]!.metadata as {
        secretCount: number;
        secretNames: string[];
      };
    const trigger = async (table: string, when: string, body: string, ret = 'NEW') => {
      const fn = `writers_set_${rnd()}`;
      await db.execute(
        sql.raw(
          `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN ${ret}; END $$`,
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
    const refuseSecretWrites = () =>
      trigger(
        'cli_provider_secrets',
        'BEFORE INSERT OR UPDATE',
        `IF NEW.provider_id = '${rows.B.id}'::uuid THEN RAISE EXCEPTION 'secret write refused'; END IF;`,
      );
    const refuseSiblingAudit = () =>
      trigger(
        'audit_events',
        'BEFORE INSERT',
        `IF NEW.target_id = '${rows.B.id}'::uuid THEN RAISE EXCEPTION 'audit insert refused'; END IF;`,
      );
    const refuseJoinAudit = () =>
      trigger(
        'audit_events',
        'BEFORE INSERT',
        `IF NEW.action = '${SET_ACTION}' AND NEW.metadata ->> 'source' = 'join' THEN RAISE EXCEPTION 'audit insert refused'; END IF;`,
      );
    const FAKE: ('setTimeout' | 'clearTimeout' | 'Date')[] = ['setTimeout', 'clearTimeout', 'Date'];
    const holdSet = async (key: Key = 'A') => {
      const release = await tryCliAuthLock(db, authState.cliAuthScope(rows[key]));
      expect(release).not.toBeNull();
      return release!;
    };
    const dropToken = (key: Key) =>
      db
        .delete(schema.cliProviderSecrets)
        .where(
          and(
            eq(schema.cliProviderSecrets.providerId, rows[key].id),
            eq(schema.cliProviderSecrets.secretName, TOKEN),
          ),
        );
    const signOut = async (key: Key) => {
      h.add.mockClear();
      const res = await call('POST', `/${rows[key].id}/sign-out`);
      return { res, payload: h.add.mock.calls[0]?.[1] };
    };

    beforeAll(() => {
      db = createDatabase(url!);
      h.db = db;
    });
    afterAll(async () => {
      await db.$client.end({ timeout: 5 });
    });
    const setup = async () => {
      h.loseAt = undefined;
      h.afterLock = undefined;
      h.checks = 0;
      h.joinWaitMs = 0;
      h.refused = undefined;
      h.insert.mockClear();
      h.log.mockClear();
      h.poll.mockReset().mockResolvedValue(undefined);
      h.add.mockReset().mockResolvedValue({ id: 'job-id' });
      vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
      vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
      U = (await makeActor(db)).id;
      V = (await makeActor(db)).id;
      h.actor = U;
      const spec = {
        A: [U, 'claude-code', 'subscription', false, 'unknown'],
        B: [U, 'claude-code', 'subscription', false, 'auth_expired'],
        C: [U, 'claude-code', 'subscription', true, 'ok'],
        D: [U, 'claude-code', 'api_key', false, 'ok'],
        E: [V, 'claude-code', 'subscription', false, 'auth_expired'],
        F: [U, 'codex', 'subscription', false, 'unknown'],
      } as const;
      const made: any = {};
      for (const [key, [userId, name, authMode, isolateAuth, authStatus]] of Object.entries(spec)) {
        const [row] = await db
          .insert(schema.cliProviders)
          .values({
            userId,
            name,
            authMode,
            isolateAuth,
            authStatus,
            label: key,
            authMessage: 'synthetic',
            authLastCheckedAt: PAST,
            envVars: key === 'A' ? { KEEP: 'yes' } : key === 'B' ? { KEEP: 'b' } : null,
          })
          .returning();
        made[key] = row;
        if (key !== 'F')
          for (const secret of NAMES)
            await upsertProviderSecret(db, {
              providerId: row!.id,
              name: secret,
              value: rnd(),
              masterKek: KEK,
              onExisting: 'overwrite',
            });
      }
      rows = made;
    };
    beforeEach(setup);
    const teardown = async () => {
      await cleanActor(db, U);
      await cleanActor(db, V);
    };
    afterEach(async () => {
      h.loseAt = undefined;
      h.afterLock = undefined;
      h.joinWaitMs = 0;
      h.refused = undefined;
      vi.useRealTimers();
      await teardown();
      vi.restoreAllMocks();
    });

    it.each([
      ['holds', 200],
      ['lacks', 201],
    ])('a pasted token on a row that %s one writes every row of its set', async (state, status) => {
      if (state === 'lacks') await dropToken('A');
      const before = await outside(['C', 'D', 'E', 'F']);
      const keep = await others([rows.A.id, rows.B.id]);
      const token = rnd();
      const res = await post('A', TOKEN, token);
      expect(res.status).toBe(status);
      expect(await res.text()).not.toContain(token);
      await expectWritten(token, ['A', 'B']);
      expect(await others([rows.A.id, rows.B.id])).toEqual(keep);
      await expectEvents(SET_ACTION, 'manual', rows.A.id, [rows.B.id], 2);
      expect(await outside(['C', 'D', 'E', 'F'])).toEqual(before);
    });

    it.each([
      ['isolated', 'C', ['A', 'B', 'D', 'E', 'F']],
      ['api-key', 'D', ['A', 'B', 'C', 'E', 'F']],
    ] as [string, Key, Key[]][])(
      'a pasted token on an %s row writes only that row',
      async (_name, key, rest) => {
        const before = await outside(rest);
        const token = rnd();
        expect((await post(key, TOKEN, token)).status).toBe(200);
        await expectWritten(token, [key]);
        await expectEvents(SET_ACTION, 'manual', rows[key].id, [], 1);
        expect(await outside(rest)).toEqual(before);
      },
    );

    it('writes the usage connection to every row of the set and deletes it from each', async () => {
      await seedGrants(['A', 'B', 'C', 'D', 'E']);
      const before = await outside(['C', 'D', 'E', 'F']);
      const usage = JSON.stringify({
        accessToken: rnd(),
        refreshToken: rnd(),
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:profile'],
      });
      expect((await post('A', USAGE, usage)).status).toBe(200);
      const [a, b] = await Promise.all([provider(rows.A.id), provider(rows.B.id)]);
      for (const key of ['A', 'B'] as const)
        expect((await plain(rows[key].id, USAGE)) === usage, key).toBe(true);
      expect(a.authGeneration).not.toBe(rows.A.authGeneration);
      expect(b.authGeneration).not.toBe(rows.B.authGeneration);
      expect(b.authGeneration).toBe(a.authGeneration);
      expect(await outside(['C', 'D', 'E', 'F'])).toEqual(before);

      expect((await del('A', USAGE)).status).toBe(200);
      for (const key of ['A', 'B'] as const)
        expect(await plain(rows[key].id, USAGE), key).toBeUndefined();
      expect(await outside(['C', 'D', 'E', 'F'])).toEqual(before);
      expect((await provider(rows.A.id)).authGeneration).toBe(a.authGeneration);
      expect((await provider(rows.B.id)).authGeneration).toBe(a.authGeneration);
    });

    it('leaves the usage connection and the usage snapshots of every row alone when it writes or deletes the login token', async () => {
      const keys: Key[] = ['A', 'B', 'C', 'D', 'E', 'F'];
      await seedGrants(keys);
      await db.insert(schema.usageWindowSnapshots).values(
        keys.map((k) => ({
          providerId: rows[k].id,
          userId: rows[k].userId,
          providerName: rows[k].name,
          status: 'ok',
          fiveHourPct: 10,
        })),
      );
      const usageState = async () => ({
        secrets: await db
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
              inArray(
                schema.cliProviderSecrets.providerId,
                keys.map((k) => rows[k].id),
              ),
              eq(schema.cliProviderSecrets.secretName, USAGE),
            ),
          )
          .orderBy(asc(schema.cliProviderSecrets.providerId)),
        snapshots: await db
          .select()
          .from(schema.usageWindowSnapshots)
          .where(
            inArray(
              schema.usageWindowSnapshots.providerId,
              keys.map((k) => rows[k].id),
            ),
          )
          .orderBy(asc(schema.usageWindowSnapshots.providerId)),
      });
      const before = await usageState();
      expect(before.secrets).toHaveLength(keys.length);
      expect(before.snapshots).toHaveLength(keys.length);
      expect((await post('A', TOKEN, rnd())).status).toBe(200);
      expect(await usageState()).toEqual(before);
      expect((await patch('A', { envVars: { KEEP: 'yes', [TOKEN]: rnd() } })).status).toBe(200);
      expect(await usageState()).toEqual(before);
      expect((await del('A', TOKEN)).status).toBe(200);
      expect(await usageState()).toEqual(before);
    });

    it('keeps a pasted secret that is not the login or the usage connection on its row', async () => {
      const before = await outside(['B', 'C', 'D', 'E', 'F']);
      const other = rnd();
      expect((await post('A', 'ANTHROPIC_AUTH_TOKEN', other)).status).toBe(200);
      expect((await plain(rows.A.id, 'ANTHROPIC_AUTH_TOKEN')) === other).toBe(true);
      expect((await provider(rows.A.id)).authGeneration).toBe(rows.A.authGeneration);
      expect(await outside(['B', 'C', 'D', 'E', 'F'])).toEqual(before);
    });

    it('deletes the token from every row of the set that has it', async () => {
      const before = await outside(['C', 'D', 'E', 'F']);
      const keep = await others([rows.A.id, rows.B.id]);
      const res = await del('A', TOKEN);
      expect(res.status).toBe(200);
      for (const key of ['A', 'B'] as const) {
        expect(await plain(rows[key].id, TOKEN), key).toBeUndefined();
        expect(await provider(rows[key].id), key).toEqual(rows[key]);
      }
      expect(await others([rows.A.id, rows.B.id])).toEqual(keep);
      await expectEvents(DELETE_ACTION, 'manual', rows.A.id, [rows.B.id], 2);
      expect(await outside(['C', 'D', 'E', 'F'])).toEqual(before);
      const mine = async () => (await audits(db)).filter((a) => a.actorUserId === U).length;
      const events = await mine();
      expect((await del('A', TOKEN)).status).toBe(404);
      expect(await mine()).toBe(events);
    });

    it('deletes through a row that no longer has the token when a sibling still does', async () => {
      await dropToken('A');
      const before = await outside(['C', 'D', 'E', 'F']);
      expect((await del('A', TOKEN)).status).toBe(200);
      expect(await plain(rows.B.id, TOKEN)).toBeUndefined();
      expect(await provider(rows.B.id)).toEqual(rows.B);
      await expectEvents(DELETE_ACTION, 'manual', rows.A.id, [rows.B.id], 2, null);
      expect(await outside(['C', 'D', 'E', 'F'])).toEqual(before);
    });

    it('writes the set when a settings save types the token, leaving plaintext env alone', async () => {
      const before = await outside(['C', 'D', 'E', 'F']);
      const token = rnd();
      const res = await patch('A', { envVars: { KEEP: 'yes', [TOKEN]: token } });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(token);
      await expectWritten(token, ['A', 'B'], { A: { KEEP: 'yes' }, B: { KEEP: 'b' } });
      await expectEvents(SET_ACTION, 'environment', rows.A.id, [rows.B.id], 2, {
        source: 'environment',
        secretCount: 1,
        secretNames: [TOKEN],
      });
      expect(await outside(['C', 'D', 'E', 'F'])).toEqual(before);
    });

    it('keeps a typed secret that is not the login token on the clicked row', async () => {
      const before = await outside(['B', 'C', 'D', 'E', 'F']);
      const other = rnd();
      expect(
        (await patch('A', { envVars: { KEEP: 'yes', ANTHROPIC_AUTH_TOKEN: other } })).status,
      ).toBe(200);
      expect((await plain(rows.A.id, 'ANTHROPIC_AUTH_TOKEN')) === other).toBe(true);
      expect((await provider(rows.A.id)).authGeneration).toBe(rows.A.authGeneration);
      expect(await outside(['B', 'C', 'D', 'E', 'F'])).toEqual(before);
    });

    it('writes the set the row has after the save, when an isolated row joins it', async () => {
      const before = await outside(['D', 'E', 'F']);
      const token = rnd();
      const res = await patch('C', { isolateAuth: false, envVars: { [TOKEN]: token } });
      expect(res.status).toBe(200);
      await expectWritten(token, ['A', 'B', 'C'], { C: {} });
      await expectEvents(SET_ACTION, 'environment', rows.C.id, [rows.A.id, rows.B.id], 3, {
        source: 'environment',
        secretCount: 1,
        secretNames: [TOKEN],
      });
      expect(await outside(['D', 'E', 'F'])).toEqual(before);
    });

    it('writes the set the row has after the save, when an API-key row joins it', async () => {
      const before = await outside(['C', 'E', 'F']);
      const token = rnd();
      const res = await patch('D', { authMode: 'subscription', envVars: { [TOKEN]: token } });
      expect(res.status).toBe(200);
      await expectWritten(token, ['A', 'B', 'D'], { D: {} });
      await expectEvents(SET_ACTION, 'environment', rows.D.id, [rows.A.id, rows.B.id], 3, {
        source: 'environment',
        secretCount: 1,
        secretNames: [TOKEN],
      });
      expect(await outside(['C', 'E', 'F'])).toEqual(before);
    });

    it('writes the new row and the whole set when a created row types the token', async () => {
      const before = await outside(['C', 'D', 'E', 'F']);
      const token = rnd();
      const body = createBody(token);
      const res = await call('POST', '', body);
      expect(res.status).toBe(201);
      expect(await res.text()).not.toContain(token);
      const created = await findNew(body.label);
      await expectWritten(token, ['A', 'B', created.id]);
      const sets = await byAction(SET_ACTION);
      expect(sets.map((e) => e.targetId).sort()).toEqual([rows.A.id, rows.B.id, created.id].sort());
      expect(sets.find((e) => e.targetId === created.id)!.metadata).toEqual({
        source: 'environment',
        secretCount: 1,
        secretNames: [TOKEN],
      });
      for (const key of ['A', 'B'] as const)
        expect(sets.find((e) => e.targetId === rows[key].id)!.metadata, key).toEqual({
          source: 'environment',
          secretName: TOKEN,
          viaProviderId: created.id,
          setSize: 3,
        });
      expect((await byAction('cli_provider.create')).map((e) => e.targetId)).toEqual([created.id]);
      for (const spy of [h.insert, h.log])
        for (const e of sets)
          expect(spy.mock.calls.map((c) => c[0])).toContainEqual(
            expect.objectContaining({ action: SET_ACTION, targetId: e.targetId }),
          );
      expect(h.add).toHaveBeenCalledTimes(1);
      expect(h.add.mock.calls[0]![0]).toBe(CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE);
      expect(await outside(['C', 'D', 'E', 'F'])).toEqual(before);
    });

    it('writes only an isolated created row, and takes no lock for it without a typed token', async () => {
      const before = await outside(['A', 'B', 'C', 'D', 'E', 'F']);
      const token = rnd();
      const body = createBody(token, { isolateAuth: true });
      expect((await call('POST', '', body)).status).toBe(201);
      const created = await findNew(body.label);
      expect((await plain(created.id, TOKEN)) === token).toBe(true);
      expect(await outside(['A', 'B', 'C', 'D', 'E', 'F'])).toEqual(before);
      const release = await holdSet();
      try {
        expect((await call('POST', '', createBody(null, { isolateAuth: true }))).status).toBe(201);
      } finally {
        await release();
      }
      expect(await outside(['A', 'B', 'C', 'D', 'E', 'F'])).toEqual(before);
    });

    describe('a row that joins a login set receives the login of the set', () => {
      const answered = async (res: Response) =>
        ((await res.json()) as { provider: Record<string, unknown> }).provider;
      const health3 = (p: Record<string, unknown>) => [
        p.authStatus,
        p.authMessage,
        p.authLastCheckedAt,
      ];
      const ownHealth = (r: Row) => [
        r.authStatus,
        r.authMessage,
        r.authLastCheckedAt?.toISOString() ?? null,
      ];

      it('a created row is answered with the login it took', async () => {
        await differ('B');
        const body = createBody(null);
        const res = await call('POST', '', body);
        expect(res.status).toBe(201);
        const p = await answered(res);
        expect(health3(p)).toEqual(ownHealth(rows.B));
        expect(p.label).toBe(body.label);
        expect(p.label).toBe((await findNew(body.label)).label);
      });

      it('a cloned row is answered with the login it took', async () => {
        await differ('B');
        const res = await cloneOf('A');
        expect(res.status).toBe(201);
        const p = await answered(res);
        expect(health3(p)).toEqual(ownHealth(rows.B));
        expect(p.label).toBe((await provider(p.id as string)).label);
      });

      it('a settings save that joins a set is answered with the login it took', async () => {
        await differ('B');
        await db
          .update(schema.cliProviders)
          .set({ authStatus: 'auth_expired' })
          .where(eq(schema.cliProviders.id, rows.C.id));
        const label = `joined-${rnd()}`;
        const res = await patch('C', { isolateAuth: false, label });
        expect(res.status).toBe(200);
        const p = await answered(res);
        expect(health3(p)).toEqual(ownHealth(rows.B));
        expect(p.label).toBe(label);
        expect(p.isolateAuth).toBe(false);
        expect((await provider(rows.C.id)).label).toBe(label);
      });

      it.each(['A', 'B'] as const)(
        'a created row without a typed token takes the login of the member with the newest token (%s)',
        async (newest) => {
          await differ(newest);
          const before = await outside(['A', 'B', 'C', 'D', 'E', 'F']);
          const body = createBody(null);
          const res = await call('POST', '', body);
          expect(res.status).toBe(201);
          const created = await findNew(body.label);
          await expectJoined(created.id, newest, 3);
          expect((await byAction(SET_ACTION)).length).toBe(1);
          expect(await outside(['A', 'B', 'C', 'D', 'E', 'F'])).toEqual(before);
        },
      );

      it('a created row takes an unset check stamp from a member that was never checked', async () => {
        await differ('B');
        await db
          .update(schema.cliProviders)
          .set({ authLastCheckedAt: null })
          .where(eq(schema.cliProviders.id, rows.B.id));
        const body = createBody(null);
        expect((await call('POST', '', body)).status).toBe(201);
        const created = await findNew(body.label);
        expect((await plain(created.id, TOKEN)) === (await plain(rows.B.id, TOKEN))).toBe(true);
        expect([created.authStatus, created.authMessage]).toEqual(['ok', 'newest member']);
        expect(await stampText(created.id)).toBeNull();
      });

      it('a created row copies a status that is not ok', async () => {
        await differ('B');
        await db
          .update(schema.cliProviders)
          .set({ authStatus: 'auth_denied', authMessage: 'access denied' })
          .where(eq(schema.cliProviders.id, rows.B.id));
        rows.B = await provider(rows.B.id);
        const body = createBody(null);
        expect((await call('POST', '', body)).status).toBe(201);
        const created = await findNew(body.label);
        expect([created.authStatus, created.authMessage]).toEqual(['auth_denied', 'access denied']);
        await expectJoined(created.id, 'B', 3);
      });

      it('a created API-key row is not seeded and takes no lock', async () => {
        const before = await outside(['A', 'B', 'C', 'D', 'E', 'F']);
        const body = createBody(null, { authMode: 'api_key' });
        const release = await holdSet('D');
        let res: Response;
        try {
          res = await call('POST', '', body);
        } finally {
          await release();
        }
        expect(res.status).toBe(201);
        const created = await findNew(body.label);
        expect(await plain(created.id, TOKEN)).toBeUndefined();
        expect(await byAction(SET_ACTION)).toEqual([]);
        expect(await outside(['A', 'B', 'C', 'D', 'E', 'F'])).toEqual(before);
      });

      it('a created row keeps its defaults when no member of the set holds a token', async () => {
        await dropToken('A');
        await dropToken('B');
        const before = await outside(['A', 'B', 'C', 'D', 'E', 'F']);
        const body = createBody(null);
        expect((await call('POST', '', body)).status).toBe(201);
        const created = await findNew(body.label);
        expect(await plain(created.id, TOKEN)).toBeUndefined();
        expect([created.authStatus, created.authMessage, created.authLastCheckedAt]).toEqual([
          'unknown',
          null,
          null,
        ]);
        expect(await byAction(SET_ACTION)).toEqual([]);
        expect(await outside(['A', 'B', 'C', 'D', 'E', 'F'])).toEqual(before);
      });

      it('a created row with a typed token is not seeded from the set', async () => {
        await differ('B');
        const token = rnd();
        const body = createBody(token);
        expect((await call('POST', '', body)).status).toBe(201);
        const created = await findNew(body.label);
        expect(await joinEvents()).toEqual([]);
        await expectWritten(token, ['A', 'B', created.id]);
      });

      it('a clone of the older member joins the set and takes the login of the newest member', async () => {
        await differ('B');
        const before = await outside(['A', 'B', 'C', 'D', 'E', 'F']);
        const res = await cloneOf('A');
        expect(res.status).toBe(201);
        const id = ((await res.json()) as { provider: { id: string } }).provider.id;
        await expectJoined(id, 'B', 3);
        // No usage connection is seeded here (a clone never copies one from its source: see the next test).
        for (const name of ['ANTHROPIC_AUTH_TOKEN'])
          expect((await plain(id, name)) === (await plain(rows.A.id, name)), name).toBe(true);
        expect(await cloneMetadata()).toEqual({
          sourceProviderId: rows.A.id,
          secretCount: 1,
          secretNames: ['ANTHROPIC_AUTH_TOKEN'],
        });
        expect((await byAction(SET_ACTION)).length).toBe(1);
        expect(await outside(['A', 'B', 'C', 'D', 'E', 'F'])).toEqual(before);
      });

      it('a clone of a member takes the usage connection of the set, not the copy of its source, and counts none', async () => {
        await seedGrants(['A', 'B']);
        // B holds the newest grant of the set; the source row A holds an older one.
        for (const [key, stamp] of [
          ['A', new Date('2021-01-01T00:00:00Z')],
          ['B', new Date('2024-01-01T00:00:00Z')],
        ] as const)
          await db
            .update(schema.cliProviderSecrets)
            .set({ updatedAt: stamp })
            .where(
              and(
                eq(schema.cliProviderSecrets.providerId, rows[key].id),
                eq(schema.cliProviderSecrets.secretName, USAGE),
              ),
            );
        const res = await cloneOf('A');
        expect(res.status).toBe(201);
        const id = ((await res.json()) as { provider: { id: string } }).provider.id;
        const own = await plain(id, USAGE);
        expect(own === (await plain(rows.B.id, USAGE))).toBe(true);
        expect(own === (await plain(rows.A.id, USAGE))).toBe(false);
        expect((await cloneMetadata()).secretNames).toEqual(['ANTHROPIC_AUTH_TOKEN']);
      });

      it('a clone of a row with a legacy environment token takes the login of the set instead', async () => {
        await differ('B');
        await dropToken('A');
        await db
          .update(schema.cliProviders)
          .set({ envVars: { KEEP: 'yes', [TOKEN]: rnd() } })
          .where(eq(schema.cliProviders.id, rows.A.id));
        rows.A = await provider(rows.A.id);
        const res = await cloneOf('A');
        expect(res.status).toBe(201);
        const id = ((await res.json()) as { provider: { id: string } }).provider.id;
        const token = await plain(id, TOKEN);
        expect(token === (await plain(rows.B.id, TOKEN))).toBe(true);
        expect((await cloneMetadata()).secretNames).not.toContain(TOKEN);
        expect((await joinEvents()).map((a) => a.targetId)).toEqual([id]);
      });

      it('a clone of an isolated subscription row copies no token and takes no lock', async () => {
        const before = await outside(['A', 'B', 'D', 'E', 'F']);
        const releases = [await holdSet(), await holdSet('C')];
        let res: Response;
        try {
          res = await cloneOf('C');
        } finally {
          for (const release of releases) await release();
        }
        expect(res.status).toBe(201);
        const id = ((await res.json()) as { provider: { id: string } }).provider.id;
        expect(await plain(id, TOKEN)).toBeUndefined();
        for (const name of ['ANTHROPIC_AUTH_TOKEN'])
          expect((await plain(id, name)) === (await plain(rows.C.id, name)), name).toBe(true);
        expect((await cloneMetadata()).secretNames).toEqual(['ANTHROPIC_AUTH_TOKEN']);
        expect(await byAction(SET_ACTION)).toEqual([]);
        expect(await outside(['A', 'B', 'D', 'E', 'F'])).toEqual(before);
      });

      it('a clone of an isolated subscription row gets no usage connection', async () => {
        await seedGrants(['C']);
        const res = await cloneOf('C');
        expect(res.status).toBe(201);
        const id = ((await res.json()) as { provider: { id: string } }).provider.id;
        expect(await plain(id, USAGE)).toBeUndefined();
        expect((await cloneMetadata()).secretNames).toEqual(['ANTHROPIC_AUTH_TOKEN']);
      });

      it('a clone of an isolated row with a legacy environment token gets no token', async () => {
        await db
          .update(schema.cliProviders)
          .set({ envVars: { KEEP: 'yes', [TOKEN]: rnd() } })
          .where(eq(schema.cliProviders.id, rows.C.id));
        const res = await cloneOf('C');
        expect(res.status).toBe(201);
        const id = ((await res.json()) as { provider: { id: string } }).provider.id;
        expect(await plain(id, TOKEN)).toBeUndefined();
        expect((await cloneMetadata()).secretNames).not.toContain(TOKEN);
        expect(await byAction(SET_ACTION)).toEqual([]);
      });

      it('a clone of an API-key row copies every secret as before, the usage connection included', async () => {
        await seedGrants(['D']);
        const res = await cloneOf('D');
        expect(res.status).toBe(201);
        const id = ((await res.json()) as { provider: { id: string } }).provider.id;
        for (const name of [...NAMES, USAGE])
          expect((await plain(id, name)) === (await plain(rows.D.id, name)), name).toBe(true);
        expect((await cloneMetadata()).secretNames).toEqual([...NAMES, USAGE].sort());
        expect(await byAction(SET_ACTION)).toEqual([]);
      });

      it.each([
        ['an isolated row un-isolated', 'C', { isolateAuth: false }],
        ['an API-key row set to subscription', 'D', { authMode: 'subscription' }],
      ] as [string, Key, object][])(
        'a settings save of %s replaces its token and state with those of the set',
        async (_name, key, change) => {
          await differ('B');
          const own = await plain(rows[key].id, TOKEN);
          const rest = (['A', 'B', 'C', 'D', 'E', 'F'] as Key[]).filter((k) => k !== key);
          const before = await outside(rest);
          expect((await patch(key, change)).status).toBe(200);
          await expectJoined(rows[key].id, 'B', 3);
          expect((await plain(rows[key].id, TOKEN)) === own).toBe(false);
          expect((await byAction(SET_ACTION)).length).toBe(1);
          expect(await outside(rest)).toEqual(before);
        },
      );

      it.each([
        ['an isolated row un-isolated', 'C', { isolateAuth: false }],
        ['an API-key row set to subscription', 'D', { authMode: 'subscription' }],
      ] as [string, Key, object][])(
        'a settings save of %s that types a token is not seeded from the set',
        async (_name, key, change) => {
          await differ('B');
          const token = rnd();
          expect((await patch(key, { ...change, envVars: { [TOKEN]: token } })).status).toBe(200);
          expect(await joinEvents()).toEqual([]);
          await expectWritten(token, ['A', 'B', rows[key].id]);
        },
      );

      it.each([
        ['an isolated row un-isolated', 'C', { isolateAuth: false }],
        ['an API-key row set to subscription', 'D', { authMode: 'subscription' }],
      ] as [string, Key, object][])(
        'a settings save of %s keeps its own login when the set has none',
        async (_name, key, change) => {
          await dropToken('A');
          await dropToken('B');
          const own = await plain(rows[key].id, TOKEN);
          const res = await patch(key, change);
          expect(res.status).toBe(200);
          const answer = ((await res.json()) as { provider: Record<string, unknown> }).provider;
          expect([
            answer.authStatus,
            answer.authMessage,
            answer.authLastCheckedAt,
            answer.label,
          ]).toEqual([
            rows[key].authStatus,
            rows[key].authMessage,
            rows[key].authLastCheckedAt?.toISOString() ?? null,
            rows[key].label,
          ]);
          const p = await provider(rows[key].id);
          expect([p.authStatus, p.authMessage, p.authGeneration]).toEqual([
            rows[key].authStatus,
            rows[key].authMessage,
            rows[key].authGeneration,
          ]);
          expect((await plain(rows[key].id, TOKEN)) === own).toBe(true);
          expect(await byAction(SET_ACTION)).toEqual([]);
        },
      );

      it('a settings save that moves a row to API-key mode is not seeded from the API-key set', async () => {
        await differ('B');
        const own = await plain(rows.A.id, TOKEN);
        const rest = ['B', 'C', 'D', 'E', 'F'] as Key[];
        const before = await outside(rest);
        expect((await patch('A', { authMode: 'api_key' })).status).toBe(200);
        expect(await joinEvents()).toEqual([]);
        expect((await plain(rows.A.id, TOKEN)) === own).toBe(true);
        const p = await provider(rows.A.id);
        expect([p.authStatus, p.authMessage, p.authGeneration]).toEqual([
          rows.A.authStatus,
          rows.A.authMessage,
          rows.A.authGeneration,
        ]);
        expect(await outside(rest)).toEqual(before);
      });

      it('a settings save that keeps a row in its set does not seed it', async () => {
        await differ('B');
        const own = await plain(rows.A.id, TOKEN);
        const label = `kept-${rnd()}`;
        const res = await patch('A', { label, authMode: 'subscription', isolateAuth: false });
        expect(res.status).toBe(200);
        const answer = ((await res.json()) as { provider: Record<string, unknown> }).provider;
        expect([
          answer.authStatus,
          answer.authMessage,
          answer.authLastCheckedAt,
          answer.label,
        ]).toEqual([
          rows.A.authStatus,
          rows.A.authMessage,
          rows.A.authLastCheckedAt?.toISOString() ?? null,
          label,
        ]);
        expect(await joinEvents()).toEqual([]);
        expect((await plain(rows.A.id, TOKEN)) === own).toBe(true);
        const p = await provider(rows.A.id);
        expect(p.label).toBe(label);
        expect([p.authStatus, p.authMessage, p.authGeneration]).toEqual([
          rows.A.authStatus,
          rows.A.authMessage,
          rows.A.authGeneration,
        ]);
      });

      it.each([
        ['a created row', () => call('POST', '', createBody(null))],
        ['a cloned row', () => cloneOf('A')],
      ])('%s is refused as busy while the set is locked and changes nothing', async (_n, run) => {
        const before = await world();
        const release = await holdSet();
        try {
          const res = await run();
          expect(res.status).toBe(409);
          expect(((await res.json()) as { code?: string }).code).toBe('cli_auth_busy');
        } finally {
          await release();
        }
        expect(await world()).toEqual(before);
      });

      it.each([
        ['a created row', () => call('POST', '', createBody(null))],
        ['a cloned row', () => cloneOf('A')],
      ])(
        '%s is refused as busy once its wait has run out, and changes nothing',
        async (_n, run) => {
          const before = await world();
          h.joinWaitMs = 1000;
          const release = await holdSet();
          try {
            vi.useFakeTimers({ toFake: FAKE });
            const refusal = new Promise<void>((resolve) => {
              h.refused = resolve;
            });
            const pending = run();
            await refusal;
            await vi.advanceTimersByTimeAsync(1000);
            const res = await pending;
            expect(res.status).toBe(409);
            expect(((await res.json()) as { code?: string }).code).toBe('cli_auth_busy');
          } finally {
            vi.useRealTimers();
            await release();
          }
          expect(await world()).toEqual(before);
        },
      );

      it.each([
        ['a created row', () => call('POST', '', createBody(null))],
        ['a cloned row', () => cloneOf('A')],
      ])('%s waits for the set lock and joins once it is released', async (_n, run) => {
        await differ('B');
        h.joinWaitMs = 5000;
        const release = await holdSet();
        let released = false;
        try {
          vi.useFakeTimers({ toFake: FAKE });
          const refusal = new Promise<void>((resolve) => {
            h.refused = resolve;
          });
          const pending = run();
          // The first try was refused by the held lock, so the request is now waiting.
          await refusal;
          await release();
          released = true;
          await vi.advanceTimersByTimeAsync(500);
          const res = await pending;
          expect(res.status).toBe(201);
          const id = ((await res.json()) as { provider: { id: string } }).provider.id;
          await expectJoined(id, 'B', 3);
        } finally {
          vi.useRealTimers();
          if (!released) await release();
        }
      });

      it('a settings save is refused when its scope changed between the read and the lock', async () => {
        await differ('B');
        const before = await world();
        h.afterLock = async () => {
          await db
            .update(schema.cliProviders)
            .set({ isolateAuth: false })
            .where(eq(schema.cliProviders.id, rows.C.id));
        };
        const res = await patch('C', { isolateAuth: false });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { code?: string }).code).toBe('cli_auth_busy');
        expect(h.afterLock).toBeUndefined();
        const now = await world();
        const other = (p: Row) => p.id !== rows.C.id;
        expect(now.providers.filter(other)).toEqual(before.providers.filter(other));
        expect(now.secrets).toEqual(before.secrets);
        expect(now.audits).toEqual(before.audits);
        expect(await joinEvents()).toEqual([]);
        expect(h.log).not.toHaveBeenCalled();
      });
    });

    describe('when a write for another row of the set fails', () => {
      it.each([
        ['a pasted token', () => post('A', TOKEN, rnd())],
        [
          'a settings save',
          () => patch('A', { label: 'renamed', envVars: { KEEP: 'yes', [TOKEN]: rnd() } }),
        ],
        ['a created row', () => call('POST', '', createBody(rnd()))],
      ])('%s changes nothing when a sibling secret write is refused', async (_name, run) => {
        const before = await world();
        const drop = await refuseSecretWrites();
        try {
          expect((await run()).status).toBeGreaterThanOrEqual(400);
        } finally {
          await drop();
        }
        expect(await world()).toEqual(before);
        expect(h.log).not.toHaveBeenCalled();
      });

      it.each([
        ['a created row', () => call('POST', '', createBody(null))],
        ['a cloned row', () => cloneOf('A')],
        ['a settings save that joins a set', () => patch('C', { isolateAuth: false })],
      ])('%s changes nothing when the audit insert of its join is refused', async (_name, run) => {
        const before = await world();
        const drop = await refuseJoinAudit();
        try {
          expect((await run()).status).toBeGreaterThanOrEqual(400);
        } finally {
          await drop();
        }
        expect(await world()).toEqual(before);
        expect(h.log).not.toHaveBeenCalled();
      });

      it('a token delete changes nothing when a sibling secret delete is refused', async () => {
        const before = await world();
        const drop = await trigger(
          'cli_provider_secrets',
          'BEFORE DELETE',
          `IF OLD.provider_id = '${rows.B.id}'::uuid THEN RAISE EXCEPTION 'secret delete refused'; END IF;`,
          'OLD',
        );
        try {
          expect((await del('A', TOKEN)).status).toBeGreaterThanOrEqual(400);
        } finally {
          await drop();
        }
        expect(await world()).toEqual(before);
        expect(h.log).not.toHaveBeenCalled();
      });

      it.each([
        ['a pasted token', () => post('A', TOKEN, rnd())],
        ['a created row', () => call('POST', '', createBody(rnd()))],
        ['a token delete', () => del('A', TOKEN)],
      ])('%s changes nothing when a sibling audit insert is refused', async (_name, run) => {
        const before = await world();
        const drop = await refuseSiblingAudit();
        try {
          expect((await run()).status).toBeGreaterThanOrEqual(400);
        } finally {
          await drop();
        }
        expect(await world()).toEqual(before);
        expect(h.log).not.toHaveBeenCalled();
      });
    });

    describe('when the lock is lost during a write', () => {
      const paths: [string, number, () => Response | Promise<Response>][] = [
        ['a pasted token', 4, () => post('A', TOKEN, rnd())],
        ['a settings save', 5, () => patch('A', { envVars: { KEEP: 'yes', [TOKEN]: rnd() } })],
        ['a created row', 3, () => call('POST', '', createBody(rnd()))],
        ['a token delete', 2, () => del('A', TOKEN)],
        ['a created row without a token', 2, () => call('POST', '', createBody(null))],
        ['a cloned row', 2, () => cloneOf('A')],
        ['a settings save that joins a set', 8, () => patch('C', { isolateAuth: false })],
      ];
      it.each(paths)(
        '%s is refused and changes nothing at every check',
        async (_name, max, run) => {
          h.loseAt = Infinity;
          h.checks = 0;
          expect((await run()).status).toBeLessThan(300);
          expect(h.checks).toBeGreaterThanOrEqual(max);
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
            expect(await byAction(SET_ACTION), `check ${k}`).toEqual([]);
            expect(await byAction(DELETE_ACTION), `check ${k}`).toEqual([]);
          }
        },
      );
    });

    it('does not write the Claude token to a set of another CLI', async () => {
      const [other] = await db
        .insert(schema.cliProviders)
        .values({
          userId: U,
          name: 'codex',
          authMode: 'subscription',
          isolateAuth: false,
          label: 'G',
          authLastCheckedAt: PAST,
        })
        .returning();
      const before = await provider(other!.id);
      const res = await post('F', TOKEN, rnd());
      expect(res.status).toBeLessThan(300);
      expect(await secretRows([other!.id])).toEqual([]);
      expect(await provider(other!.id)).toEqual(before);
      expect((await byAction(SET_ACTION)).map((e) => e.targetId)).toEqual([rows.F.id]);
    });

    describe('when the set holds another CLI row with its own token', () => {
      it('a settings save on a codex row types the token for that row only', async () => {
        const g = await seedCodexSet();
        const beforeG = await snapshot([g.id]);
        const token = rnd();
        const res = await patch('F', { envVars: { [TOKEN]: token } });
        expect(res.status).toBe(200);
        expect((await plain(rows.F.id, TOKEN)) === token).toBe(true);
        expect(await snapshot([g.id])).toEqual(beforeG);
        expect((await setRowsFor([rows.F.id])).length).toBe(1);
        expect(await setRowsFor([g.id])).toEqual([]);
      });

      it('a created codex row types the token for that row only', async () => {
        const g = await seedCodexSet();
        const before = await snapshot([rows.F.id, g.id]);
        const token = rnd();
        const body = createBody(token, { name: 'codex' });
        const res = await call('POST', '', body);
        expect(res.status).toBe(201);
        const created = await findNew(body.label);
        expect((await plain(created.id, TOKEN)) === token).toBe(true);
        expect(await snapshot([rows.F.id, g.id])).toEqual(before);
        expect(await setRowsFor([rows.F.id, g.id])).toEqual([]);
      });

      it('a token delete on a codex row removes only that row token', async () => {
        const g = await seedCodexSet();
        const beforeG = await snapshot([g.id]);
        expect((await del('F', TOKEN)).status).toBe(200);
        expect(await plain(rows.F.id, TOKEN)).toBeUndefined();
        expect(await snapshot([g.id])).toEqual(beforeG);
        expect(await plain(g.id, TOKEN)).toBeDefined();
      });

      it('a token delete on a Claude row leaves the codex token alone', async () => {
        const g = await seedCodexSet();
        const before = await snapshot([rows.F.id, g.id]);
        expect((await del('A', TOKEN)).status).toBe(200);
        expect(await plain(rows.F.id, TOKEN)).toBeDefined();
        expect(await snapshot([rows.F.id, g.id])).toEqual(before);
      });
    });

    describe('when a created Claude row uses an API key', () => {
      it('writes its own set while the subscription set is locked', async () => {
        const before = await outside(['A', 'B', 'C', 'E', 'F']);
        const token = rnd();
        const body = createBody(token, { authMode: 'api_key' });
        const release = await holdSet();
        let res: Response;
        try {
          res = await call('POST', '', body);
        } finally {
          await release();
        }
        expect(res.status).toBe(201);
        await expectWritten(token, ['D', (await findNew(body.label)).id]);
        expect(await outside(['A', 'B', 'C', 'E', 'F'])).toEqual(before);
      });

      it('is refused as busy while its own set is locked', async () => {
        const before = await world();
        const release = await tryCliAuthLock(db, authState.cliAuthScope(rows.D));
        expect(release).not.toBeNull();
        try {
          const res = await call('POST', '', createBody(rnd(), { authMode: 'api_key' }));
          expect(res.status).toBe(409);
          expect(((await res.json()) as { code?: string }).code).toBe('cli_auth_busy');
        } finally {
          await release!();
        }
        expect(await world()).toEqual(before);
      });
    });

    it('an isolated created row takes no lock and is not refused while the set is held', async () => {
      const before = await outside(['A', 'B', 'C', 'D', 'E', 'F']);
      const token = rnd();
      const body = createBody(token, { isolateAuth: true });
      const release = await holdSet();
      let res: Response;
      try {
        res = await call('POST', '', body);
      } finally {
        await release();
      }
      expect(res.status).toBe(201);
      expect((await plain((await findNew(body.label)).id, TOKEN)) === token).toBe(true);
      expect(await outside(['A', 'B', 'C', 'D', 'E', 'F'])).toEqual(before);
    });

    describe('when the set is locked', () => {
      it.each([
        ['a pasted token', () => post('A', TOKEN, rnd())],
        ['a settings save', () => patch('A', { envVars: { KEEP: 'yes', [TOKEN]: rnd() } })],
        ['a token delete', () => del('A', TOKEN)],
      ])('%s is refused as busy and changes nothing', async (_name, run) => {
        const before = await world();
        const release = await holdSet();
        try {
          const res = await run();
          expect(res.status).toBe(409);
          expect(((await res.json()) as { code?: string }).code).toBe('cli_auth_busy');
        } finally {
          await release();
        }
        expect(await world()).toEqual(before);
      });

      it('a created row with a typed token is refused as busy while the set is locked', async () => {
        const before = await world();
        const release = await holdSet();
        try {
          const res = await call('POST', '', createBody(rnd()));
          expect(res.status).toBe(409);
          expect(((await res.json()) as { code?: string }).code).toBe('cli_auth_busy');
        } finally {
          await release();
        }
        expect(await world()).toEqual(before);
      });
    });

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
        // Insert order differs from id order, so a lock query without ORDER BY would take R3 first.
        for (const key of ['R3', 'R1', 'X', 'R2'] as const)
          await db.insert(schema.cliProviders).values({
            id: ids[key],
            userId: W,
            name: 'claude-code',
            authMode: 'subscription',
            isolateAuth: key === 'X',
            label: key,
            authLastCheckedAt: PAST,
          });
        for (const key of ['R1', 'R2'] as const)
          await upsertProviderSecret(db, {
            providerId: ids[key],
            name: TOKEN,
            value: rnd(),
            masterKek: KEK,
            onExisting: 'overwrite',
          });
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

      // A wait on database state, the exception the testing guide allows; the deadline is kept small.
      const waitUntil = async (condition: () => Promise<boolean>) => {
        const deadline = Date.now() + 5000;
        while (!(await condition())) {
          if (Date.now() > deadline)
            throw new Error('no backend was blocked by the peer within 5000 ms');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
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

      /** Starts `run` while a second connection holds `heldId`, and reports the rows of `probeIds` the request
       *  holds while it waits for the peer. The peer is always released. */
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
        try {
          response = Promise.resolve(run());
          await waitUntil(() => blockedBy(pid));
          held = await rowsHeld(probeIds);
        } finally {
          release();
          await peerRun;
          await response?.catch(() => undefined);
        }
        return { held, res: await response! };
      };

      const finish = async (W: string, body: () => Promise<void>) => {
        try {
          await body();
        } finally {
          h.actor = U;
          await cleanActor(db, W);
        }
      };

      it('a settings save typing the token through a later row holds none of the set before the lock', async () => {
        const { W, ids } = await seedW();
        await finish(W, async () => {
          const before = await provider(ids.X);
          const token = rnd();
          const { held, res } = await besideHolder(ids.R1, [ids.R2, ids.R3], () =>
            call('PATCH', `/${ids.R3}`, { envVars: { [TOKEN]: token } }),
          );
          expect(held).toEqual([]);
          expect(res.status).toBe(200);
          await expectWritten(token, [ids.R1, ids.R2, ids.R3]);
          expect(await plain(ids.X, TOKEN)).toBeUndefined();
          expect((await provider(ids.X)).authGeneration).toBe(before.authGeneration);
        });
      });

      it('a manual token write through a row without one holds none of the set before the lock', async () => {
        const { W, ids } = await seedW();
        await finish(W, async () => {
          const before = await provider(ids.X);
          const token = rnd();
          const { held, res } = await besideHolder(ids.R1, [ids.R2, ids.R3], () =>
            call('POST', `/${ids.R3}/secrets`, { secretName: TOKEN, value: token }),
          );
          expect(held).toEqual([]);
          expect(res.status).toBe(201);
          await expectWritten(token, [ids.R1, ids.R2, ids.R3]);
          expect(await plain(ids.X, TOKEN)).toBeUndefined();
          expect((await provider(ids.X)).authGeneration).toBe(before.authGeneration);
        });
      });

      /** R1 holds the oldest token, R2 the newest; R3 is the row that joins or is cloned. */
      const dateTokens = async (ids: Record<string, string>) => {
        for (const [key, at] of [
          ['R1', PAST],
          ['R2', new Date('2024-01-01T00:00:00Z')],
        ] as const)
          await db
            .update(schema.cliProviderSecrets)
            .set({ updatedAt: at })
            .where(
              and(
                eq(schema.cliProviderSecrets.providerId, ids[key]!),
                eq(schema.cliProviderSecrets.secretName, TOKEN),
              ),
            );
      };
      const expectSeededFrom = async (id: string, from: string) => {
        const token = await plain(id, TOKEN);
        expect(token).toBeDefined();
        expect(token === (await plain(from, TOKEN))).toBe(true);
        const [p, src] = await Promise.all([provider(id), provider(from)]);
        expect([p.authStatus, p.authMessage, p.authGeneration]).toEqual([
          src.authStatus,
          src.authMessage,
          src.authGeneration,
        ]);
        expect(await stampText(id)).toBe(await stampText(from));
      };

      it('a created row without a token holds none of the set before the lock', async () => {
        const { W, ids } = await seedW();
        await finish(W, async () => {
          await dateTokens(ids);
          const body = createBody(null);
          const { held, res } = await besideHolder(ids.R1, [ids.R2, ids.R3], () =>
            call('POST', '', body),
          );
          expect(held).toEqual([]);
          expect(res.status).toBe(201);
          const created = await db.query.cliProviders.findFirst({
            where: and(
              eq(schema.cliProviders.userId, W),
              eq(schema.cliProviders.label, body.label),
            ),
          });
          await expectSeededFrom(created!.id, ids.R2);
        });
      });

      it('a clone of a member holds none of the set before the lock', async () => {
        const { W, ids } = await seedW();
        await finish(W, async () => {
          await dateTokens(ids);
          const { held, res } = await besideHolder(ids.R1, [ids.R2, ids.R3], () =>
            call('POST', `/${ids.R3}/clone`),
          );
          expect(held).toEqual([]);
          expect(res.status).toBe(201);
          const cloneId = ((await res.json()) as { provider: { id: string } }).provider.id;
          await expectSeededFrom(cloneId, ids.R2);
        });
      });

      it('a settings save that joins through the highest id holds none of the set before the lock', async () => {
        const { W, ids } = await seedW();
        await finish(W, async () => {
          await dateTokens(ids);
          await db
            .update(schema.cliProviders)
            .set({ isolateAuth: true })
            .where(eq(schema.cliProviders.id, ids.R3));
          const { held, res } = await besideHolder(ids.R1, [ids.R2, ids.R3], () =>
            call('PATCH', `/${ids.R3}`, { isolateAuth: false }),
          );
          expect(held).toEqual([]);
          expect(res.status).toBe(200);
          await expectSeededFrom(ids.R3, ids.R2);
        });
      });

      it('a volume login generation change locks the set in id order', async () => {
        const { W, ids } = await seedW();
        await finish(W, async () => {
          const before = await Promise.all([ids.R1, ids.R2, ids.R3, ids.X].map(provider));
          const { held } = await besideHolder(ids.R1, [ids.R2, ids.R3], async () => {
            await authState.advanceVolumeLoginGeneration(db, before[0]!);
            return new Response();
          });
          expect(held).toEqual([]);
          const after = await Promise.all([ids.R1, ids.R2, ids.R3, ids.X].map(provider));
          expect(new Set(after.slice(0, 3).map((p) => p.authGeneration)).size).toBe(1);
          for (const [i, p] of after.slice(0, 3).entries())
            expect(p.authGeneration).not.toBe(before[i]!.authGeneration);
          expect(after[3]).toEqual(before[3]);
        });
      });

      it('a settings save that un-isolates a row locks that row with its new set', async () => {
        const { W, ids } = await seedW();
        await finish(W, async () => {
          const token = rnd();
          const { held, res } = await besideHolder(ids.X, [ids.R1, ids.R2, ids.R3], () =>
            call('PATCH', `/${ids.X}`, { isolateAuth: false, envVars: { [TOKEN]: token } }),
          );
          expect(held).toEqual([]);
          expect(res.status).toBe(200);
          await expectWritten(token, [ids.X, ids.R1, ids.R2, ids.R3]);
        });
      });
    });

    it('refuses locked rows that do not include the clicked row and writes nothing', async () => {
      const before = await world();
      await expect(
        db.transaction(async (tx) => {
          const members = await lockLoginSet(tx, rows.A);
          await writeLoginTokenToSet(tx, {
            userId: U,
            viaId: rows.C.id,
            members,
            source: 'manual',
            value: rnd(),
            masterKek: KEK,
            assertHeld: async () => {},
          });
        }),
      ).rejects.toThrow('Provider not found');
      expect(await world()).toEqual(before);
    });

    describe('a sign-out request', () => {
      const signOutMetadata = async (key: Key) =>
        (await audits(db)).find(
          (a) => a.action === 'cli_provider.sign_out' && a.targetId === rows[key].id,
        )!.metadata;

      it.each([
        ['a shared row', 'A', [['A', 'B']]],
        ['an isolated row', 'C', [['C']]],
      ] as [string, Key, Key[][]][])('names the set of %s', async (_name, key, [members]) => {
        const { res, payload } = await signOut(key);
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ jobId: 'job-id' });
        expect(payload).toEqual({
          providerId: rows[key].id,
          userId: U,
          authGeneration: rows[key].authGeneration,
        });
        const setIds = members!.map((k) => rows[k].id).sort();
        expect(await signOutMetadata(key)).toEqual({ setSize: setIds.length, setIds });
      });

      it('lists at most fifty ids of a larger set and never a secret', async () => {
        const W = (await makeActor(db)).id;
        try {
          const made = await db
            .insert(schema.cliProviders)
            .values(
              Array.from({ length: 55 }, (_, i) => ({
                userId: W,
                name: 'claude-code' as const,
                label: `w${i}`,
              })),
            )
            .returning({ id: schema.cliProviders.id });
          const sorted = made.map((r) => r.id).sort();
          h.actor = W;
          h.add.mockClear();
          const res = await call('POST', `/${made[7]!.id}/sign-out`);
          expect(res.status).toBe(202);
          const [event] = (await audits(db)).filter(
            (a) => a.actorUserId === W && a.action === 'cli_provider.sign_out',
          );
          expect(event!.metadata).toEqual({ setSize: 55, setIds: sorted.slice(0, 50) });
          expect(JSON.stringify(event!.metadata)).not.toMatch(/OAUTH|TOKEN|SECRET/i);
        } finally {
          h.actor = U;
          await cleanActor(db, W);
        }
      });

      it('is superseded when a sibling later receives a new token', async () => {
        const { payload } = await signOut('A');
        const token = rnd();
        expect((await post('B', TOKEN, token)).status).toBe(200);
        expect((await provider(rows.A.id)).authGeneration).not.toBe(payload.authGeneration);
        await expectWritten(token, ['A', 'B']);
      });

      it('stays current when a sibling later loses its token', async () => {
        const { payload } = await signOut('A');
        expect((await del('B', TOKEN)).status).toBe(200);
        expect((await provider(rows.A.id)).authGeneration).toBe(payload.authGeneration);
      });
    });

    it('keeps the token out of audit rows, audit calls, responses and error text', async () => {
      const seen: string[] = [];
      const tokens = [rnd(), rnd(), rnd(), rnd(), rnd()];
      const keep = async (res: Response) => void seen.push(await res.text());
      await keep(await post('A', TOKEN, tokens[0]!));
      await keep(await patch('B', { envVars: { KEEP: 'b', [TOKEN]: tokens[1]! } }));
      await keep(await call('POST', '', createBody(tokens[2]!)));
      for (const [refuse, run] of [
        [refuseSecretWrites, () => post('A', TOKEN, tokens[3]!)],
        [refuseSiblingAudit, () => post('A', TOKEN, tokens[4]!)],
      ] as const) {
        const drop = await refuse();
        try {
          await keep(await run());
        } finally {
          await drop();
        }
      }
      seen.push(
        JSON.stringify(await audits(db)),
        JSON.stringify([h.insert.mock.calls, h.log.mock.calls]),
      );
      for (const text of seen) for (const token of tokens) expect(text).not.toContain(token);
    });
  },
);

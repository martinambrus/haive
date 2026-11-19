import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { audits, cleanActor, createDatabase, KEK, makeActor, schema } from './security-audit-db.js';
import * as authState from '@haive/shared/cli-auth-state';

const url = process.env.CLI_SECRETS_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/cli_secrets_audit_test'))
  throw new Error('Use a dedicated cli_secrets_audit_test database');
const h = vi.hoisted(() => ({ insert: vi.fn(), log: vi.fn() }));
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
import { envelopeDecrypt, secretsService, upsertProviderSecret } from '@haive/shared';
import { saveCliLoginSecret } from '../src/lib/cli-login-secret.js';

const rnd = () => randomBytes(16).toString('hex');
const PAST = new Date('2020-01-01T00:00:00Z');
const NAMES = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USAGE_OAUTH', 'ANTHROPIC_AUTH_TOKEN'];

describe.skipIf(!url)('a Claude subscription login covers every row of its credential set', () => {
  let db: ReturnType<typeof createDatabase>;
  let U: string;
  let V: string;
  let rows: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F', typeof schema.cliProviders.$inferSelect>;
  let legacy: string;
  const ids = () => Object.values(rows).map((r) => r.id);
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
  const outside = async (keys: (keyof typeof rows)[]) => {
    const pids = keys.map((k) => rows[k].id);
    return {
      providers: await Promise.all(pids.map(provider)),
      secrets: await secretRows(pids),
      audits: (await audits(db)).filter((a) => pids.includes(a.targetId!)),
    };
  };
  const refuseAuditFor = async (actor: string) => {
    const fn = `refuse_set_login_${rnd()}`;
    await db.execute(
      sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.actor_user_id = '${actor}'::uuid THEN RAISE EXCEPTION 'audit insert refused'; END IF;
        RETURN NEW; END $$`),
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER ${fn} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
      ),
    );
    return () =>
      db
        .execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON audit_events`))
        .then(() => db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`)));
  };
  const asLogin = (id: string, token: string, assertActive?: () => void | Promise<void>) =>
    saveCliLoginSecret(db, U, id, token, assertActive);
  const expectSetCommitted = async (token: string) => {
    const [a, b] = [await provider(rows.A.id), await provider(rows.B.id)];
    for (const [key, p] of [
      ['A', a],
      ['B', b],
    ] as const) {
      expect((await plain(p.id, 'CLAUDE_CODE_OAUTH_TOKEN')) === token, key).toBe(true);
      expect(p.envVars, key).toEqual({ KEEP: 'yes' });
      expect(p.authGeneration, key).not.toBe(rows[key].authGeneration);
      expect([p.authStatus, p.authMessage], key).toEqual(['ok', 'authenticated']);
      expect(p.authLastCheckedAt!.getTime(), key).toBeGreaterThan(PAST.getTime());
    }
    expect(a.authGeneration).toBe(b.authGeneration);
  };
  beforeAll(() => {
    db = createDatabase(url!);
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    h.insert.mockClear();
    h.log.mockClear();
    vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
    U = (await makeActor(db)).id;
    V = (await makeActor(db)).id;
    legacy = rnd();
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
          authLastCheckedAt: PAST,
          envVars: 'AB'.includes(key) ? { CLAUDE_CODE_OAUTH_TOKEN: legacy, KEEP: 'yes' } : null,
        })
        .returning();
      made[key] = row;
      if (key !== 'F')
        for (const name of NAMES)
          await upsertProviderSecret(db, {
            providerId: row!.id,
            name,
            value: rnd(),
            masterKek: KEK,
            onExisting: 'overwrite',
          });
    }
    rows = made;
  });
  afterEach(async () => {
    await cleanActor(db, U);
    await cleanActor(db, V);
    vi.restoreAllMocks();
  });

  it('selects exactly the rows that share the credential namespace of a row', async () => {
    const extra = await db
      .insert(schema.cliProviders)
      .values([
        { userId: U, name: 'claude-code', label: 'C2', isolateAuth: true },
        { userId: U, name: 'claude-code', label: 'D2', authMode: 'api_key' },
        { userId: U, name: 'claude-code', label: 'D3', authMode: 'api_key' },
      ])
      .returning();
    const all = [...Object.values(rows), ...extra];
    for (const x of all) {
      const selected = await db
        .select({ id: schema.cliProviders.id })
        .from(schema.cliProviders)
        .where(
          and(
            inArray(
              schema.cliProviders.id,
              all.map((r) => r.id),
            ),
            authState.cliAuthSetWhere(x),
          ),
        );
      expect(selected.map((r) => r.id).sort(), x.label).toEqual(
        all
          .filter((r) => authState.cliAuthScope(r) === authState.cliAuthScope(x))
          .map((r) => r.id)
          .sort(),
      );
    }
  });

  it('writes the token, health and one audit row to every row of the set on login', async () => {
    const before = await outside(['C', 'D', 'E', 'F']);
    const keep = (await secretRows([rows.A.id, rows.B.id])).filter(
      (s) => s.secretName !== 'CLAUDE_CODE_OAUTH_TOKEN',
    );
    const token = rnd();
    await asLogin(rows.A.id, token);
    await expectSetCommitted(token);
    expect(
      (await secretRows([rows.A.id, rows.B.id])).filter(
        (s) => s.secretName !== 'CLAUDE_CODE_OAUTH_TOKEN',
      ),
    ).toEqual(keep);
    const set = (await audits(db)).filter(
      (a) => a.action === 'cli_provider.secret.set' && ids().includes(a.targetId!),
    );
    expect(set).toHaveLength(2);
    expect(set.map((a) => a.targetId).sort()).toEqual([rows.A.id, rows.B.id].sort());
    for (const a of set) {
      expect(a.actorUserId).toBe(U);
      expect(a.metadata).toEqual({
        source: 'login',
        secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
        viaProviderId: rows.A.id,
        setSize: 2,
      });
    }
    expect(await outside(['C', 'D', 'E', 'F'])).toEqual(before);
  });

  it('writes only the isolated row when it is the one that logs in', async () => {
    const before = await outside(['A', 'B', 'D', 'E', 'F']);
    const token = rnd();
    await asLogin(rows.C.id, token);
    expect((await plain(rows.C.id, 'CLAUDE_CODE_OAUTH_TOKEN')) === token).toBe(true);
    expect((await provider(rows.C.id)).authStatus).toBe('ok');
    expect((await audits(db)).filter((a) => a.actorUserId === U).map((a) => a.targetId)).toEqual([
      rows.C.id,
    ]);
    expect(await outside(['A', 'B', 'D', 'E', 'F'])).toEqual(before);
  });

  it('stamps every row of the set with a check later than one that is ahead of the clock', async () => {
    const ahead = new Date(Date.now() + 86_400_000);
    await db
      .update(schema.cliProviders)
      .set({ authLastCheckedAt: ahead })
      .where(inArray(schema.cliProviders.id, [rows.A.id, rows.B.id]));
    await asLogin(rows.A.id, rnd());
    // Date stops at milliseconds, so the database compares: a stamp from the clock would be a day earlier.
    for (const key of ['A', 'B'] as const) {
      const [r] = await db.$client`
        select auth_last_checked_at > ${ahead.toISOString()}::timestamp as later
        from cli_providers where id = ${rows[key].id}`;
      expect(r!.later, key).toBe(true);
    }
  });

  it('leaves everything untouched when the login stops at any step, and commits when it does not', async () => {
    const before = await world();
    const token = rnd();
    let threw = 0;
    for (let k = 1; k < 60; k += 1) {
      let calls = 0;
      try {
        await asLogin(rows.A.id, token, () => {
          calls += 1;
          if (calls === k) throw new Error(`stop at ${k}`);
        });
      } catch {
        threw += 1;
        expect(await world(), `stop at call ${k}`).toEqual(before);
        continue;
      }
      expect(calls).toBeLessThan(k);
      break;
    }
    // Pre-transaction check, clicked read, set lock, two per row for the two-row set, final check.
    expect(threw).toBeGreaterThanOrEqual(8);
    await expectSetCommitted(token);
  });

  it('rejects a login whose audit insert is refused and changes nothing', async () => {
    const before = await world();
    const drop = await refuseAuditFor(U);
    try {
      await expect(asLogin(rows.A.id, rnd())).rejects.toThrow();
    } finally {
      await drop();
    }
    expect(await world()).toEqual(before);
  });

  it('keeps the token out of audit rows, audit calls and error text', async () => {
    const seen: string[] = [];
    const token = rnd();
    await asLogin(rows.A.id, token);
    seen.push(JSON.stringify(await audits(db)));
    const drop = await refuseAuditFor(U);
    const refused = rnd();
    try {
      const err: any = await asLogin(rows.B.id, refused).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      for (let e = err; e; e = e.cause) seen.push(String(e.message), String(e.stack));
    } finally {
      await drop();
    }
    seen.push(
      JSON.stringify(await audits(db)),
      JSON.stringify([h.insert.mock.calls, h.log.mock.calls]),
    );
    for (const text of seen) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(refused);
    }
  });
});

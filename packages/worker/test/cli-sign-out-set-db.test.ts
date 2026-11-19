import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { createDatabase, schema } from '@haive/database';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
import {
  envelopeDecrypt,
  resolveCliAuthUserVolumeName,
  secretsService,
  upsertProviderSecret,
} from '@haive/shared';
import { handleSignOutJob } from '../src/queues/cli-exec/handlers.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

const url = process.env.CLI_SIGN_OUT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/cli_secrets_audit_test'))
  throw new Error('Use a dedicated test database');
const KEK = 'ab'.repeat(32);
const PAST = new Date('2020-01-01T00:00:00Z');
const NAMES = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USAGE_OAUTH', 'ANTHROPIC_AUTH_TOKEN'];
const rnd = () => randomBytes(16).toString('hex');
type Row = typeof schema.cliProviders.$inferSelect;
type Key = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

describe.skipIf(!url)('a Claude sign-out covers every row of its credential set', () => {
  let db: ReturnType<typeof createDatabase>;
  let U: string;
  let V: string;
  let rows: Record<Key, Row>;
  const ids = () => Object.values(rows).map((r) => r.id);
  const provider = (id: string) =>
    db.query.cliProviders.findFirst({ where: eq(schema.cliProviders.id, id) }).then((r) => r!);
  const secretRows = (pids: string[]) =>
    db
      .select()
      .from(schema.cliProviderSecrets)
      .where(inArray(schema.cliProviderSecrets.providerId, pids))
      .orderBy(asc(schema.cliProviderSecrets.id));
  const names = async (id: string) => (await secretRows([id])).map((s) => s.secretName).sort();
  const world = async () => ({
    providers: await db
      .select()
      .from(schema.cliProviders)
      .where(inArray(schema.cliProviders.userId, [U, V]))
      .orderBy(asc(schema.cliProviders.id)),
    secrets: await secretRows(ids()),
  });
  const outside = async (keys: Key[]) => {
    const pids = keys.map((k) => rows[k].id);
    return { providers: await Promise.all(pids.map(provider)), secrets: await secretRows(pids) };
  };
  const volumeNames = (r: Row) =>
    [0, 1].map((i) =>
      resolveCliAuthUserVolumeName(
        {
          userId: r.userId,
          providerId: r.id,
          providerName: r.name,
          authMode: r.authMode,
          isolateAuth: r.isolateAuth,
        },
        i,
      ),
    );
  const fakeRunner = (
    via: Row,
    remove?: (name: string) => Promise<{ ok: boolean; stderr: string }>,
  ) => {
    const volumes = new Set(volumeNames(via));
    const runner = {
      volumeExists: async (n: string) => volumes.has(n),
      volumeRemove:
        remove ??
        (async (n: string) => {
          volumes.delete(n);
          return { ok: true, stderr: '' };
        }),
    } as unknown as DockerRunner;
    return { volumes, runner };
  };
  const payload = (r: Row) => ({ providerId: r.id, userId: U });
  const resumeJob = (r: Row) =>
    ({
      data: { signOutStarted: true, signOutScope: cliAuthScope(r) },
      updateData: async () => {},
      token: 'x',
      moveToDelayed: async () => {},
    }) as any;
  const expectSetSignedOut = async (after: Date) => {
    expect(await names(rows.A.id)).toEqual(['ANTHROPIC_AUTH_TOKEN']);
    expect(await names(rows.B.id)).toEqual(['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_USAGE_OAUTH']);
    for (const key of ['A', 'B'] as const) {
      const p = await provider(rows[key].id);
      expect([p.authStatus, p.authMessage], key).toEqual(['unknown', null]);
      expect(p.authLastCheckedAt!.getTime(), key).toBeGreaterThan(after.getTime());
    }
  };
  const trigger = async (table: string, when: string, body: string) => {
    const fn = `sign_out_set_${rnd()}`;
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
  const insertRow = async (userId: string, label: string, token: boolean) => {
    const [row] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'claude-code',
        label,
        authStatus: 'ok',
        authMessage: 'authenticated',
        authLastCheckedAt: PAST,
      })
      .returning();
    if (token)
      await upsertProviderSecret(db, {
        providerId: row!.id,
        name: 'CLAUDE_CODE_OAUTH_TOKEN',
        value: rnd(),
        masterKek: KEK,
        onExisting: 'overwrite',
      });
    return row!;
  };
  beforeAll(() => {
    db = createDatabase(url!);
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
    const users = await db
      .insert(schema.users)
      .values(
        [1, 2].map(() => ({ emailEncrypted: rnd(), emailBlindIndex: rnd(), passwordHash: 'x' })),
      )
      .returning();
    [U, V] = [users[0]!.id, users[1]!.id];
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
          envVars: 'AB'.includes(key) ? { CLAUDE_CODE_OAUTH_TOKEN: rnd(), KEEP: 'yes' } : null,
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
    vi.restoreAllMocks();
    await db.delete(schema.users).where(inArray(schema.users.id, [U, V]));
  });

  it('removes the tokens and resets the health of every row of the set', async () => {
    const before = await outside(['C', 'D', 'E', 'F']);
    const bUsage = (await secretRows([rows.B.id])).filter(
      (s) => s.secretName === 'CLAUDE_USAGE_OAUTH',
    );
    const { volumes, runner } = fakeRunner(rows.A);
    expect(await handleSignOutJob(db, payload(rows.A), runner)).toMatchObject({ ok: true });
    expect(volumes.size).toBe(0);
    await expectSetSignedOut(PAST);
    expect(
      (await secretRows([rows.B.id])).filter((s) => s.secretName === 'CLAUDE_USAGE_OAUTH'),
    ).toEqual(bUsage);
    expect(await outside(['C', 'D', 'E', 'F'])).toEqual(before);
  });

  it('touches only the isolated row when it is the one that signs out', async () => {
    const before = await outside(['A', 'B', 'D', 'E', 'F']);
    const { runner } = fakeRunner(rows.C);
    expect(await handleSignOutJob(db, payload(rows.C), runner)).toMatchObject({ ok: true });
    expect(await names(rows.C.id)).toEqual(['ANTHROPIC_AUTH_TOKEN']);
    const c = await provider(rows.C.id);
    expect([c.authStatus, c.authMessage]).toEqual(['unknown', null]);
    expect(await outside(['A', 'B', 'D', 'E', 'F'])).toEqual(before);
  });

  it('deletes the tokens of the set but keeps its health when a volume cannot be removed', async () => {
    const before = await outside(['A', 'B']);
    const { runner } = fakeRunner(rows.A, async () => ({ ok: false, stderr: 'busy' }));
    const real = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: any, ms?: number, ...a: any[]) =>
        real(fn, [1000, 2000, 4000, 8000, 16000].includes(ms ?? 0) ? 0 : ms, ...a)) as any);
    try {
      expect(await handleSignOutJob(db, payload(rows.A), runner)).toMatchObject({ ok: false });
    } finally {
      spy.mockRestore();
    }
    expect(await names(rows.A.id)).toEqual(['ANTHROPIC_AUTH_TOKEN']);
    expect(await names(rows.B.id)).toEqual(['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_USAGE_OAUTH']);
    expect((await outside(['A', 'B'])).providers).toEqual(before.providers);
  });

  it('resumes an interrupted sign-out to the same end state, then repeats it', async () => {
    const before = await world();
    const scope = cliAuthScope(rows.A);
    const { volumes, runner } = fakeRunner(rows.A, async (n) => {
      volumes.delete(n);
      const [holder] = await db.$client`
        select pid from pg_locks where locktype = 'advisory'
        and classid = ((hashtextextended(${`cli-auth:${scope}`}, 0) >> 32) & 4294967295)::oid
        and objid = (hashtextextended(${`cli-auth:${scope}`}, 0) & 4294967295)::oid`;
      await db.$client`select pg_terminate_backend(${holder!.pid})`;
      return { ok: true, stderr: '' };
    });
    await expect(handleSignOutJob(db, payload(rows.A), runner)).rejects.toThrow();
    expect(volumes.size).toBe(1);
    expect(await world()).toEqual(before);
    const resumed = fakeRunner(rows.A, undefined);
    resumed.volumes.clear();
    await handleSignOutJob(db, payload(rows.A), resumed.runner, resumeJob(rows.A));
    await expectSetSignedOut(PAST);
    const stamp = (await provider(rows.A.id)).authLastCheckedAt!;
    await handleSignOutJob(db, payload(rows.A), resumed.runner, resumeJob(rows.A));
    await expectSetSignedOut(stamp);
  });

  it('signs out a row that joins the set while the volume is being removed', async () => {
    let g: Row | undefined;
    const { runner } = fakeRunner(rows.A, async () => {
      g ??= await insertRow(U, 'G', true);
      return { ok: true, stderr: '' };
    });
    await handleSignOutJob(db, payload(rows.A), runner);
    expect(await names(g!.id)).toEqual([]);
    const after = await provider(g!.id);
    expect([after.authStatus, after.authMessage]).toEqual(['unknown', null]);
  });

  it('keeps the tokens of the set when the health update is refused', async () => {
    const drop = await trigger(
      'cli_providers',
      'BEFORE UPDATE',
      `IF NEW.user_id = '${U}'::uuid THEN RAISE EXCEPTION 'update refused'; END IF;`,
    );
    const { runner } = fakeRunner(rows.A);
    try {
      await expect(handleSignOutJob(db, payload(rows.A), runner)).rejects.toThrow();
    } finally {
      await drop();
    }
    expect(await names(rows.A.id)).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(await names(rows.B.id)).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('does nothing when a sibling write gave the set a newer login than the request saw', async () => {
    const fresh = rnd();
    const generation = randomUUID();
    for (const key of ['A', 'B'] as const) {
      await upsertProviderSecret(db, {
        providerId: rows[key].id,
        name: 'CLAUDE_CODE_OAUTH_TOKEN',
        value: fresh,
        masterKek: KEK,
        onExisting: 'overwrite',
      });
    }
    await db
      .update(schema.cliProviders)
      .set({ authGeneration: generation })
      .where(inArray(schema.cliProviders.id, [rows.A.id, rows.B.id]));
    const statuses = (await outside(['A', 'B'])).providers.map((p) => [
      p.authStatus,
      p.authMessage,
    ]);
    const { volumes, runner } = fakeRunner(rows.A);
    const result = await handleSignOutJob(
      db,
      { ...payload(rows.A), authGeneration: rows.A.authGeneration },
      runner,
    );
    expect(result).toMatchObject({ ok: true, superseded: true });
    expect(volumes.size).toBe(2);
    for (const key of ['A', 'B'] as const) {
      const [s] = (await secretRows([rows[key].id])).filter(
        (r) => r.secretName === 'CLAUDE_CODE_OAUTH_TOKEN',
      );
      expect(s && envelopeDecrypt(s, KEK) === fresh, key).toBe(true);
    }
    const after = (await outside(['A', 'B'])).providers;
    expect(after.map((p) => [p.authStatus, p.authMessage])).toEqual(statuses);
    expect(after.map((p) => p.authGeneration)).toEqual([generation, generation]);
  });
});

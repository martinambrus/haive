import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  allowAudit,
  audits,
  cleanActor,
  createDatabase,
  KEK,
  makeActor,
  refuseAudit,
  schema,
} from './security-audit-db.js';
const url = process.env.SECURITY_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/t376_audit_test'))
  throw new Error('Use a dedicated t376_audit_test database');
const h = vi.hoisted(() => ({
  db: undefined as any,
  actor: '',
  exchange: vi.fn(),
  poll: vi.fn(),
  stash: '',
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: any, next: any) => {
    c.set('userId', h.actor);
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({
  getUsagePollQueue: () => ({ add: h.poll }),
  getCliExecQueue: () => ({ add: vi.fn(async () => ({})) }),
}));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ eval: async () => h.stash }) }));
vi.mock('@haive/shared/claude-oauth', async (original) => ({
  ...(await original<any>()),
  exchangeClaudeAuthCode: h.exchange,
}));
import { configService, secretsService } from '@haive/shared';
import { saveCliLoginSecret } from '../src/lib/cli-login-secret.js';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

describe.skipIf(!url)('CLI secrets commit with their audit, on Postgres', () => {
  let db: ReturnType<typeof createDatabase>;
  let provider: string;
  const app = new Hono<AppEnv>().onError(errorHandler).route('/cli-providers', cliProviderRoutes);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`/cli-providers/${provider}/${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const secrets = () =>
    db
      .select()
      .from(schema.cliProviderSecrets)
      .where(eq(schema.cliProviderSecrets.providerId, provider));
  beforeAll(() => {
    db = createDatabase(url!);
    h.db = db;
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    h.actor = (await makeActor(db)).id;
    vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    const [row] = await db
      .insert(schema.cliProviders)
      .values({ userId: h.actor, name: 'claude-code', label: 'test' })
      .returning();
    provider = row!.id;
    h.exchange.mockReset().mockResolvedValue({
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      scopes: ['user:profile'],
      expiresAt: Date.now() + 10000,
    });
    h.stash = JSON.stringify({ verifier: 'synthetic-verifier', state: 'state' });
    h.poll.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await allowAudit(db);
    await cleanActor(db, h.actor);
    vi.restoreAllMocks();
  });
  for (const refused of [false, true])
    it(`no-op usage disconnect ${refused ? 'with refusing audit' : 'without token'} returns disconnected without a deletion row`, async () => {
      if (refused) await refuseAudit(db);
      const res = await send('DELETE', 'usage-auth');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ connected: false });
      expect(await audits(db)).toEqual([]);
      expect((await send('DELETE', 'usage-auth')).status).toBe(200);
      expect(await audits(db)).toEqual([]);
    });
  const cases = [
    ['set', 'POST', 'secrets', { secretName: 'API_KEY', value: 'synthetic-secret' }],
    ['usage connect', 'POST', 'usage-auth/complete', { code: 'code#state' }],
    ['delete', 'DELETE', 'secrets/API_KEY', undefined],
    ['usage disconnect', 'DELETE', 'usage-auth', undefined],
  ] as const;
  for (const [label, method, path, body] of cases) {
    for (const refuse of [false, true])
      it(`${label}: ${refuse ? 'audit refusal rolls back and fails' : 'success writes one safe audit'}`, async () => {
        if (label === 'delete' || label === 'usage disconnect')
          await db.insert(schema.cliProviderSecrets).values({
            providerId: provider,
            secretName: label === 'delete' ? 'API_KEY' : 'CLAUDE_USAGE_OAUTH',
            encryptedValue: 'before',
            encryptedDek: 'before',
          });
        const before = await secrets();
        if (refuse) await refuseAudit(db);
        const res = await send(method, path, body);
        expect(res.status).toBe(refuse ? 500 : label === 'set' ? 201 : 200);
        if (refuse) expect(await secrets()).toEqual(before);
        const rows = await audits(db);
        expect(rows).toHaveLength(refuse ? 0 : 1);
        if (!refuse) {
          expect(rows[0]).toMatchObject({
            actorUserId: h.actor,
            targetId: provider,
            targetType: 'cli_provider',
          });
          expect(JSON.stringify(rows)).not.toContain('synthetic-');
        }
        if (label === 'usage connect' && refuse) expect(h.exchange).not.toHaveBeenCalled();
      });
  }
  for (const refused of [false, true]) {
    for (const operation of ['create', 'patch', 'clone', 'provider-delete'] as const)
      it(`${operation}: ${refused ? 'audit refusal undoes secrets and provider change' : 'commits safe audit'}`, async () => {
        await db.insert(schema.cliProviderSecrets).values({
          providerId: provider,
          secretName: 'API_KEY',
          encryptedValue: 'before',
          encryptedDek: 'before',
        });
        const before = await db.select().from(schema.cliProviders);
        const beforeSecrets = await secrets();
        if (refused) await refuseAudit(db);
        const envVars = { ANTHROPIC_API_KEY: 'synthetic-secret' };
        const res = await app.request(
          operation === 'create'
            ? '/cli-providers'
            : `/cli-providers/${provider}${operation === 'clone' ? '/clone' : ''}`,
          {
            method:
              operation === 'patch' ? 'PATCH' : operation === 'provider-delete' ? 'DELETE' : 'POST',
            headers: { 'content-type': 'application/json' },
            body:
              operation === 'provider-delete' || operation === 'clone'
                ? undefined
                : JSON.stringify(
                    operation === 'create'
                      ? { name: 'claude-code', label: 'created', authMode: 'api_key', envVars }
                      : { envVars },
                  ),
          },
        );
        expect(res.status).toBe(
          refused ? 500 : operation === 'clone' || operation === 'create' ? 201 : 200,
        );
        expect(await audits(db)).toHaveLength(refused ? 0 : 1);
        if (refused) {
          expect(await db.select().from(schema.cliProviders)).toEqual(before);
          expect(await secrets()).toEqual(beforeSecrets);
        }
      });
    it(`captured login token: ${refused ? 'refusal keeps prior secret and legacy environment' : 'commits token, scrub and audit together'}`, async () => {
      await db
        .update(schema.cliProviders)
        .set({ envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'legacy-token', KEEP: 'yes' } })
        .where(eq(schema.cliProviders.id, provider));
      const before = await db.query.cliProviders.findFirst({
        where: eq(schema.cliProviders.id, provider),
      });
      if (refused) await refuseAudit(db);
      const save = saveCliLoginSecret(db, h.actor, provider, 'synthetic-token');
      if (refused) {
        await expect(save).rejects.toThrow();
        expect(await secrets()).toEqual([]);
        expect(
          await db.query.cliProviders.findFirst({ where: eq(schema.cliProviders.id, provider) }),
        ).toEqual(before);
      } else {
        await save;
        expect(await secrets()).toHaveLength(1);
        expect(
          (await db.query.cliProviders.findFirst({ where: eq(schema.cliProviders.id, provider) }))!
            .envVars,
        ).toEqual({ KEEP: 'yes' });
      }
      expect(await audits(db)).toHaveLength(refused ? 0 : 1);
    });
  }
  it('a refused vendor exchange rolls back the audit and leaves no token', async () => {
    h.exchange.mockRejectedValue(new Error('vendor refused'));
    const res = await send('POST', 'usage-auth/complete', { code: 'code#state' });
    expect(res.status).toBe(400);
    expect(await secrets()).toEqual([]);
    expect(await audits(db)).toEqual([]);
    expect(h.poll).not.toHaveBeenCalled();
  });
  it('a captured login preserves concurrent environment edits', async () => {
    await db
      .update(schema.cliProviders)
      .set({ envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'legacy-token', KEEP: 'before' } })
      .where(eq(schema.cliProviders.id, provider));
    let read!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      read = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Pause at the audit insert, immediately after the legacy environment was read.
    const captureDb = new Proxy(db, {
      get(target, key) {
        if (key === 'transaction')
          return (fn: (tx: any) => Promise<unknown>) =>
            target.transaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(t, prop) {
                    if (prop === 'insert')
                      return (table: any) => {
                        const builder = t.insert(table);
                        if (table === schema.auditEvents)
                          return {
                            values: async (values: any) => {
                              read();
                              await resume;
                              return builder.values(values);
                            },
                          };
                        return builder;
                      };
                    const value = Reflect.get(t, prop);
                    return typeof value === 'function' ? value.bind(t) : value;
                  },
                }),
              ),
            );
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const save = saveCliLoginSecret(captureDb, h.actor, provider, 'synthetic-token');
    await reached;
    const patch = Promise.resolve(
      app.request(`/cli-providers/${provider}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envVars: { KEEP: 'next', ANTHROPIC_API_KEY: 'synthetic-key' } }),
      }),
    );
    let patchFinished = false;
    void patch.then(() => {
      patchFinished = true;
    });
    try {
      // With the lock, PATCH waits on the captured read. Without it, PATCH commits first.
      for (let i = 0; i < 200 && !patchFinished; i++) {
        const waiting = await db.execute(
          sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'update "cli_providers"%'`,
        );
        if (waiting.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (i === 199) throw new Error('PATCH neither completed nor waited on the provider lock');
      }
    } finally {
      release();
    }
    await save;
    expect((await patch).status).toBe(200);
    expect(
      (await db.query.cliProviders.findFirst({ where: eq(schema.cliProviders.id, provider) }))!
        .envVars,
    ).toEqual({ KEEP: 'next' });
    expect(await secrets()).toHaveLength(2);
    expect(await audits(db)).toHaveLength(2);
  });
});

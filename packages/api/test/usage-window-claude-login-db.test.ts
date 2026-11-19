import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { cleanActor, createDatabase, makeActor, schema } from './security-audit-db.js';

const url = process.env.CLI_SECRETS_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/cli_secrets_audit_test'))
  throw new Error('Use a dedicated cli_secrets_audit_test database');
const h = vi.hoisted(() => ({ db: undefined as any, actor: '' }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: any, next: any) => {
    c.set('userId', h.actor);
    await next();
  },
}));
import { configService } from '@haive/shared';
import { usageWindowRoutes } from '../src/routes/usage-window.js';
import type { AppEnv } from '../src/context.js';

describe.skipIf(!url)('usage snapshots after a Claude login, on Postgres', () => {
  let db: ReturnType<typeof createDatabase>;
  const ids: Record<string, string> = {};
  const app = new Hono<AppEnv>().route('/usage-window', usageWindowRoutes);
  const statusOf = async (providerId: string) => {
    const body: any = await (await app.request('/usage-window')).json();
    return body.snapshots.find((s: any) => s.providerId === providerId)?.status;
  };
  beforeAll(() => {
    db = createDatabase(url!);
    h.db = db;
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    h.actor = (await makeActor(db)).id;
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    vi.spyOn(configService, 'getNumber').mockResolvedValue(10);
    for (const name of ['claude-code', 'codex'] as const) {
      const [row] = await db
        .insert(schema.cliProviders)
        .values({
          userId: h.actor,
          name,
          label: name,
          authStatus: 'ok',
          authLastCheckedAt: new Date(),
        })
        .returning();
      ids[name] = row!.id;
      await db.insert(schema.usageWindowSnapshots).values({
        providerId: row!.id,
        userId: h.actor,
        providerName: name,
        status: 'needs_reconnect',
        fetchedAt: new Date(Date.now() - 60_000),
      });
    }
  });
  afterEach(async () => {
    await cleanActor(db, h.actor);
    vi.restoreAllMocks();
  });

  it('keeps a Claude snapshot at needs_reconnect although its CLI login checked ok', async () => {
    expect(await statusOf(ids['claude-code']!)).toBe('needs_reconnect');
  });

  it('shows a codex snapshot as pending after its login checked ok', async () => {
    expect(await statusOf(ids['codex']!)).toBe('pending');
  });
});

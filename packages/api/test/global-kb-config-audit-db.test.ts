import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.GLOBAL_KB_CONFIG_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/global_kb_config_audit_test'))
  throw new Error(
    'Use a dedicated global_kb_config_audit_test database for the global KB audit tests',
  );

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'fatal';
  return { db: undefined as unknown, gdb: undefined as unknown, userId: '' };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getGlobalKbSyncQueue: vi.fn(), getTaskQueue: vi.fn() }));
vi.mock('../src/lib/task-start.js', () => ({
  enqueueStart: vi.fn(async () => {}),
  markQueuedForStart: async () => true,
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', h.userId);
    c.set('userRole', 'admin');
    await next();
  },
}));

vi.mock('@haive/shared/global-kb', async (original) => ({
  ...(await original<typeof import('@haive/shared/global-kb')>()),
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
    fn({ db: h.gdb, settings: { namespace: 'default' } }),
}));

import postgres from 'postgres';
import {
  createGlobalKbDb,
  ensureGlobalKbSchema,
  globalKbEntries,
  houseRuleContentToken,
} from '@haive/shared/global-kb';
import { Hono } from 'hono';
import {
  CONFIG_KEYS,
  SECRET_KEYS,
  configService,
  generateEncryptionKey,
  secretsService,
} from '@haive/shared';
import { globalKbRoutes } from '../src/routes/global-kb.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const OLD = 'postgres://olduser:oldpass@old-host.example:5432/kb';
const NEW = 'postgres://newuser:newpass@new-host.example:5432/kb';
const STRING_ACTION = 'global_kb.connection_string.update';
const CONFIG_ACTION = 'config.global_kb';
const SECRET_KEY = SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING;

const redisValues = new Map<string, string>();
let redisWrites = 0;
let failOnWrite: number | null = null;
const redis = {
  get: async (name: string) => redisValues.get(name) ?? null,
  set: async (name: string, value: string) => {
    redisWrites += 1;
    if (redisWrites === failOnWrite) throw new Error('redis is down');
    redisValues.set(name, value);
    return 'OK';
  },
};

const refuseAudit = async (db: Database, actions: string[]) => {
  await db.execute(
    sql.raw(
      "CREATE OR REPLACE FUNCTION refuse_gkb_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_NARGS = 0 OR NEW.action = ANY (TG_ARGV) THEN RAISE EXCEPTION 'audit insert refused'; END IF; RETURN NEW; END $$;",
    ),
  );
  const args = actions.map((a) => `'${a}'`).join(', ');
  await db.execute(
    sql.raw(
      `CREATE TRIGGER refuse_gkb_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_gkb_audit(${args});`,
    ),
  );
};
const refuseSecret = async (db: Database) => {
  await db.execute(
    sql.raw(
      `CREATE OR REPLACE FUNCTION refuse_gkb_secret() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (TG_OP = 'DELETE' AND OLD.key = '${SECRET_KEY}') OR (TG_OP <> 'DELETE' AND NEW.key = '${SECRET_KEY}') THEN RAISE EXCEPTION 'secret write refused'; END IF; IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;`,
    ),
  );
  await db.execute(
    sql.raw(
      'CREATE TRIGGER refuse_gkb_secret BEFORE INSERT OR UPDATE OR DELETE ON system_secrets FOR EACH ROW EXECUTE FUNCTION refuse_gkb_secret();',
    ),
  );
};
const refuseAuditAtCommit = async (db: Database) => {
  await db.execute(
    sql.raw(
      "CREATE OR REPLACE FUNCTION refuse_gkb_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit refused'; END $$;",
    ),
  );
  await db.execute(
    sql.raw(
      'CREATE CONSTRAINT TRIGGER refuse_gkb_commit AFTER INSERT ON audit_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_gkb_commit();',
    ),
  );
};
const dropTriggers = async (db: Database) => {
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS refuse_gkb_commit ON audit_events;'));
  await db.execute(sql.raw('DROP FUNCTION IF EXISTS refuse_gkb_commit();'));
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS refuse_gkb_audit ON audit_events;'));
  await db.execute(sql.raw('DROP FUNCTION IF EXISTS refuse_gkb_audit();'));
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS refuse_gkb_secret ON system_secrets;'));
  await db.execute(sql.raw('DROP FUNCTION IF EXISTS refuse_gkb_secret();'));
};

describe.skipIf(!url)('global KB config and enforcement write audit rows first on Postgres', () => {
  let db: Database;
  let app: Hono<AppEnv>;
  let store: ReturnType<typeof postgres>;
  let storeDb: ReturnType<typeof createGlobalKbDb>;
  const storeName = `global_kb_config_audit_test_store_${randomUUID().replaceAll('-', '')}`;
  let storeCreated = false;
  let entryId: string;

  const enforcement = async (method: 'PUT' | 'DELETE') => {
    const [row] = await storeDb
      .select()
      .from(globalKbEntries)
      .where(eq(globalKbEntries.id, entryId));
    return app.request(`/global-kb/entries/${entryId}/enforcement`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'PUT'
        ? {
            body: JSON.stringify({
              mode: 'files',
              globs: ['src/**/*.ts'],
              expectedHash: houseRuleContentToken(row!),
            }),
          }
        : {}),
    });
  };

  const put = (body: unknown) =>
    app.request('/global-kb/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const storedSecret = async () => {
    secretsService.clearCache();
    return secretsService.get(SECRET_KEY);
  };
  const setSecretDirectly = async (value: string) => {
    await secretsService.set(SECRET_KEY, value, 'test');
    secretsService.clearCache();
  };
  const rows = () =>
    db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.actorUserId, h.userId))
      .orderBy(asc(schema.auditEvents.createdAt));
  const rowsOf = async (action: string) => (await rows()).filter((r) => r.action === action);

  const armExternalWithOld = async () => {
    redisValues.set(CONFIG_KEYS.GLOBAL_KB_MODE, 'external');
    await setSecretDirectly(OLD);
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await dropTriggers(db);
    await db.execute(sql.raw(`CREATE DATABASE "${storeName}"`));
    storeCreated = true;
    const storeUrl = new URL(url!);
    storeUrl.pathname = `/${storeName}`;
    store = postgres(storeUrl.toString());
    await ensureGlobalKbSchema({ pg: store, embeddingDimensions: 3 });
    storeDb = createGlobalKbDb(store);
    h.gdb = storeDb;
    Object.assign(configService, { redis, initialized: true });
    redisValues.set(CONFIG_KEYS.ENCRYPTION_KEY, generateEncryptionKey());
    await secretsService.initialize(db);
    app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/global-kb', globalKbRoutes);
  });

  afterAll(async () => {
    if (store) await store.end({ timeout: 5 });
    if (storeCreated) await db.execute(sql.raw(`DROP DATABASE "${storeName}" WITH (FORCE)`));
    await dropTriggers(db);
    await db.delete(schema.systemSecrets).where(eq(schema.systemSecrets.key, SECRET_KEY));
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    h.userId = randomUUID();
    entryId = randomUUID();
    await storeDb.insert(globalKbEntries).values({
      id: entryId,
      namespace: 'default',
      title: 'Rule',
      body: 'Rule text must never enter the audit row.',
      description: 'Description',
      category: 'best_practice',
      status: 'active',
      source: 'user',
    });
    const key = redisValues.get(CONFIG_KEYS.ENCRYPTION_KEY)!;
    redisValues.clear();
    redisValues.set(CONFIG_KEYS.ENCRYPTION_KEY, key);
    redisWrites = 0;
    failOnWrite = null;
    configService.clearCache();
    secretsService.clearCache();
    await db.delete(schema.systemSecrets).where(eq(schema.systemSecrets.key, SECRET_KEY));
  });

  afterEach(async () => {
    await store.unsafe('DROP TRIGGER IF EXISTS refuse_store_write ON global_kb_entries');
    await store.unsafe('DROP FUNCTION IF EXISTS refuse_store_write()');
    await storeDb.delete(globalKbEntries).where(eq(globalKbEntries.id, entryId));
    await dropTriggers(db);
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, h.userId));
    await db.delete(schema.systemSecrets).where(eq(schema.systemSecrets.key, SECRET_KEY));
  });

  it('E1: enforcement and removal each write exactly one main-DB audit row', async () => {
    expect((await enforcement('PUT')).status).toBe(200);
    expect((await enforcement('DELETE')).status).toBe(200);
    const all = await rows();
    expect(all.map((r) => r.action)).toEqual([
      'global_kb.house_rule.enforce',
      'global_kb.house_rule.unenforce',
    ]);
    for (const row of all) {
      expect(row.targetType).toBe('global_kb_entry');
      expect(row.targetId).toBe(entryId);
      expect(row.metadata).toEqual({ namespace: 'default', mode: 'files', globCount: 1 });
    }
  });

  it('E2: refusing the main audit row prevents the store write', async () => {
    await refuseAudit(db, []);
    expect((await enforcement('PUT')).status).toBe(500);
    const [row] = await storeDb
      .select()
      .from(globalKbEntries)
      .where(eq(globalKbEntries.id, entryId));
    expect(row!.enforcedHash).toBeNull();
    expect(await rows()).toEqual([]);
  });

  it.each(['PUT', 'DELETE'] as const)(
    'E3: a failed %s store write rolls back its audit row',
    async (method) => {
      if (method === 'DELETE') expect((await enforcement('PUT')).status).toBe(200);
      const before = await rows();
      await store.unsafe(
        "CREATE FUNCTION refuse_store_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'store refused'; END $$",
      );
      await store.unsafe(
        'CREATE TRIGGER refuse_store_write BEFORE UPDATE ON global_kb_entries FOR EACH ROW EXECUTE FUNCTION refuse_store_write()',
      );
      expect((await enforcement(method)).status).toBe(500);
      expect(await rows()).toEqual(before);
    },
  );

  it('E4: the documented cross-store commit window leaves no false audit row', async () => {
    await refuseAuditAtCommit(db);
    expect((await enforcement('PUT')).status).toBe(500);
    const [row] = await storeDb
      .select()
      .from(globalKbEntries)
      .where(eq(globalKbEntries.id, entryId));
    expect(row!.enforcedHash).not.toBeNull();
    expect(await rows()).toEqual([]);
  });

  it('S1: a refused audit row fails a new connection string and leaves the old one', async () => {
    await armExternalWithOld();
    await refuseAudit(db, []);
    const res = await put({ connectionString: NEW });
    expect(res.status).toBe(500);
    expect(await storedSecret()).toBe(OLD);
    await dropTriggers(db);
    expect(await rows()).toEqual([]);
  });

  it('S2: a refused secret write fails the save and leaves no row', async () => {
    await armExternalWithOld();
    await refuseSecret(db);
    const res = await put({ connectionString: NEW });
    expect(res.status).toBe(500);
    await dropTriggers(db);
    expect(await storedSecret()).toBe(OLD);
    expect(await rows()).toEqual([]);
  });

  it('S3: a new connection string stores one row that holds no part of it', async () => {
    await armExternalWithOld();
    const res = await put({ connectionString: NEW });
    expect(res.status).toBe(200);
    expect(await storedSecret()).toBe(NEW);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.action).toBe(STRING_ACTION);
    expect(all[0]!.metadata).toEqual({ connectionStringSet: true });
    const text = JSON.stringify(all);
    for (const part of [NEW, 'newuser', 'newpass', 'new-host.example']) {
      expect(text).not.toContain(part);
    }
  });

  it('S4: switching to external with a string writes a string row and a settings row', async () => {
    const res = await put({ mode: 'external', connectionString: NEW });
    expect(res.status).toBe(200);
    expect(await storedSecret()).toBe(NEW);
    expect(redisValues.get(CONFIG_KEYS.GLOBAL_KB_MODE)).toBe('external');
    expect(await rowsOf(STRING_ACTION)).toHaveLength(1);
    const config = await rowsOf(CONFIG_ACTION);
    expect(config).toHaveLength(1);
    expect(
      (config[0]!.metadata as { connectionStringChanged: boolean }).connectionStringChanged,
    ).toBe(true);
  });

  it('S5: a refused settings row fails the save, the string change stays with its row', async () => {
    await refuseAudit(db, [CONFIG_ACTION]);
    const res = await put({ mode: 'external', connectionString: NEW });
    expect(res.status).toBe(500);
    await dropTriggers(db);
    expect(await storedSecret()).toBe(NEW);
    expect(await rowsOf(STRING_ACTION)).toHaveLength(1);
    expect(redisValues.get(CONFIG_KEYS.GLOBAL_KB_MODE)).toBeUndefined();
    expect(await rowsOf(CONFIG_ACTION)).toEqual([]);
  });

  it('C1: a refused audit row fails a settings save before any Redis write', async () => {
    await refuseAudit(db, []);
    const res = await put({ digestEnabled: false, archiveRetentionDays: 7 });
    expect(res.status).toBe(500);
    await dropTriggers(db);
    expect(redisWrites).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it('C2: a Redis failure on the first write leaves no row and Redis unchanged', async () => {
    failOnWrite = 1;
    const res = await put({ digestEnabled: false, archiveRetentionDays: 7 });
    expect(res.status).toBe(500);
    expect(await rows()).toEqual([]);
    expect(redisValues.has(CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED)).toBe(false);
    expect(redisValues.has(CONFIG_KEYS.GLOBAL_KB_ARCHIVE_RETENTION_DAYS)).toBe(false);
  });

  it('C3: a Redis failure on the second write leaves one partial row naming the written key', async () => {
    failOnWrite = 2;
    const res = await put({ digestEnabled: false, archiveRetentionDays: 7 });
    expect(res.status).toBe(500);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.action).toBe(CONFIG_ACTION);
    const meta = all[0]!.metadata as {
      partial?: boolean;
      from: Record<string, unknown>;
      to: Record<string, unknown>;
    };
    expect(meta.partial).toBe(true);
    expect(Object.keys(meta.from)).toEqual(['digestEnabled']);
    expect(Object.keys(meta.to)).toEqual(['digestEnabled']);
  });

  it('C4: a settings save writes one complete row and both keys', async () => {
    redisValues.set(CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED, 'true');
    redisValues.set(CONFIG_KEYS.GLOBAL_KB_ARCHIVE_RETENTION_DAYS, '30');
    const res = await put({ digestEnabled: false, archiveRetentionDays: 7 });
    expect(res.status).toBe(200);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.action).toBe(CONFIG_ACTION);
    const meta = all[0]!.metadata as {
      partial?: boolean;
      from: Record<string, unknown>;
      to: Record<string, unknown>;
    };
    expect(meta.partial).toBeUndefined();
    expect(meta.to.digestEnabled).toBe('false');
    expect(meta.to.archiveRetentionDays).toBe('7');
    expect(meta.from.digestEnabled).toBe('true');
    expect(meta.from.archiveRetentionDays).toBe('30');
    expect(redisValues.get(CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED)).toBe('false');
    expect(redisValues.get(CONFIG_KEYS.GLOBAL_KB_ARCHIVE_RETENTION_DAYS)).toBe('7');
  });

  it('R1: a refused audit row fails clearing the string and keeps it', async () => {
    await setSecretDirectly(OLD);
    await refuseAudit(db, []);
    const res = await put({ clearConnectionString: true });
    expect(res.status).toBe(500);
    await dropTriggers(db);
    expect(await storedSecret()).toBe(OLD);
    expect(await rows()).toEqual([]);
  });

  it('R2: a refused secret delete fails the save and leaves no row', async () => {
    await setSecretDirectly(OLD);
    await refuseSecret(db);
    const res = await put({ clearConnectionString: true });
    expect(res.status).toBe(500);
    await dropTriggers(db);
    expect(await storedSecret()).toBe(OLD);
    expect(await rows()).toEqual([]);
  });

  it('R3: clearing the string removes it and writes one removal row', async () => {
    await setSecretDirectly(OLD);
    const res = await put({ clearConnectionString: true });
    expect(res.status).toBe(200);
    expect(await storedSecret()).toBeNull();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.action).toBe(STRING_ACTION);
    expect(all[0]!.metadata).toEqual({ connectionStringSet: false });
  });

  it('R4: a refused removal row fails the save after the settings, which keep an honest row', async () => {
    await armExternalWithOld();
    await refuseAudit(db, [STRING_ACTION]);
    const res = await put({ mode: 'internal', clearConnectionString: true });
    expect(res.status).toBe(500);
    await dropTriggers(db);
    expect(redisValues.get(CONFIG_KEYS.GLOBAL_KB_MODE)).toBe('internal');
    const config = await rowsOf(CONFIG_ACTION);
    expect(config).toHaveLength(1);
    expect(
      (config[0]!.metadata as { connectionStringChanged: boolean }).connectionStringChanged,
    ).toBe(false);
    expect(await storedSecret()).toBe(OLD);
    expect(await rowsOf(STRING_ACTION)).toEqual([]);
  });

  it('R5: leaving external and clearing the string records the settings row, then the removal', async () => {
    await armExternalWithOld();
    const res = await put({ mode: 'internal', clearConnectionString: true });
    expect(res.status).toBe(200);
    expect(await storedSecret()).toBeNull();
    expect(redisValues.get(CONFIG_KEYS.GLOBAL_KB_MODE)).toBe('internal');
    const all = await rows();
    expect(all.map((r) => r.action)).toEqual([CONFIG_ACTION, STRING_ACTION]);
    expect((all[0]!.metadata as { connectionStringChanged: boolean }).connectionStringChanged).toBe(
      false,
    );
    expect(all[1]!.metadata).toEqual({ connectionStringSet: false });
  });

  it('W1: a failed commit rolls the string update back with its audit row', async () => {
    await armExternalWithOld();
    await refuseAuditAtCommit(db);
    const res = await put({ connectionString: NEW });
    expect(res.status).toBe(500);
    await dropTriggers(db);
    expect(await secretsService.get(SECRET_KEY)).toBe(OLD);
    expect(await storedSecret()).toBe(OLD);
    expect(await rows()).toEqual([]);
  });

  it('W2: a commit that fails after the settings were written leaves them without a row and answers 500', async () => {
    await refuseAuditAtCommit(db);
    const res = await put({ digestEnabled: false, archiveRetentionDays: 7 });
    expect(res.status).toBe(500);
    await dropTriggers(db);
    expect(redisValues.get(CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED)).toBe('false');
    expect(redisValues.get(CONFIG_KEYS.GLOBAL_KB_ARCHIVE_RETENTION_DAYS)).toBe('7');
    expect(await rows()).toEqual([]);
  });

  it('W3: a failed commit rolls the string deletion back with its audit row', async () => {
    await setSecretDirectly(OLD);
    await refuseAuditAtCommit(db);
    const res = await put({ clearConnectionString: true });
    expect(res.status).toBe(500);
    await dropTriggers(db);
    expect(await secretsService.get(SECRET_KEY)).toBe(OLD);
    expect(await storedSecret()).toBe(OLD);
    expect(await rows()).toEqual([]);
  });
});

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.ADMIN_CONFIG_POOL_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/admin_config_pool_test'))
  throw new Error(
    'Use a dedicated admin_config_pool_test database for the admin config pool tests',
  );

interface Hold {
  limit: number;
  arrived: number;
  released: Promise<void>;
  open: () => void;
}

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  stored: new Map<string, string>(),
  hold: null as Hold | null,
  written: 0,
  failAfterWrites: null as number | null,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (
    c: {
      req: { header: (name: string) => string | undefined };
      set: (key: string, value: string) => void;
    },
    next: () => unknown,
  ) => {
    c.set('userId', c.req.header('x-test-actor')!);
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async (key: string) => h.stored.get(key) ?? null,
    getFresh: async (key: string) => h.stored.get(key) ?? null,
    getBoolean: async (key: string, fallback = false) => {
      const value = h.stored.get(key);
      return value === undefined ? fallback : value === 'true';
    },
    getNumber: async (key: string, fallback = 0) => {
      const parsed = Number.parseInt(h.stored.get(key) ?? '', 10);
      return Number.isNaN(parsed) ? fallback : parsed;
    },
    set: async (key: string, value: string) => {
      const hold = h.hold;
      if (hold && hold.arrived < hold.limit) {
        hold.arrived += 1;
        await hold.released;
      }
      if (h.written === h.failAfterWrites) throw new Error('redis is down');
      h.written += 1;
      h.stored.set(key, value);
    },
    getRedis: () => ({ publish: async () => 1 }),
  },
}));
vi.mock('../src/modules/activation.js', () => ({
  deactivatedModuleIds: async () => new Set<string>(),
  isModuleDeactivated: async () => false,
}));

import { Hono } from 'hono';
import { moduleManifestSchema } from '@haive/shared/modularity';
import { moduleSettingKey } from '@haive/shared/module-host';
import { adminRoutes } from '../src/routes/admin.js';
import { moduleRoutes } from '../src/modules/loader.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const DEFAULT_URL = 'https://default.example';
const SETTLE_WITHIN_MS = 10_000;
const LOCK_WAIT_MS = 2_000;
const WAIT = { timeout: 5_000 };

// More switches than the pool has connections; none has a side effect beyond its config key.
const SWITCHES = [
  'steering',
  'codex-app-server',
  'agent-isolation',
  'agent-rules-injection',
  'house-rules',
  'usage-window',
  'browser-access',
  'plan-canvas',
  'ide',
  'debug-mode',
  'db-access',
  'fair-scheduling',
];
const MODULE_IDS = SWITCHES.map((_, i) => `acme-${String(i).padStart(2, '0')}`);

const manifestOf = (id: string) =>
  moduleManifestSchema.parse({
    id,
    name: id,
    version: '1.0.0',
    schemaVersion: 1,
    globalSettings: {
      form: {
        title: 'Settings',
        fields: [
          { id: 'apiUrl', type: 'text', label: 'API URL' },
          { id: 'limit', type: 'text', label: 'Limit' },
        ],
      },
      defaults: { apiUrl: DEFAULT_URL, limit: '5' },
    },
  });

const app = new Hono<AppEnv>();
app.route('/admin', adminRoutes);
app.route(
  '/modules',
  moduleRoutes(
    MODULE_IDS.map((id) => ({ packageName: id, manifest: manifestOf(id), hasRoutes: false })),
  ),
);
app.onError(errorHandler);

describe.skipIf(!url)('admin config saves on a real connection pool', () => {
  let control: Database;
  let pool: Database;
  let actor: string;

  const put = (path: string, body: unknown) =>
    app.request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-actor': actor },
      body: JSON.stringify(body),
    });
  const putConfig = (name: string, body: unknown) => put(`/admin/config/${name}`, body);
  const putSettings = (id: string, values: Record<string, unknown>) =>
    put(`/modules/${id}/settings/global`, { values });

  const holdWrites = (limit = Number.POSITIVE_INFINITY): Hold => {
    const hold = { limit, arrived: 0, released: Promise.resolve(), open: () => {} };
    hold.released = new Promise<void>((resolve) => {
      hold.open = () => {
        h.hold = null;
        resolve();
      };
    });
    h.hold = hold;
    return hold;
  };
  const seedSettings = (id: string) => {
    h.stored.set(moduleSettingKey(id, 'global', 'apiUrl'), JSON.stringify(DEFAULT_URL));
    h.stored.set(moduleSettingKey(id, 'global', 'limit'), JSON.stringify('5'));
  };

  const auditRows = async () =>
    (
      await control
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.actorUserId, actor))
        .orderBy(asc(schema.auditEvents.createdAt))
    ).map((row) => ({ action: row.action, metadata: row.metadata }));
  const byJson = <T>(rows: T[]) =>
    rows.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const databaseClock = async () => {
    const [row] = await control.execute<{ at: string }>(
      sql`select clock_timestamp()::timestamp::text as at`,
    );
    return row!.at;
  };
  const stampedBefore = (instant: string) =>
    control
      .select({ action: schema.auditEvents.action, createdAt: schema.auditEvents.createdAt })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.actorUserId, actor),
          lt(schema.auditEvents.createdAt, sql`${instant}::timestamp - interval '50 milliseconds'`),
        ),
      );

  const thisDatabase = sql`(select oid from pg_database where datname = current_database())`;
  const waitingForLock = async () => {
    const [row] = await control.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = ${thisDatabase}`,
    );
    return row!.n;
  };
  const leftovers = async () => {
    const [row] = await control.execute<{ advisory: number; open: number }>(sql`
      select
        (select count(*)::int from pg_locks where locktype = 'advisory' and database = ${thisDatabase}) as advisory,
        (select count(*)::int from pg_stat_activity where datname = current_database() and state like 'idle in transaction%') as open`);
    return row;
  };

  const allSettle = async (saves: Array<Response | Promise<Response>>): Promise<number[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wedged = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void leftovers().then((held) =>
          reject(
            new Error(
              `saves still open after ${SETTLE_WITHIN_MS} ms with ${JSON.stringify(held)} held in the database: a save waits for a second pooled connection while it holds its first`,
            ),
          ),
        );
      }, SETTLE_WITHIN_MS);
    });
    try {
      return (await Promise.race([Promise.all(saves), wedged])).map((res) => res.status);
    } finally {
      clearTimeout(timer);
    }
  };

  const saveWithFullPool = async (
    starts: Array<() => Response | Promise<Response>>,
  ): Promise<number[]> => {
    expect(starts.length).toBeGreaterThan(pool.$client.options.max);
    const hold = holdWrites();
    const saves = starts.map((start) => start());
    await vi.waitFor(
      () => expect(hold.arrived).toBeGreaterThanOrEqual(pool.$client.options.max),
      WAIT,
    );
    hold.open();
    return allSettle(saves);
  };

  const saveOneKeyWithFullPool = async (
    starts: Array<() => Response | Promise<Response>>,
  ): Promise<number[]> => {
    const max = pool.$client.options.max;
    expect(starts.length).toBeGreaterThan(max);
    const hold = holdWrites(1);
    const saves = starts.map((start) => start());
    await vi.waitFor(() => expect(hold.arrived).toBe(1), WAIT);
    await vi.waitFor(async () => expect(await waitingForLock()).toBe(max - 1), WAIT);
    hold.open();
    return allSettle(saves);
  };

  const saveAfterLockWait = async (
    first: () => Response | Promise<Response>,
    second: () => Response | Promise<Response>,
  ): Promise<string> => {
    const hold = holdWrites(1);
    const firstSave = first();
    await vi.waitFor(() => expect(hold.arrived).toBe(1), WAIT);
    const secondSave = second();
    await vi.waitFor(async () => expect(await waitingForLock()).toBe(1), WAIT);
    await sleep(LOCK_WAIT_MS);
    const released = await databaseClock();
    hold.open();

    expect([(await firstSave).status, (await secondSave).status]).toEqual([200, 200]);
    return released;
  };

  beforeAll(() => {
    control = createDatabase(url as string);
  });

  beforeEach(() => {
    pool = createDatabase(url as string);
    h.db = pool;
    actor = randomUUID();
    h.stored.clear();
    h.hold = null;
    h.written = 0;
    h.failAfterWrites = null;
  });

  afterEach(async () => {
    h.hold?.open();
    await pool.$client.end({ timeout: 5 });
    await control.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, actor));
  });

  afterAll(async () => {
    await control.$client.end({ timeout: 5 });
  });

  describe('config switches', () => {
    it('queues a second save of one switch behind the first, and the rows chain', async () => {
      const hold = holdWrites(1);
      const first = putConfig('cli-soft-timeout', { enabled: false, percent: 50 });
      await vi.waitFor(() => expect(hold.arrived).toBe(1), WAIT);
      const second = putConfig('cli-soft-timeout', { enabled: true, percent: 95 });
      await vi.waitFor(async () => expect(await waitingForLock()).toBe(1), WAIT);
      hold.open();

      expect([(await first).status, (await second).status]).toEqual([200, 200]);
      expect(await auditRows()).toEqual([
        {
          action: 'config.cli_soft_timeout',
          metadata: { from: { enabled: true, percent: 80 }, to: { enabled: false, percent: 50 } },
        },
        {
          action: 'config.cli_soft_timeout',
          metadata: { from: { enabled: false, percent: 50 }, to: { enabled: true, percent: 95 } },
        },
      ]);
      expect(await leftovers()).toEqual({ advisory: 0, open: 0 });
    });

    it('stamps the row of a save that waited for its switch when it is written, not when the save began', async () => {
      const released = await saveAfterLockWait(
        () => putConfig('cli-soft-timeout', { enabled: false, percent: 50 }),
        () => putConfig('cli-soft-timeout', { enabled: true, percent: 95 }),
      );

      expect(await auditRows()).toHaveLength(2);
      expect(await stampedBefore(released), `rows stamped before ${released}`).toEqual([]);
    }, 15_000);

    it('does not hold a save of another switch behind a parked one', async () => {
      const hold = holdWrites(1);
      const slow = putConfig('cli-soft-timeout', { enabled: false, percent: 50 });
      await vi.waitFor(() => expect(hold.arrived).toBe(1), WAIT);

      expect((await putConfig('browser-access', { enabled: false })).status).toBe(200);
      hold.open();
      expect((await slow).status).toBe(200);
    });

    it('commits the row of a save whose second write fails, answers 5xx and frees the lock', async () => {
      h.failAfterWrites = 1;

      expect((await putConfig('cli-soft-timeout', { enabled: false, percent: 50 })).status).toBe(
        500,
      );
      expect(await auditRows()).toEqual([
        {
          action: 'config.cli_soft_timeout',
          metadata: { from: { enabled: true }, to: { enabled: false }, partial: true },
        },
      ]);
      expect(await leftovers()).toEqual({ advisory: 0, open: 0 });
    });

    it('leaves no row for a save whose first write fails, and frees the lock', async () => {
      h.failAfterWrites = 0;

      expect((await putConfig('cli-soft-timeout', { enabled: false, percent: 50 })).status).toBe(
        500,
      );
      expect(await auditRows()).toEqual([]);
      expect(await leftovers()).toEqual({ advisory: 0, open: 0 });
    });

    it('completes more simultaneous saves of different switches than the pool has connections', async () => {
      const statuses = await saveWithFullPool(
        SWITCHES.map((name) => () => putConfig(name, { enabled: false })),
      );

      expect(statuses).toEqual(SWITCHES.map(() => 200));
      expect(byJson(await auditRows())).toEqual(
        byJson(
          SWITCHES.map((name) => ({
            action: `config.${name.replaceAll('-', '_')}`,
            metadata: { from: true, to: false },
          })),
        ),
      );
      expect(await leftovers()).toEqual({ advisory: 0, open: 0 });
    }, 30_000);

    it('completes more simultaneous saves of one switch than the pool has connections, one after another', async () => {
      const percents = SWITCHES.map((_, i) => i + 1);
      const statuses = await saveOneKeyWithFullPool(
        percents.map((percent) => () => putConfig('cli-soft-timeout', { enabled: true, percent })),
      );

      expect(statuses).toEqual(percents.map(() => 200));
      const rows = (await auditRows()).map(
        (row) => row.metadata as { from: { percent: number }; to: { percent: number } },
      );
      const chain = [80];
      for (const _ of rows) {
        const next = rows.find((row) => row.from.percent === chain.at(-1));
        if (!next) break;
        chain.push(next.to.percent);
      }
      expect(chain, 'each row starts where the row before it ended').toHaveLength(rows.length + 1);
      expect(chain.slice(1).toSorted((a, b) => a - b)).toEqual(percents);
      expect(await leftovers()).toEqual({ advisory: 0, open: 0 });
    }, 30_000);
  });

  describe('module settings', () => {
    it('queues a second save of one module behind the first, and the rows chain', async () => {
      const id = MODULE_IDS[0]!;
      seedSettings(id);
      const hold = holdWrites(1);
      const first = putSettings(id, { apiUrl: 'https://one.example', limit: '5' });
      await vi.waitFor(() => expect(hold.arrived).toBe(1), WAIT);
      const second = putSettings(id, { apiUrl: DEFAULT_URL, limit: '5' });
      await vi.waitFor(async () => expect(await waitingForLock()).toBe(1), WAIT);
      hold.open();

      expect([(await first).status, (await second).status]).toEqual([200, 200]);
      expect((await auditRows()).map((row) => row.metadata)).toEqual([
        { moduleId: id, kind: 'global', changed: ['apiUrl'] },
        { moduleId: id, kind: 'global', changed: ['apiUrl'] },
      ]);
      expect(await leftovers()).toEqual({ advisory: 0, open: 0 });
    });

    it('stamps the row of a save that waited for its module when it is written, not when the save began', async () => {
      const id = MODULE_IDS[0]!;
      seedSettings(id);

      const released = await saveAfterLockWait(
        () => putSettings(id, { apiUrl: 'https://one.example', limit: '5' }),
        () => putSettings(id, { apiUrl: DEFAULT_URL, limit: '5' }),
      );

      expect(await auditRows()).toHaveLength(2);
      expect(await stampedBefore(released), `rows stamped before ${released}`).toEqual([]);
    }, 15_000);

    it('commits the row of a save whose second write fails, answers 5xx and frees the lock', async () => {
      const id = MODULE_IDS[0]!;
      seedSettings(id);
      h.failAfterWrites = 1;

      const res = await putSettings(id, { apiUrl: 'https://changed.example', limit: 'secret-x' });

      expect(res.status).toBe(500);
      expect(await auditRows()).toEqual([
        {
          action: 'module.settings',
          metadata: { moduleId: id, kind: 'global', changed: ['apiUrl'], partial: true },
        },
      ]);
      expect(await leftovers()).toEqual({ advisory: 0, open: 0 });
    });

    it('completes more simultaneous saves of different modules than the pool has connections', async () => {
      MODULE_IDS.forEach(seedSettings);

      const statuses = await saveWithFullPool(
        MODULE_IDS.map(
          (id) => () => putSettings(id, { apiUrl: 'https://one.example', limit: '5' }),
        ),
      );

      expect(statuses).toEqual(MODULE_IDS.map(() => 200));
      expect(byJson(await auditRows())).toEqual(
        byJson(
          MODULE_IDS.map((id) => ({
            action: 'module.settings',
            metadata: { moduleId: id, kind: 'global', changed: ['apiUrl'] },
          })),
        ),
      );
      expect(await leftovers()).toEqual({ advisory: 0, open: 0 });
    }, 30_000);

    it('completes more simultaneous saves of one module than the pool has connections', async () => {
      const id = MODULE_IDS[0]!;
      seedSettings(id);

      const statuses = await saveOneKeyWithFullPool(
        MODULE_IDS.map(
          (_, i) => () => putSettings(id, { apiUrl: `https://${i}.example`, limit: '5' }),
        ),
      );

      expect(statuses).toEqual(MODULE_IDS.map(() => 200));
      expect(await auditRows()).toHaveLength(MODULE_IDS.length);
      expect(await leftovers()).toEqual({ advisory: 0, open: 0 });
    }, 30_000);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const SENTINEL = 'sentinel-credential-7f3c9a1e';
const h = vi.hoisted(() => {
  const waiting = new Map<string, Array<() => void>>();
  const state = {
    stored: new Map<string, string>(),
    cache: new Map<string, string | null>(),
    writes: [] as Array<[string, string]>,
    audits: [] as unknown[],
    external: false,
    writeFails: false,
    failAfterWrites: null as number | null,
    gate: null as Promise<void> | null,
    onParked: () => {},
    onQueued: () => {},
    locks: [] as string[],
    heldAtAudit: [] as boolean[],
    statements: [] as string[],
    lockFails: null as Error | null,
    txRows: new Map<object, unknown[]>(),
    auditOnTx: [] as boolean[],
    waiting,
    acquire: async (key: string) => {
      const queue = waiting.get(key);
      if (queue) {
        state.onQueued();
        await new Promise<void>((resolve) => queue.push(resolve));
      } else {
        waiting.set(key, []);
      }
      state.locks.push(key);
    },
    release: (key: string) => {
      const next = waiting.get(key)?.shift();
      if (next) next();
      else waiting.delete(key);
    },
  };
  return state;
});

// A row audited on the transaction is kept only if the callback returns: a throw rolls it back.
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    execute: async () => [],
    transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      let key: string | undefined;
      const rows: unknown[] = [];
      const tx = {
        execute: async (query: { queryChunks: unknown[] }) => {
          h.statements.push(
            query.queryChunks
              .map((chunk) =>
                typeof chunk === 'string' ? '?' : (chunk as { value: string[] }).value.join(''),
              )
              .join(''),
          );
          const param = query.queryChunks.find(
            (chunk): chunk is string => typeof chunk === 'string',
          );
          if (param === undefined) return [];
          if (h.lockFails) throw h.lockFails;
          key = param;
          await h.acquire(key);
          return [];
        },
      };
      h.txRows.set(tx, rows);
      try {
        const result = await run(tx);
        h.audits.push(...rows);
        return result;
      } finally {
        if (key !== undefined) h.release(key);
      }
    },
  }),
}));
vi.mock('../src/lib/audit.js', () => ({
  recordAuditEvent: async (db: object, event: unknown) => {
    h.heldAtAudit.push(h.waiting.size > 0);
    h.auditOnTx.push(h.txRows.has(db));
    (h.txRows.get(db) ?? h.audits).push(event);
  },
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', ADMIN_ID);
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const cached = (key: string) => {
    if (!h.cache.has(key)) h.cache.set(key, h.stored.get(key) ?? null);
    return h.cache.get(key) ?? null;
  };
  return {
    ...(await importOriginal<typeof import('@haive/shared')>()),
    configService: {
      get: async (key: string) => cached(key),
      getFresh: async (key: string) => {
        const value = h.stored.get(key) ?? null;
        h.cache.set(key, value);
        return value;
      },
      getBoolean: async (key: string, fallback = false) => {
        const value = cached(key);
        return value === null ? fallback : value === 'true' || value === '1';
      },
      getNumber: async (key: string, fallback = 0) => {
        const parsed = Number.parseInt(cached(key) ?? '', 10);
        return Number.isNaN(parsed) ? fallback : parsed;
      },
      set: async (key: string, value: string) => {
        if (h.gate) {
          const gate = h.gate;
          h.gate = null;
          h.onParked();
          await gate;
        }
        if (h.writeFails || h.writes.length === h.failAfterWrites) {
          throw new Error('redis is down');
        }
        h.writes.push([key, value]);
        h.stored.set(key, value);
        if (!h.external) h.cache.delete(key);
      },
      getRedis: () => ({ publish: async () => 1 }),
    },
  };
});

import { Hono } from 'hono';
import {
  DEFAULT_CHROME_MCP_TOOL_TIMEOUT_MS,
  DEFAULT_CLI_PROMPT_RETENTION_DAYS,
  DEFAULT_CLI_STREAM_LOG_RETENTION_DAYS,
  DEFAULT_CLI_TIMEOUT_BASE_MINUTES,
  DEFAULT_CLI_TIMEOUT_LADDER,
  DEFAULT_TASK_ATTACHMENT_MAX_BYTES,
} from '@haive/shared';
import { adminRoutes } from '../src/routes/admin.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/admin', adminRoutes);
app.onError(errorHandler);

type Settings = Record<string, boolean | number | string>;
interface Route {
  name: string;
  /** What each field reads as while nothing is stored: the GET's own answer. */
  initial: Settings;
  a: Settings;
  b: Settings;
}

const flag = (name: string, fallback: boolean, field = 'enabled'): Route => ({
  name,
  initial: { [field]: fallback },
  a: { [field]: !fallback },
  b: { [field]: fallback },
});

const ROUTES: Route[] = [
  {
    name: 'concurrency',
    initial: { maxParallelAgents: 0 },
    a: { maxParallelAgents: 4 },
    b: { maxParallelAgents: 7 },
  },
  {
    name: 'runtime-limits',
    initial: {
      enabled: true,
      memoryMb: 0,
      cpus: 0,
      maxConcurrent: 0,
      idleReapMinutes: 180,
      ddevWeightMb: 0,
      appWeightMb: 0,
      agentWeightMb: 0,
      browserWeightMb: 0,
      agentFloor: 0,
      agentPoolMeasuredEnabled: true,
      agentPoolSafetyMb: 0,
      agentReserveEnabled: true,
      agentReserveMaxHoldMinutes: 3,
      agentPreemptionEnabled: true,
      agentPreemptionMinRunMinutes: 5,
      runtimePreemptionEnabled: true,
      runtimePreemptionMaxWaitMinutes: 10,
    },
    a: {
      enabled: false,
      memoryMb: 4096,
      cpus: 2,
      maxConcurrent: 3,
      idleReapMinutes: 60,
      ddevWeightMb: 1500,
      appWeightMb: 800,
      agentWeightMb: 700,
      browserWeightMb: 600,
      agentFloor: 2,
      agentPoolMeasuredEnabled: true,
      agentPoolSafetyMb: 1024,
      agentReserveEnabled: false,
      agentReserveMaxHoldMinutes: 7,
      agentPreemptionEnabled: true,
      agentPreemptionMinRunMinutes: 9,
      runtimePreemptionEnabled: false,
      runtimePreemptionMaxWaitMinutes: 11,
    },
    b: {
      enabled: true,
      memoryMb: 2048,
      cpus: 4,
      maxConcurrent: 5,
      idleReapMinutes: 90,
      ddevWeightMb: 1100,
      appWeightMb: 500,
      agentWeightMb: 400,
      browserWeightMb: 300,
      agentFloor: 1,
      agentPoolMeasuredEnabled: false,
      agentPoolSafetyMb: 512,
      agentReserveEnabled: true,
      agentReserveMaxHoldMinutes: 2,
      agentPreemptionEnabled: false,
      agentPreemptionMinRunMinutes: 4,
      runtimePreemptionEnabled: true,
      runtimePreemptionMaxWaitMinutes: 6,
    },
  },
  flag('steering', true),
  flag('codex-app-server', true),
  flag('agent-isolation', true),
  flag('agent-rules-injection', true),
  flag('house-rules', true),
  flag('pr-workflow', false),
  {
    name: 'cli-soft-timeout',
    initial: { enabled: true, percent: 80 },
    a: { enabled: false, percent: 50 },
    b: { enabled: true, percent: 95 },
  },
  {
    name: 'cli-timeout-ladder',
    initial: {
      baseMinutes: DEFAULT_CLI_TIMEOUT_BASE_MINUTES,
      ladder: DEFAULT_CLI_TIMEOUT_LADDER.join(','),
    },
    a: { baseMinutes: 60, ladder: '1,2,4' },
    b: { baseMinutes: 90, ladder: '1,1.5' },
  },
  flag('usage-window', true),
  {
    name: 'usage-alert',
    initial: { enabled: true, thresholdPct: 10 },
    a: { enabled: false, thresholdPct: 25 },
    b: { enabled: true, thresholdPct: 5 },
  },
  flag('prompt-caching-1h', false),
  {
    name: 'cli-pricing',
    initial: { autoUpdateEnabled: true, displayCurrency: 'USD' },
    a: { autoUpdateEnabled: false, displayCurrency: 'EUR' },
    b: { autoUpdateEnabled: true, displayCurrency: 'GBP' },
  },
  { name: 'terseness', initial: { level: 'full' }, a: { level: 'ultra' }, b: { level: 'lite' } },
  flag('step-guidance', false),
  { name: 'spec-view', initial: { mode: 'toc' }, a: { mode: 'full' }, b: { mode: 'toc' } },
  {
    name: 'review-refute',
    initial: { enabled: true, lenses: 3 },
    a: { enabled: false, lenses: 1 },
    b: { enabled: true },
  },
  {
    name: 'qa-verify',
    initial: { enabled: true, lenses: 3 },
    a: { enabled: false, lenses: 1 },
    b: { enabled: true },
  },
  flag('browser-access', true),
  flag('plan-canvas', true),
  {
    name: 'task-types',
    initial: { customEnabled: false, moduleEnabled: false },
    a: { customEnabled: true, moduleEnabled: false },
    b: { customEnabled: false, moduleEnabled: true },
  },
  {
    name: 'registration-mode',
    initial: { mode: 'closed' },
    a: { mode: 'open' },
    b: { mode: 'invite' },
  },
  {
    name: 'rag-embedding',
    initial: {
      embedTimeoutMs: 240_000,
      queryTimeoutMs: 20_000,
      warmupTimeoutMs: 300_000,
      batchSize: 8,
      strictEnabled: true,
    },
    a: {
      embedTimeoutMs: 120_000,
      queryTimeoutMs: 10_000,
      warmupTimeoutMs: 150_000,
      batchSize: 16,
      strictEnabled: false,
    },
    b: {
      embedTimeoutMs: 60_000,
      queryTimeoutMs: 5_000,
      warmupTimeoutMs: 90_000,
      batchSize: 4,
      strictEnabled: true,
    },
  },
  flag('ide', true),
  flag('debug-mode', true),
  flag('db-access', true),
  flag('ddev-registry-cache', true),
  { name: 'allowance-watch', initial: { mode: 'notify' }, a: { mode: 'auto' }, b: { mode: 'off' } },
  flag('ddev-control', true),
  flag('custom-tools', true),
  {
    name: 'chrome-mcp-timeout',
    initial: { timeoutMs: DEFAULT_CHROME_MCP_TOOL_TIMEOUT_MS },
    a: { timeoutMs: 5_000 },
    b: { timeoutMs: 0 },
  },
  flag('global-pause', false, 'paused'),
  flag('model-identity-strict', false),
  flag('fair-scheduling', true),
  {
    name: 'max-agents-per-task',
    initial: { maxAgentsPerTask: 5 },
    a: { maxAgentsPerTask: 2 },
    b: { maxAgentsPerTask: 9 },
  },
  {
    name: 'attachment-max-bytes',
    initial: { maxBytes: DEFAULT_TASK_ATTACHMENT_MAX_BYTES },
    a: { maxBytes: 2_048 },
    b: { maxBytes: 1_048_576 },
  },
  {
    name: 'cli-stream-log-retention',
    initial: { retentionDays: DEFAULT_CLI_STREAM_LOG_RETENTION_DAYS },
    a: { retentionDays: 30 },
    b: { retentionDays: 90 },
  },
  {
    name: 'cli-prompt-retention',
    initial: { retentionDays: DEFAULT_CLI_PROMPT_RETENTION_DAYS },
    a: { retentionDays: 30 },
    b: { retentionDays: 90 },
  },
];

const send = (method: 'GET' | 'PUT', name: string, body?: unknown) =>
  app.request(`/admin/config/${name}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const read = async (name: string) => (await send('GET', name)).json();
// Every body also carries a credential-looking field, which no audit row may repeat.
const put = (name: string, body: unknown) =>
  send('PUT', name, { ...(body as Settings), token: SENTINEL });

const event = (name: string, before: Settings, body: Settings) => {
  const after = { ...before, ...body };
  const fields = Object.keys(before);
  return {
    actorUserId: ADMIN_ID,
    action: `config.${name.replaceAll('-', '_')}`,
    targetType: 'system',
    metadata:
      fields.length === 1
        ? { from: before[fields[0]!], to: after[fields[0]!] }
        : { from: before, to: after },
  };
};

beforeEach(() => {
  h.stored = new Map();
  h.cache = new Map();
  h.writes = [];
  h.audits = [];
  h.external = false;
  h.writeFails = false;
  h.failAfterWrites = null;
  h.gate = null;
  h.onParked = () => {};
  h.onQueued = () => {};
  h.locks = [];
  h.heldAtAudit = [];
  h.statements = [];
  h.lockFails = null;
  h.txRows.clear();
  h.auditOnTx = [];
  h.waiting.clear();
});

/** The wait for an advisory lock running past `lock_timeout`, as drizzle reports it. */
const lockTimedOut = () =>
  new Error('Failed query: select pg_advisory_xact_lock(hashtextextended($1, 0))', {
    cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
  });
const LOCK_BUSY = 'Another save of this setting is in progress; try again';

/** Holds the next config write until `open`, and says when a save is stuck inside it. */
const parkNextWrite = () => {
  let open!: () => void;
  h.gate = new Promise<void>((resolve) => (open = resolve));
  const parked = new Promise<void>((resolve) => (h.onParked = resolve));
  return { parked, open };
};
const queuedBehindOther = () => new Promise<void>((resolve) => (h.onQueued = resolve));

describe('every PUT /admin/config route', () => {
  it('is covered here, so a new switch cannot ship without its audit row', () => {
    const registered = adminRoutes.routes
      .filter((route) => route.method === 'PUT' && route.path.startsWith('/config/'))
      .map((route) => route.path.slice('/config/'.length))
      .sort();
    expect(registered).toEqual(ROUTES.map((route) => route.name).sort());
    expect(ROUTES).toHaveLength(39);
  });

  it('keeps the action names that were audited before', async () => {
    await put('registration-mode', { mode: 'open' });
    await put('custom-tools', { enabled: false });
    expect(h.audits.map((audit) => (audit as { action: string }).action)).toEqual([
      'config.registration_mode',
      'config.custom_tools',
    ]);
  });
});

describe.each(ROUTES)('PUT /admin/config/$name', ({ name, initial, a, b }) => {
  it('records who changed it, from what to what', async () => {
    expect(await read(name)).toMatchObject(initial);

    const seen: unknown[] = [];
    let state: Settings = { ...initial };
    for (const body of [a, b]) {
      const res = await put(name, body);
      expect(res.status, `PUT ${JSON.stringify(body)}`).toBe(200);
      expect(h.audits).toEqual([event(name, state, body)]);
      seen.push(...h.audits);
      h.audits = [];
      state = { ...state, ...body };
      expect(await read(name)).toMatchObject(state);
    }
    expect(JSON.stringify(seen)).not.toContain(SENTINEL);
    const { action } = seen[0] as { action: string };
    expect(action.length, 'audit_events.action is varchar(64)').toBeLessThanOrEqual(64);
  });

  it('reads the value before the write past the config cache', async () => {
    await put(name, a);
    await read(name);
    h.external = true;
    await put(name, b);
    h.external = false;
    h.audits = [];

    expect((await put(name, a)).status).toBe(200);
    expect(h.audits).toEqual([event(name, { ...initial, ...a, ...b }, a)]);
  });

  it('records nothing for a body it refuses', async () => {
    const first = Object.keys(a)[0]!;
    for (const body of [{}, { ...a, [first]: 'x' }]) {
      expect((await put(name, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect([h.audits, h.writes]).toEqual([[], []]);
  });

  it('records nothing when the write fails', async () => {
    h.writeFails = true;
    expect((await put(name, a)).status).toBe(500);
    expect(h.audits).toEqual([]);
  });

  it('saves one at a time, so the second records what the first wrote', async () => {
    const park = parkNextWrite();
    const queued = queuedBehindOther();
    const first = put(name, a);
    await park.parked;
    const second = put(name, b);
    await Promise.race([second, queued]);
    park.open();

    expect([(await first).status, (await second).status]).toEqual([200, 200]);
    expect(h.audits).toEqual([event(name, initial, a), event(name, { ...initial, ...a }, b)]);
    expect(h.locks).toEqual([`admin-config:${name}`, `admin-config:${name}`]);
    expect(h.heldAtAudit, 'each row is written while the lock is held').toEqual([true, true]);
    expect(h.auditOnTx, 'each row is written on the transaction that holds it').toEqual([
      true,
      true,
    ]);
  });

  it('sets a lock timeout before it takes the lock', async () => {
    expect((await put(name, a)).status).toBe(200);
    expect(h.statements).toEqual([
      expect.stringMatching(/^SET LOCAL lock_timeout = '[1-9]\d*ms'$/),
      'select pg_advisory_xact_lock(hashtextextended(?, 0))',
    ]);
  });

  it('answers 503 and writes nothing when the wait for the lock runs out', async () => {
    h.lockFails = lockTimedOut();
    const res = await put(name, a);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: LOCK_BUSY, code: null });
    expect([h.writes, h.audits]).toEqual([[], []]);
  });
});

describe('PUT /admin/config when the lock fails for another reason', () => {
  it('stays a 500, and writes nothing', async () => {
    h.lockFails = new Error('terminating connection due to administrator command');

    expect((await put('steering', { enabled: false })).status).toBe(500);
    expect([h.writes, h.audits]).toEqual([[], []]);
  });
});

describe.each(ROUTES.filter(({ a }) => Object.keys(a).length > 1))(
  'PUT /admin/config/$name when a later write fails',
  ({ name, initial, a }) => {
    it('records the field it already wrote, marked partial, and still fails', async () => {
      h.failAfterWrites = 1;
      expect((await put(name, a)).status).toBe(500);

      expect(h.audits).toHaveLength(1);
      const [field] = Object.keys((h.audits[0] as { metadata: { to: Settings } }).metadata.to);
      expect(h.audits).toEqual([
        {
          actorUserId: ADMIN_ID,
          action: `config.${name.replaceAll('-', '_')}`,
          targetType: 'system',
          metadata: {
            from: { [field!]: initial[field!] },
            to: { [field!]: a[field!] },
            partial: true,
          },
        },
      ]);
      expect(h.writes.map(([, value]) => value)).toEqual([String(a[field!])]);
      expect(h.heldAtAudit, 'the row is written while the lock is held').toEqual([true]);
      expect(h.auditOnTx, 'the row is written on the transaction that holds it').toEqual([true]);
    });
  },
);

describe('PUT /admin/config/cli-timeout-ladder', () => {
  it('records nothing for a ladder with no usable rung', async () => {
    expect((await put('cli-timeout-ladder', { baseMinutes: 60, ladder: 'a,b' })).status).toBe(400);
    expect([h.audits, h.writes]).toEqual([[], []]);
  });

  it('records the ladder as it was stored, not as it was typed', async () => {
    await put('cli-timeout-ladder', { baseMinutes: 60, ladder: ' 1, x, 2.5 ' });
    expect(h.audits).toEqual([
      event(
        'cli-timeout-ladder',
        {
          baseMinutes: DEFAULT_CLI_TIMEOUT_BASE_MINUTES,
          ladder: DEFAULT_CLI_TIMEOUT_LADDER.join(','),
        },
        { baseMinutes: 60, ladder: '1,2.5' },
      ),
    ]);
  });
});

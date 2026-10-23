import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mode = 'present' | 'absent' | 'broken' | 'down';

const h = vi.hoisted(() => ({
  mode: 'present' as 'present' | 'absent' | 'broken' | 'down',
  rows: [] as Record<string, unknown>[],
  running: false,
  statements: [] as string[],
  inserts: 0,
  spawn: undefined as unknown as ReturnType<typeof vi.fn>,
  audit: undefined as unknown as ReturnType<typeof vi.fn>,
  db: undefined as unknown,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  h.spawn = vi.fn();
  return { ...real, spawn: h.spawn };
});
vi.mock('../src/lib/audit.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/audit.js')>();
  h.audit = vi.fn(async () => undefined);
  return { ...real, recordAuditEvent: h.audit };
});
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const dialect = new PgDialect();
const render = (q: unknown): string =>
  dialect.sqlToQuery(q as Parameters<PgDialect['sqlToQuery']>[0]).sql;

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/admin/maintenance', maintenanceRoutes);

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_signal: string) => true);
}

const HISTORY = [
  {
    id: '00000000-0000-4000-8000-0000000000b2',
    from_version: '1.0.0',
    to_version: '1.1.0',
    phase: 'done',
    status: 'done',
    error: null,
    started_at: '2026-10-02T10:00:00.000Z',
    ended_at: '2026-10-02T10:05:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-0000000000b1',
    from_version: '0.9.0',
    to_version: '1.0.0',
    phase: 'failed',
    status: 'failed',
    error: 'boom',
    started_at: '2026-10-01T10:00:00.000Z',
    ended_at: '2026-10-01T10:05:00.000Z',
  },
];

const fakeDb = {
  insert: () => {
    h.inserts += 1;
    throw new Error('no insert expected');
  },
  execute: async (q: unknown) => {
    const text = render(q);
    h.statements.push(text);
    if (h.mode === 'down') throw new Error('connection terminated');
    if (/to_regclass/i.test(text)) return [{ present: h.mode !== 'absent' }];
    if (!/upgrade_runs/.test(text)) return [];
    if (h.mode === 'absent') {
      throw Object.assign(new Error('Failed query'), {
        cause: Object.assign(new Error('relation "upgrade_runs" does not exist'), {
          code: '42P01',
        }),
      });
    }
    if (h.mode === 'broken') throw new Error('connection terminated');
    if (/order by/i.test(text)) return h.rows;
    return h.running ? [{ id: HISTORY[0]!.id }] : [];
  },
};

const setMode = (mode: Mode, rows: Record<string, unknown>[] = [], running = false) => {
  h.mode = mode;
  h.rows = rows;
  h.running = running;
};

const get = () => app.request('/admin/maintenance/upgrade');
const post = (body: unknown = { version: '2.0.0' }) =>
  app.request('/admin/maintenance/upgrade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.stubEnv('HAIVE_VERSION', '1.0.0');
  vi.stubEnv('HAIVE_INSTALL_DIR_HOST', '/srv/haive');
  h.db = fakeDb;
  h.statements = [];
  h.inserts = 0;
  h.audit.mockClear();
  h.spawn.mockReset();
  h.spawn.mockImplementation(() => {
    const child = new FakeChild();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('container123\n'));
      child.emit('close', 0);
    });
    return child;
  });
  setMode('present');
});
afterEach(() => vi.unstubAllEnvs());

const expectNoAudit = () => {
  expect(h.audit).not.toHaveBeenCalled();
  expect(h.inserts).toBe(0);
};

describe('GET /admin/maintenance/upgrade', () => {
  it('answers 500 and no run list when the journal exists but cannot be read', async () => {
    setMode('broken');
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).not.toHaveProperty('runs');
  });

  it('answers 500 when the database is down', async () => {
    setMode('down');
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).not.toHaveProperty('runs');
  });

  it('answers 200 with no runs when the journal table does not exist', async () => {
    setMode('absent');
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: '1.0.0',
      canUpgrade: true,
      devBuild: false,
      installDirConfigured: true,
      runs: [],
    });
  });

  it('lists the journal rows as read, newest first', async () => {
    setMode('present', HISTORY);
    const res = await get();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runs: unknown }).runs).toEqual(HISTORY);
  });
});

describe('POST /admin/maintenance/upgrade', () => {
  it('answers 500 and starts nothing when the journal exists but cannot be read', async () => {
    setMode('broken');
    const res = await post();
    expect(res.status).toBe(500);
    expect(h.spawn).not.toHaveBeenCalled();
    expectNoAudit();
  });

  it('answers 500 and starts nothing when the database is down', async () => {
    setMode('down');
    const res = await post();
    expect(res.status).toBe(500);
    expect(h.spawn).not.toHaveBeenCalled();
    expectNoAudit();
  });

  it('answers 409 and starts nothing when a run is already running', async () => {
    setMode('present', HISTORY, true);
    const res = await post();
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('already running');
    expect(h.spawn).not.toHaveBeenCalled();
    expectNoAudit();
  });

  it('starts the updater when the journal table does not exist', async () => {
    setMode('absent');
    const res = await post({ version: '2.0.0' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ started: true, to: '2.0.0' });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const args = h.spawn.mock.calls[0]![1] as string[];
    expect(args.some((a) => a.endsWith('haive-updater:2.0.0'))).toBe(true);
  });

  it('starts the updater when the journal holds no running row', async () => {
    setMode('present', HISTORY, false);
    const res = await post();
    expect(res.status).toBe(202);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });
});

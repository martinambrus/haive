import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const waiting = new Map<string, Array<() => void>>();
  const state = {
    stored: new Map<string, string>(),
    audits: [] as Array<{ action: string; metadata?: Record<string, unknown> | null }>,
    written: 0,
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

vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    getFresh: async (key: string) => h.stored.get(key) ?? null,
    set: async (key: string, value: string) => {
      if (h.gate) {
        const gate = h.gate;
        h.gate = null;
        h.onParked();
        await gate;
      }
      if (h.written === h.failAfterWrites) throw new Error('redis is down');
      h.written += 1;
      h.stored.set(key, value);
    },
  },
}));

// A row audited on the transaction is kept only if the callback returns: a throw rolls it back.
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      let key: string | undefined;
      const rows: Array<{ action: string; metadata?: Record<string, unknown> | null }> = [];
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
        transaction: async (inner: (child: object) => Promise<unknown>): Promise<unknown> => {
          const child = { ...tx };
          const childRows = [] as typeof rows;
          h.txRows.set(child, childRows);
          const result = await inner(child);
          rows.push(...childRows);
          return result;
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
vi.mock('../src/lib/audit.js', () => {
  const insertAuditEvent = async (db: object, event: unknown) => {
    h.heldAtAudit.push(h.waiting.size > 0);
    h.auditOnTx.push(h.txRows.has(db));
    (h.txRows.get(db) ?? h.audits).push(event);
  };
  return { recordAuditEvent: insertAuditEvent, insertAuditEvent, logAuditEvent: () => {} };
});
vi.mock('../src/modules/activation.js', () => ({
  deactivatedModuleIds: async () => new Set<string>(),
  isModuleDeactivated: async () => false,
}));

import { Hono } from 'hono';
import { moduleManifestSchema } from '@haive/shared/modularity';
import { moduleRoutes } from '../src/modules/loader.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const manifest = moduleManifestSchema.parse({
  id: 'acme',
  name: 'Acme',
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
    defaults: { apiUrl: 'https://default.example', limit: '5' },
  },
});

const app = new Hono<AppEnv>();
app.route('/modules', moduleRoutes([{ packageName: 'acme', manifest, hasRoutes: false }]));
app.onError(errorHandler);

const API_URL = 'config:module:acme:global:apiUrl';
const LIMIT = 'config:module:acme:global:limit';

beforeEach(() => {
  h.written = 0;
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

describe('GET /modules/:id/settings/:kind', () => {
  it('falls back to the default when the stored value is not JSON', async () => {
    h.stored.set('config:module:acme:global:apiUrl', 'not json');
    h.stored.set('config:module:acme:global:limit', JSON.stringify('9'));
    const res = await app.request('/modules/acme/settings/global');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { values: Record<string, unknown> };
    expect(body.values).toEqual({ apiUrl: 'https://default.example', limit: '9' });
  });
});

describe('PUT /modules/:id/settings/:kind', () => {
  const put = (values: Record<string, unknown>) =>
    app.request('/modules/acme/settings/global', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    });

  it('records which fields changed, never their values', async () => {
    h.stored.clear();
    h.audits.length = 0;
    h.stored.set('config:module:acme:global:apiUrl', JSON.stringify('https://default.example'));
    const res = await put({ apiUrl: 'https://default.example', limit: 's3cr3t-limit' });
    expect(res.status).toBe(200);
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'module.settings',
        metadata: { moduleId: 'acme', kind: 'global', changed: ['limit'] },
      }),
    ]);
    expect(JSON.stringify(h.audits)).not.toContain('s3cr3t-limit');
  });

  it('records nothing for a body it refuses', async () => {
    h.audits.length = 0;
    const res = await put({ limit: 42 });
    expect(res.status).toBe(400);
    expect(h.audits).toEqual([]);
  });

  describe('when saves overlap or fail', () => {
    beforeEach(() => {
      h.stored.clear();
      h.audits.length = 0;
      h.stored.set(API_URL, JSON.stringify('https://default.example'));
      h.stored.set(LIMIT, JSON.stringify('5'));
    });

    it('saves one at a time, so the second records what the first wrote', async () => {
      const park = parkNextWrite();
      const queued = queuedBehindOther();
      const first = put({ apiUrl: 'https://one.example', limit: '5' });
      await park.parked;
      const second = put({ apiUrl: 'https://default.example', limit: '5' });
      await Promise.race([second, queued]);
      park.open();

      expect([(await first).status, (await second).status]).toEqual([200, 200]);
      expect(h.audits.map((audit) => audit.metadata)).toEqual([
        { moduleId: 'acme', kind: 'global', changed: ['apiUrl'] },
        { moduleId: 'acme', kind: 'global', changed: ['apiUrl'] },
      ]);
      expect(h.stored.get(API_URL)).toBe(JSON.stringify('https://default.example'));
      expect(h.locks).toEqual(['module-settings:acme:global', 'module-settings:acme:global']);
      expect(h.heldAtAudit, 'each row is written while the lock is held').toEqual([true, true]);
      expect(h.auditOnTx, 'each row is written on the transaction that holds it').toEqual([
        true,
        true,
      ]);
    });

    it('sets a lock timeout before it takes the lock', async () => {
      expect((await put({ apiUrl: 'https://one.example', limit: '5' })).status).toBe(200);
      expect(h.statements).toEqual([
        expect.stringMatching(/^SET LOCAL lock_timeout = '[1-9]\d*ms'$/),
        'select pg_advisory_xact_lock(hashtextextended(?, 0))',
      ]);
    });

    it('answers 503 and writes nothing when the wait for the lock runs out', async () => {
      h.lockFails = lockTimedOut();
      const res = await put({ apiUrl: 'https://one.example', limit: '6' });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: LOCK_BUSY, code: null });
      expect([h.audits, h.written]).toEqual([[], 0]);
      expect([h.stored.get(API_URL), h.stored.get(LIMIT)]).toEqual([
        JSON.stringify('https://default.example'),
        JSON.stringify('5'),
      ]);
    });

    it('stays a 500 when the lock fails for another reason', async () => {
      h.lockFails = new Error('terminating connection due to administrator command');

      expect((await put({ apiUrl: 'https://one.example', limit: '6' })).status).toBe(500);
      expect([h.audits, h.written]).toEqual([[], 0]);
    });

    it('records the field it already wrote, marked partial, and still fails', async () => {
      h.failAfterWrites = 1;
      const res = await put({ apiUrl: 'https://changed.example', limit: 's3cr3t-limit' });

      expect(res.status).toBe(500);
      expect(h.audits).toEqual([
        expect.objectContaining({
          action: 'module.settings',
          metadata: { moduleId: 'acme', kind: 'global', changed: ['apiUrl'], partial: true },
        }),
      ]);
      expect(JSON.stringify(h.audits)).not.toContain('s3cr3t-limit');
      expect([h.stored.get(API_URL), h.stored.get(LIMIT)]).toEqual([
        JSON.stringify('https://changed.example'),
        JSON.stringify('5'),
      ]);
      expect(h.heldAtAudit, 'the row is written while the lock is held').toEqual([true, true]);
      expect(h.auditOnTx, 'the row is written on the transaction that holds it').toEqual([
        true,
        true,
      ]);
    });

    it('records nothing when its first write fails', async () => {
      h.failAfterWrites = 0;
      expect((await put({ apiUrl: 'https://changed.example', limit: '6' })).status).toBe(500);
      expect(h.audits).toEqual([]);
    });
  });
});

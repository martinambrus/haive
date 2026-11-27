import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, Record<string, unknown>]>,
  error: null as unknown,
}));

vi.mock('postgres', () => ({
  default: (url: string, options: Record<string, unknown>) => {
    h.calls.push([url, options]);
    return {
      end: async () => {},
      unsafe: async () => {
        if (options.max === 5 && h.error) throw h.error;
        return [{ exists: 1 }];
      },
    };
  },
}));

import {
  GLOBAL_KB_ADMIN_DEADLINE_MS,
  resolveGlobalKbConnection,
  type GlobalKbSettings,
} from '../src/global-kb/connection.js';

const settings = (over: Partial<GlobalKbSettings>): GlobalKbSettings => ({
  enabled: true,
  digestEnabled: true,
  mode: 'external',
  namespace: 'default',
  connectionString: 'postgres://u:p@kb.example:5432/kb',
  ollamaUrl: null,
  embedModel: null,
  embeddingDimensions: 8,
  archiveRetentionDays: 30,
  ...over,
});

const existingDatabase = { execute: async () => [{ '?column?': 1 }] } as unknown as Database;

describe('resolveGlobalKbConnection pool options', () => {
  it('pins the internal admin deadline', () => expect(GLOBAL_KB_ADMIN_DEADLINE_MS).toBe(10_000));
  const before = process.env.DATABASE_URL;
  beforeEach(() => {
    h.calls = [];
    process.env.DATABASE_URL = `postgres://u:p@main-${expect
      .getState()
      .currentTestName?.replace(/[^a-z0-9]/gi, '')
      .toLowerCase()}.example:5432/haive`;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
  });

  it.each([
    ['external', {}],
    ['internal', { mode: 'internal' as const, connectionString: null }],
  ])('keeps postgres.js its own limits for a call that asks for none (%s)', async (_mode, over) => {
    await resolveGlobalKbConnection(settings(over), existingDatabase);
    expect(Object.keys(h.calls.at(-1)![1]).sort()).toEqual(
      _mode === 'internal' ? ['connection', 'max', 'onnotice'] : ['max', 'onnotice'],
    );
    expect(h.calls.at(-1)![1].connection).toEqual(
      _mode === 'internal' ? { client_connection_check_interval: 500 } : undefined,
    );
    expect(h.calls.at(-1)![1].max).toBe(5);
  });

  it.each([
    ['external', {}],
    ['internal', { mode: 'internal' as const, connectionString: null }],
  ])('hands the limits of one call to the pool it opens (%s)', async (_mode, over) => {
    await resolveGlobalKbConnection(settings(over), existingDatabase, {
      connectTimeoutSeconds: 3,
      fetchTypes: false,
    });
    expect(h.calls.at(-1)![1]).toMatchObject({ max: 5, connect_timeout: 3, fetch_types: false });
  });

  it('uses a disposable admin session with a server deadline, never the main executor', async () => {
    const execute = vi.fn();
    const signal = new AbortController().signal;
    await resolveGlobalKbConnection(settings({ mode: 'internal' }), { execute } as never, {
      deadlineMs: 17,
      signal,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(h.calls[0]![1]).toMatchObject({
      max: 1,
      fetch_types: false,
      connection: { statement_timeout: 17 },
    });
  });

  it('opens the pool of one call without touching the next call', async () => {
    await resolveGlobalKbConnection(settings({}), existingDatabase, { connectTimeoutSeconds: 3 });
    await resolveGlobalKbConnection(settings({}), existingDatabase);
    expect('connect_timeout' in h.calls[0]![1]).toBe(true);
    expect('connect_timeout' in h.calls[1]![1]).toBe(false);
  });
});

it('memoizes a successful internal database existence check per process and server', async () => {
  const before = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://u:p@memo-main.example:5432/haive';
  h.calls = [];
  try {
    await resolveGlobalKbConnection(settings({ mode: 'internal' }), existingDatabase);
    await resolveGlobalKbConnection(settings({ mode: 'internal' }), existingDatabase);
    expect(
      h.calls.filter(([, opts]) => opts.max === 1),
      'repeated internal admin handshake',
    ).toHaveLength(1);
    expect(h.calls.filter(([, opts]) => opts.max === 5)).toHaveLength(2);
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
  }
});

it.each(['raw', 'wrapped', 'message only'])(
  'invalidates internal database readiness only by SQLSTATE 3D000 (%s)',
  async (shape) => {
    const { withGlobalKbConnection } = await import('../src/global-kb/client.js');
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `postgres://u:p@drop-${shape.replaceAll(' ', '')}.example/haive`;
    h.calls = [];
    const opts = { settings: settings({ mode: 'internal' }) };
    try {
      await withGlobalKbConnection(
        existingDatabase,
        async ({ conn }) => conn.pg.unsafe('SELECT 1'),
        opts,
      );
      const error = Object.assign(new Error('opaque'), { code: '3D000' });
      h.error =
        shape === 'wrapped'
          ? new Error('opaque wrapper', { cause: error })
          : shape === 'raw'
            ? error
            : new Error('database does not exist 3D000');
      await expect(
        withGlobalKbConnection(
          existingDatabase,
          async ({ conn }) => conn.pg.unsafe('SELECT 1'),
          opts,
        ),
      ).rejects.toBe(h.error);
      h.error = null;
      await withGlobalKbConnection(
        existingDatabase,
        async ({ conn }) => conn.pg.unsafe('SELECT 1'),
        opts,
      );
      expect(
        h.calls.filter(([, options]) => options.max === 1),
        'missing database must be probed again on the next call',
      ).toHaveLength(shape === 'message only' ? 1 : 2);
    } finally {
      h.error = null;
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
  },
);

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const h = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown>]> }));

vi.mock('postgres', () => ({
  default: (url: string, options: Record<string, unknown>) => {
    h.calls.push([url, options]);
    return { end: async () => {} };
  },
}));

import { resolveGlobalKbConnection, type GlobalKbSettings } from '../src/global-kb/connection.js';

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
  const before = process.env.DATABASE_URL;
  beforeEach(() => {
    h.calls = [];
    process.env.DATABASE_URL = 'postgres://u:p@main.example:5432/haive';
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
    expect(Object.keys(h.calls[0]![1]).sort()).toEqual(['max', 'onnotice']);
    expect(h.calls[0]![1].max).toBe(5);
  });

  it.each([
    ['external', {}],
    ['internal', { mode: 'internal' as const, connectionString: null }],
  ])('hands the limits of one call to the pool it opens (%s)', async (_mode, over) => {
    await resolveGlobalKbConnection(settings(over), existingDatabase, {
      connectTimeoutSeconds: 3,
      fetchTypes: false,
    });
    expect(h.calls[0]![1]).toMatchObject({ max: 5, connect_timeout: 3, fetch_types: false });
  });

  it('opens the pool of one call without touching the next call', async () => {
    await resolveGlobalKbConnection(settings({}), existingDatabase, { connectTimeoutSeconds: 3 });
    await resolveGlobalKbConnection(settings({}), existingDatabase);
    expect('connect_timeout' in h.calls[0]![1]).toBe(true);
    expect('connect_timeout' in h.calls[1]![1]).toBe(false);
  });
});

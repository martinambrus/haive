import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

vi.mock('postgres', () => ({ default: () => ({ end: async () => {} }) }));

import { resolveGlobalKbConnection, type GlobalKbSettings } from '../src/global-kb/connection.js';
import { resolveRagConnection, type RagToolingPrefs } from '../src/rag/connection.js';

const pgError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });
const wrapped = (cause: Error): Error =>
  Object.assign(new Error('Failed query: CREATE DATABASE "x"\nparams: '), { cause });

const missingThenFails = (err: Error): Database =>
  ({
    execute: async (query: { queryChunks?: unknown[] }) => {
      if (JSON.stringify(query).includes('CREATE DATABASE')) throw err;
      return [];
    },
  }) as unknown as Database;

const kbSettings: GlobalKbSettings = {
  enabled: true,
  digestEnabled: true,
  mode: 'internal',
  namespace: 'default',
  connectionString: null,
  ollamaUrl: null,
  embedModel: null,
  embeddingDimensions: 8,
  archiveRetentionDays: 30,
};
const ragPrefs: RagToolingPrefs = {
  ragMode: 'internal',
  ragConnectionString: null,
  ollamaUrl: null,
  embeddingModel: null,
  embeddingDimensions: 8,
};

const SITES: Array<[string, (db: Database) => Promise<unknown>]> = [
  ['global KB', (db) => resolveGlobalKbConnection(kbSettings, db)],
  ['per-project RAG', (db) => resolveRagConnection(ragPrefs, db, 'project')],
];

describe.each(SITES)('CREATE DATABASE lost to a concurrent creator (%s)', (_site, resolve) => {
  const before = process.env.DATABASE_URL;
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://u:p@main.example:5432/haive';
  });
  afterEach(() => {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
  });

  const DUPLICATE_KEY =
    'duplicate key value violates unique constraint "pg_database_datname_index"';

  it.each([
    ['a unique violation on pg_database', pgError('23505', DUPLICATE_KEY)],
    ['duplicate_database', pgError('42P04', 'database "x" already exists')],
    ['a unique violation behind a query wrapper', wrapped(pgError('23505', DUPLICATE_KEY))],
    ['duplicate_database behind a query wrapper', wrapped(pgError('42P04', 'whatever'))],
  ])('ignores %s', async (_name, err) => {
    await expect(resolve(missingThenFails(err))).resolves.toBeDefined();
  });

  it.each([
    ['an "already exists" message with another code', pgError('42710', 'role "x" already exists')],
    ['an "already exists" message with no code', new Error('database "x" already exists')],
    [
      'an "already exists" message behind a wrapper with another code',
      wrapped(pgError('42710', 'already exists')),
    ],
    ['a permission error', pgError('42501', 'permission denied to create database')],
    ['an error with no code', new Error('connection refused')],
  ])('throws %s', async (_name, err) => {
    await expect(resolve(missingThenFails(err))).rejects.toBe(err);
  });
});

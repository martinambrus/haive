import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { dsnDialHost, resolveRagConnection } from '../src/rag/connection.js';
import { resolveGlobalKbConnection, type GlobalKbSettings } from '../src/global-kb/connection.js';
import { assertUserPostgresDsn } from '../src/egress/user-postgres-dsn.js';

vi.mock('postgres', async (original) => {
  const actual = await original<typeof import('postgres')>();
  return { ...actual, default: vi.fn(actual.default) };
});
afterEach(() => vi.mocked(postgres).mockClear());

const existing = fileURLToPath(new URL('../package.json', import.meta.url));
const absent = `${existing}.absent`;
const prefs = {
  ragMode: 'external' as const,
  ragConnectionString: '',
  ollamaUrl: null,
  embeddingModel: null,
  embeddingDimensions: 3,
};
const settings: GlobalKbSettings = {
  enabled: true,
  digestEnabled: true,
  mode: 'external',
  namespace: 'default',
  connectionString: null,
  ollamaUrl: null,
  embedModel: null,
  embeddingDimensions: 3,
  archiveRetentionDays: 30,
};

it.each(['sslrootcert', 'sslcert', 'sslkey'])(
  'refuses %s before the driver for existing and absent files in stored RAG and global KB DSNs',
  async (parameter) => {
    for (const path of [existing, absent, 'system', '']) {
      const dsn = `postgres://user@db.invalid/store?${parameter}=${encodeURIComponent(path)}`;
      for (const open of [
        () => resolveRagConnection({ ...prefs, ragConnectionString: dsn }, {} as Database, 'test'),
        () =>
          resolveRagConnection(
            { ...prefs, ragMode: 'ddev', ragConnectionString: dsn },
            {} as Database,
            'test',
            { trustedTarget: true },
          ),
        () => resolveGlobalKbConnection({ ...settings, connectionString: dsn }, {} as Database),
      ]) {
        const outcome = await open().then(
          async (conn) => {
            await conn?.close();
            return null;
          },
          (err: unknown) => err,
        );
        expect(outcome).toMatchObject({
          message: `PostgreSQL connection parameter "${parameter}" is not allowed`,
        });
        expect(postgres).not.toHaveBeenCalled();
      }
      expect(dsnDialHost(dsn)).toBeNull();
      expect(postgres).not.toHaveBeenCalled();
    }
  },
);

it.each([
  'postgres://user@%2Fvar%2Frun/store',
  'postgres://user@[%2Fvar%2Frun]:5432/store',
  'postgres://user@bad%,%2Fvar%2Frun/store',
  'postgres://user@db.invalid/store?host=%2Fvar%2Frun',
  'postgres://user@db.invalid/store?host=db.invalid&host=%2Fvar%2Frun',
  'postgres://user@%2Fvar%2Frun/store?host=',
])('refuses an explicit socket host before the driver: %s', async (dsn) => {
  await expect(
    resolveRagConnection({ ...prefs, ragConnectionString: dsn }, {} as Database, 'test'),
  ).rejects.toThrow('PostgreSQL connection parameter "host" is not allowed');
  expect(dsnDialHost(dsn)).toBeNull();
  expect(postgres).not.toHaveBeenCalled();
});

it.each([
  '?ssl%72ootcert=system',
  '?sslrootcert=%2Fprivate%2Ffile&sslrootcert=',
  '?sslrootcert=&sslmode=disable',
  '?sslmode=disable&sslcert=%2Fprivate%2Ffile',
  '?sslkey=%2Fprivate%2Ffile#ignored',
])('rejects driver query spellings and duplicates: %s', (query) => {
  expect(() => assertUserPostgresDsn(`postgres://user@db.invalid/store${query}`)).toThrow(
    /PostgreSQL connection parameter "ssl(rootcert|cert|key)" is not allowed/,
  );
  expect(postgres).not.toHaveBeenCalled();
});

it('preserves supported TLS, multi-host and userinfo parsing without treating ordinary parameters as files', async () => {
  const password = `${randomBytes(6).toString('hex')}@${randomBytes(6).toString('hex')}`;
  for (const [target, query] of [
    ['db.invalid', '?sslmode=verify-full'],
    ['[fd00::5]:5432', '?sslmode=require'],
    ['one.invalid,two.invalid', '?application_name=probe'],
    ['db.invalid', '?passfile=%2Fnot-a-local-selector&service=unused'],
    ['%2Fvar%2Frun', '?host=db.invalid'],
    ['db.invalid', '?host=%2Fvar%2Frun&host=db.invalid'],
  ] as const) {
    const dsn = `postgres://user:${password}@${target}/store${query}`;
    expect(() => assertUserPostgresDsn(dsn)).not.toThrow();
    const pg = postgres(dsn, { max: 1 });
    expect(pg.options.path).toBeFalsy();
    if (query.startsWith('?sslmode=')) expect(pg.options.ssl).toBe(query.slice(9));
    await pg.end({ timeout: 0 });
  }
});

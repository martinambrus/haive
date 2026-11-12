import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, tryCliAuthLock } from '../src/index.js';

const url = process.env.CLI_AUTH_LOCK_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/cli_secrets_audit_test'))
  throw new Error('Use a dedicated test database');
describe.skipIf(!url)('CLI auth session lock on PostgreSQL', () => {
  let db: ReturnType<typeof createDatabase>;
  let other: ReturnType<typeof createDatabase>;
  beforeAll(() => {
    db = createDatabase(url!);
    other = createDatabase(url!);
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await other.$client.end({ timeout: 5 });
  });
  it('excludes another process scope until release, without an idle transaction', async () => {
    const scope = randomUUID();
    const release = await tryCliAuthLock(db, scope);
    expect(release).not.toBeNull();
    try {
      expect(await tryCliAuthLock(other, scope)).toBeNull();
      const unrelated = await tryCliAuthLock(other, randomUUID());
      expect(unrelated).not.toBeNull();
      await unrelated?.();
      const rows =
        await db.$client`select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction'`;
      expect(rows).toHaveLength(0);
    } finally {
      await release?.();
    }
    const next = await tryCliAuthLock(other, scope);
    expect(next).not.toBeNull();
    await next?.();
    await next?.();
  });
  it('detects a terminated backend and refuses a protected write even after reconnect', async () => {
    const scope = randomUUID();
    const release = await tryCliAuthLock(db, scope);
    expect(release).not.toBeNull();
    let written = false;
    try {
      await release!.assertHeld();
      const [holder] = await other.$client`
        select pid from pg_locks where locktype = 'advisory'
        and classid = ((hashtextextended(${`cli-auth:${scope}`}, 0) >> 32) & 4294967295)::oid
        and objid = (hashtextextended(${`cli-auth:${scope}`}, 0) & 4294967295)::oid`;
      expect(holder?.pid).toBeTruthy();
      await other.$client`select pg_terminate_backend(${holder!.pid})`;
      const write = async () => {
        await release!.assertHeld();
        written = true;
      };
      await expect(write()).rejects.toThrow();
      await expect(write()).rejects.toThrow();
      expect(written).toBe(false);
    } finally {
      await release?.();
    }
  }, 15_000);
  it('does not wait on the main pool even when all ten connections are reserved', async () => {
    const held = await Promise.all(Array.from({ length: 10 }, () => db.$client.reserve()));
    try {
      const release = await tryCliAuthLock(db, randomUUID());
      expect(release).not.toBeNull();
      await release?.();
    } finally {
      for (const conn of held) conn.release();
    }
  });
});

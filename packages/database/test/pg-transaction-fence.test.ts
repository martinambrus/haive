import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

const url = process.env.PG_TX_FENCE_TEST_URL;
const required = createRequire(import.meta.url)('postgres');
const commonjs = (required.default ?? required) as typeof postgres;

// Both distributions are patched. This control must also run unpatched before removing the patch
// on an upgrade. It needs only its own table, not application fixtures or an opt-in probe flag.
describe.skipIf(!url)('postgres transaction handles stay fenced', () => {
  for (const [build, driver] of [
    ['ESM', postgres],
    ['CommonJS', commonjs],
  ] as const) {
    it(`${build}: an abandoned callback cannot write before or after reconnect`, async () => {
      const sql = driver(url!, { max: 1, onnotice: () => {} });
      const admin = driver(url!, { max: 1, onnotice: () => {} });
      const table = `tx_fence_${randomBytes(6).toString('hex')}`;
      const beforeReconnect = Promise.withResolvers<void>();
      const afterReconnect = Promise.withResolvers<void>();
      const started = Promise.withResolvers<number>();
      const firstAttempt = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const errors: unknown[] = [];
      const attempt = async (query: PromiseLike<unknown>): Promise<void> => {
        try {
          await query;
          errors.push(undefined);
        } catch (error) {
          errors.push(error);
        }
      };
      let result: Promise<unknown> | undefined;
      try {
        await admin`create table ${admin(table)} (value text)`;
        await admin`insert into ${admin(table)} values ('main')`;
        result = sql
          .begin(async (tx) =>
            tx.savepoint(async (nested) => {
              const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
              started.resolve(row!.pid);
              try {
                await beforeReconnect.promise;
                await attempt(tx`update ${tx(table)} set value = 'escaped'`);
                firstAttempt.resolve();
                await afterReconnect.promise;
                await attempt(tx.unsafe(`update ${table} set value = 'escaped'`));
                await attempt(nested`update ${nested(table)} set value = 'escaped'`);
              } finally {
                finished.resolve();
              }
            }),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        const pid = await started.promise;
        await admin`select pg_terminate_backend(${pid})`;
        // v4 reports the server's FATAL code when it was received before the close.
        expect(['CONNECTION_CLOSED', '57P01']).toContain(
          ((await result) as { code?: string }).code,
        );
        beforeReconnect.resolve();
        await firstAttempt.promise;
        const [reopened] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        expect(reopened!.pid).not.toBe(pid);
        afterReconnect.resolve();
        await finished.promise;
        const [row] = await admin`select value from ${admin(table)}`;
        expect(row!.value).toBe('main');
        expect(errors).toHaveLength(3);
        for (const error of errors) expect(error).toHaveProperty('code', 'CONNECTION_CLOSED');
      } finally {
        beforeReconnect.resolve();
        afterReconnect.resolve();
        await result;
        await sql.end({ timeout: 0 });
        await admin`drop table if exists ${admin(table)}`;
        await admin.end({ timeout: 0 });
      }
    });

    it(`${build}: committed transaction and savepoint handles cannot write after pool reuse`, async () => {
      const sql = driver(url!, { max: 1, onnotice: () => {} });
      const table = `tx_commit_${randomBytes(6).toString('hex')}`;
      const kept: postgres.TransactionSql[] = [];
      const errors: unknown[] = [];
      try {
        await sql`create table ${sql(table)} (value text)`;
        await sql`insert into ${sql(table)} values ('main')`;
        await sql.begin(async (tx) => {
          kept.push(tx);
          await tx.savepoint(async (nested) => {
            kept.push(nested);
            await nested.savepoint(async (deep) => {
              kept.push(deep);
              expect((await deep`select 1 as ok`)[0]!.ok).toBe(1);
            });
          });
          expect((await tx`select 1 as ok`)[0]!.ok).toBe(1);
        });
        const result = await sql.begin((tx) => [tx`select 2 as ok`, tx`select 3 as ok`]);
        expect(result.map((rows) => rows[0]!.ok)).toEqual([2, 3]);
        // The pooled connection has moved on to somebody else's live transaction.
        await sql.begin(async (tx) => {
          for (const old of kept) {
            for (const query of [
              old`update ${old(table)} set value = 'escaped'`,
              old.unsafe(`update ${table} set value = 'escaped'`),
            ]) {
              errors.push(
                await query.then(
                  () => undefined,
                  (error: unknown) => error,
                ),
              );
            }
          }
          expect((await tx`select value from ${tx(table)}`)[0]!.value).toBe('main');
        });
        expect(errors).toHaveLength(6);
        for (const error of errors) expect(error).toHaveProperty('code', 'UNSAFE_TRANSACTION');
        const reserved = await sql.reserve();
        try {
          expect((await reserved`select value from ${reserved(table)}`)[0]!.value).toBe('main');
        } finally {
          reserved.release();
        }
      } finally {
        await sql`drop table if exists ${sql(table)}`;
        await sql.end({ timeout: 0 });
      }
    });

    it(`${build}: callback rejection fences the old handle and preserves savepoint recovery`, async () => {
      const sql = driver(url!, { max: 1 });
      let old: postgres.TransactionSql | undefined;
      const failure = new Error('callback failed');
      try {
        await expect(
          sql.begin(async (tx) => {
            old = tx;
            await expect(
              tx.savepoint(async (nested) => {
                await nested`select 1 / 0`;
              }),
            ).rejects.toHaveProperty('code', '22012');
            // A failed savepoint must not fence its still-live parent transaction.
            expect((await tx`select 1 as ok`)[0]!.ok).toBe(1);
            throw failure;
          }),
        ).rejects.toBe(failure);
        await sql`select 1`;
        await expect(old!`select 1`).rejects.toBeDefined();
      } finally {
        await sql.end({ timeout: 0 });
      }
    });
  }
});

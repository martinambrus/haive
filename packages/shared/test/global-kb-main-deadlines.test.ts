import postgres from 'postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { withGlobalKb } from '../src/global-kb/client.js';
import type { GlobalKbSettings } from '../src/global-kb/connection.js';
import { fakeClock, stalledPostgres, until } from '../../../tests/fixtures/global-kb-wire.mjs';

let server: Awaited<ReturnType<typeof stalledPostgres>>;
let main: postgres.Sql;
afterEach(async () => {
  const ending = main?.end({ timeout: 0 });
  await vi.advanceTimersByTimeAsync(1);
  await ending;
  await server?.stop();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([false, true])(
  'cancels the internal existence/create query without leaving work on the main pool (create=%s)',
  async (create) => {
    fakeClock();
    server = await stalledPostgres(create);
    vi.stubEnv('DATABASE_URL', server.url);
    main = postgres(server.url, { max: 1, fetch_types: false });
    const settings: GlobalKbSettings = {
      enabled: true,
      digestEnabled: true,
      mode: 'internal',
      namespace: 'test',
      connectionString: null,
      ollamaUrl: null,
      embedModel: null,
      embeddingDimensions: 8,
      archiveRetentionDays: 30,
    };
    let outcome: unknown = 'pending';
    // Compile the Drizzle statement but send a simple query: the control is about pool
    // ownership, not Drizzle's prepared-statement/describe protocol.
    const execute = vi.fn(async (query: SQL) => main.unsafe(new PgDialect().sqlToQuery(query).sql));
    const db = { execute };
    const run = withGlobalKb(db as never, async () => 'never', {
      deadlineMs: 20,
      signal: new AbortController().signal,
      settings,
    }).catch((err) => {
      outcome = err;
    });
    await until(() =>
      server.queries.some((q) =>
        create ? q.startsWith('CREATE DATABASE') : q.includes('pg_database'),
      ),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(outcome).toMatchObject({ code: 'GLOBAL_KB_DEADLINE' });
    await run;
    await vi.advanceTimersByTimeAsync(1);
    expect(
      execute,
      'internal database bootstrap must not issue work on the shared main pool',
    ).not.toHaveBeenCalled();
    // I/O is drained without advancing another deadline: no accepted socket may remain abandoned.
    await until(() => server.open() === 0);
    expect(server.startups.join('')).toContain('statement_timeout\u000020\u0000');
  },
);

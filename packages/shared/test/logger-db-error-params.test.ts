import { randomBytes } from 'node:crypto';
import pino from 'pino';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { expect, it, vi } from 'vitest';
import { logger } from '../src/logger/index.js';

const url = process.env.DB_ERROR_PARAMS_TEST_URL;

it.skipIf(!url)('never logs a bound secret from a real failed insert', async () => {
  if (!new URL(url!).pathname.startsWith('/db_error_params_test')) {
    throw new Error('DB_ERROR_PARAMS_TEST_URL must name a db_error_params_test database');
  }
  const sql = postgres(url!, { max: 1 });
  const table = pgTable('logger_secret_control', { value: text('value').notNull() });
  const secret = randomBytes(24).toString('base64url');
  const lines: string[] = [];
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[
    pino.symbols.streamSym
  ]!;
  const write = vi.spyOn(stream, 'write').mockImplementation((line) => {
    lines.push(line);
  });
  try {
    await sql`CREATE TEMP TABLE logger_secret_control (value text CHECK (false))`;
    let caught: unknown;
    try {
      await drizzle(sql).insert(table).values({ value: secret });
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof Error).toBe(true);
    logger.child({ module: 'db-error-control' }).error({ err: caught }, 'insert failed');
    const logged = lines.join('\n');
    expect(
      Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
        logged.includes(part),
      ),
    ).toBe(false);
    const entry = JSON.parse(lines[0]!);
    expect(entry.err.type === 'DrizzleQueryError').toBe(true);
    expect(entry.err.code === '23514').toBe(true);
    expect(entry.err.query === 'insert into "logger_secret_control" ("value") values ($1)').toBe(
      true,
    );
  } finally {
    write.mockRestore();
    await sql.end({ timeout: 5 });
  }
});

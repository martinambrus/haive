import { randomBytes } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { expect, it, vi } from 'vitest';
import { logger } from '@haive/shared/logger';
import { putBackAfterFailure } from '../src/project-state/set-aside.js';

it.each([true, false])('fix4 keeps set-aside failure text safe (bound: %s)', async (bound) => {
  const secret = randomBytes(24).toString('base64url');
  const err = bound
    ? new DrizzleQueryError('select $1', [secret], new Error(secret))
    : new Error('ordinary diagnosis\n  keep spacing');
  const lines: string[] = [];
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[
    Object.getOwnPropertySymbols(logger).find((key) => key.description === 'pino.stream')!
  ]!;
  const spy = vi.spyOn(stream, 'write').mockImplementation((line) => {
    lines.push(line);
  });
  try {
    const aggregate = await putBackAfterFailure(
      {} as never,
      'repo',
      '/unused',
      new Map([['plan.json', {}]]) as never,
      err,
      async () => {
        throw new Error('put back failed');
      },
    ).catch((error: unknown) => error);
    expect(aggregate instanceof AggregateError).toBe(true);
    const text = JSON.stringify([...lines, (aggregate as Error).message]);
    expect(
      Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
        text.includes(part),
      ),
    ).toBe(false);
    expect(
      JSON.parse(lines[0]!).failure === (bound ? 'Database operation failed' : err.message),
    ).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

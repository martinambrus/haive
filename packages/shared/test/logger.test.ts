import { randomBytes } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import {
  logger,
  serializeError,
  safeErrorDetails,
  safeErrorMessage,
  safeErrorForTransport,
} from '../src/logger/index.js';

const secret = randomBytes(24).toString('base64url');
const query = 'insert into secrets (value) values ($1)';
function failure() {
  return new DrizzleQueryError(
    query,
    [secret],
    Object.assign(new Error(secret), {
      code: '23505',
      detail: secret,
      hint: secret,
    }),
  );
}
function capture() {
  const lines: string[] = [];
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[
    pino.symbols.streamSym
  ]!;
  vi.spyOn(stream, 'write').mockImplementation((line) => {
    lines.push(line);
  });
  return lines;
}
function assertSafe(value: unknown) {
  const text = JSON.stringify(value);
  expect(
    Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
      text.includes(part),
    ),
  ).toBe(false);
}
afterEach(() => vi.restoreAllMocks());

it('sanitizes response and queue failure text before a transport loses error structure', () => {
  const err = new Error(secret, { cause: failure() });
  assertSafe(safeErrorMessage(err));
  const transported = safeErrorForTransport(err) as Error;
  assertSafe({ message: transported.message, stack: transported.stack });
  expect(transported.cause === undefined).toBe(true);
  const ordinary = new Error('ordinary');
  expect(safeErrorMessage(ordinary)).toBe('ordinary');
  expect(safeErrorForTransport(ordinary)).toBe(ordinary);
});

it.each(['err', 'error', 'bare', 'implicit', 'wrapped'] as const)(
  'sanitizes %s logging through child loggers',
  (shape) => {
    const lines = capture();
    const log = logger.child({ module: 'control' }).child({ task: 'control' });
    const err = failure();
    if (shape === 'bare') log.error(err);
    else if (shape === 'implicit') log.error({ err });
    else if (shape === 'wrapped') log.error({ err: new Error(secret, { cause: err }) }, 'failed');
    else log.error({ [shape]: err }, 'failed');
    assertSafe(lines);
    const entry = JSON.parse(lines[0]!);
    const details = entry.error ?? entry.err;
    expect(details.query === query && details.code === '23505').toBe(true);
  },
);

it.each(['query', 'params'])(
  'detects a non-enumerable own %s property through deep causes',
  (key) => {
    let err = Object.defineProperty(new Error(secret), key, {
      value: key === 'query' ? query : [secret],
    });
    for (let i = 0; i < 12; i++) err = new Error(secret, { cause: err });
    assertSafe(serializeError(err));
  },
);

it('detects a DrizzleQueryError class even without its query/params fields', () => {
  class DrizzleQueryError extends Error {}
  assertSafe(serializeError(new DrizzleQueryError(secret)));
});

it('keeps the default serializer for other errors, including cause and extra fields', () => {
  const err = Object.assign(new TypeError('ordinary', { cause: new Error('cause') }), {
    code: 'EIO',
  });
  expect(serializeError(err)).toEqual(pino.stdSerializers.err(err));
  const lines = capture();
  logger.error({ err }, 'failed');
  expect(JSON.parse(lines[0]!).err).toEqual(
    JSON.parse(JSON.stringify(pino.stdSerializers.err(err))),
  );
});

it('terminates cyclic cause chains and preserves the driver code', () => {
  const err = failure();
  Object.assign(err.cause!, { cause: err });
  assertSafe(serializeError(err));
  expect(safeErrorDetails(err)).toEqual({ name: 'DrizzleQueryError', code: '23505' });
  const cycle = new Error('ordinary');
  cycle.cause = cycle;
  expect(safeErrorDetails(cycle)).toEqual({ name: 'Error' });
});

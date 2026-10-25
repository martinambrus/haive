import { randomBytes } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import pino from 'pino';
import postgres from 'postgres';
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

it.each(['params', 'parameters'])(
  'detects a non-enumerable own %s property through deep causes',
  (key) => {
    let err = Object.defineProperty(new Error(secret), key, {
      value: [secret],
    });
    for (let i = 0; i < 12; i++) err = new Error(secret, { cause: err });
    assertSafe(serializeError(err));
  },
);

it('keeps unbound Drizzle errors unchanged', () => {
  const err = new DrizzleQueryError(query, [], new Error('ordinary'));
  expect(safeErrorMessage(err) === err.message).toBe(true);
  expect(serializeError(err)).toEqual(pino.stdSerializers.err(err));
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

it.each(['err', 'error', 'bare'] as const)(
  'fix1 preserves the class through %s logging',
  (shape) => {
    const lines = capture();
    // The runtime takes server fields; postgres.js types inherit Error's string constructor.
    const driver = Object.assign(new postgres.PostgresError({ message: secret } as never), {
      code: '23505',
      query,
      parameters: [secret],
    });
    for (const err of [failure(), driver, new TypeError(secret, { cause: failure() })]) {
      if (shape === 'bare') logger.error(err);
      else logger.error({ [shape]: err });
      const entry = JSON.parse(lines.at(-1)!);
      expect((entry.err ?? entry.error).type === err.constructor.name).toBe(true);
    }
    assertSafe(lines);
  },
);

it.each(['127.0.0.1:1', 'haive-connection-control.invalid:1'])(
  'fix2 preserves real connection messages and codes in the logger for %s',
  async (host) => {
    const sql = postgres(`postgres://synthetic:synthetic@${host}/connection_control`, {
      max: 1,
      connect_timeout: 1,
    });
    let err: Error & { code: string };
    try {
      err = await sql`select 1`.catch((err) => err);
    } finally {
      await sql.end({ timeout: 5 });
    }
    const lines = capture();
    logger.error({ err: err! });
    const entry = JSON.parse(lines[0]!);
    expect(entry.err.message === err!.message && entry.err.code === err!.code).toBe(true);
    expect(entry.err.stack === err!.stack).toBe(true);
    expect(safeErrorMessage(err!) === err!.message).toBe(true);
  },
);

it('fix3 logs original diagnostics with job identity before transport replacement', () => {
  const lines = capture();
  const job = { name: 'probe-control', id: 'control-job' };
  const err = failure();
  const transported = safeErrorForTransport(err, job) as Error;
  expect(transported.message.includes('23505')).toBe(true);
  const entry = JSON.parse(lines[0] ?? '{}');
  expect(entry.name === job.name && entry.jobId === job.id).toBe(true);
  expect(
    entry.err?.type === 'DrizzleQueryError' &&
      entry.err?.query === query &&
      entry.err?.code === '23505',
  ).toBe(true);
  assertSafe([...lines, transported.message, transported.stack]);
});

it.each(['member', 'member-cause', 'nested', 'cycle'] as const)(
  'fix4 sanitizes an aggregate with a bound %s',
  (kind) => {
    const member = kind === 'member-cause' ? new Error(secret, { cause: failure() }) : failure();
    const aggregate = new AggregateError([new Error('ordinary'), member], secret);
    if (kind === 'nested') aggregate.errors = [new AggregateError(aggregate.errors, secret)];
    if (kind === 'cycle') {
      aggregate.errors.unshift(aggregate);
      member.cause = aggregate;
    }
    const lines = capture();
    logger.error({ err: aggregate });
    logger.error({ error: aggregate });
    logger.error(aggregate);
    assertSafe(lines);
    expect(JSON.parse(lines[0]!).err.type === 'AggregateError').toBe(true);
    expect(safeErrorMessage(aggregate)).toBe('Database operation failed');
    assertSafe((safeErrorForTransport(aggregate) as Error).message);
  },
);

it('fix4 keeps ordinary aggregate messages and stacks', () => {
  const err = new AggregateError([new TypeError('ordinary')], 'move failed; put back failed');
  expect(safeErrorMessage(err)).toBe(err.message);
  expect(safeErrorForTransport(err)).toBe(err);
  expect(serializeError(err)).toEqual(pino.stdSerializers.err(err));
});

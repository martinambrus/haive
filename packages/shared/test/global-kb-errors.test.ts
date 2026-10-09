import { describe, expect, it } from 'vitest';
import { GlobalKbDeadlineError, classifyGlobalKbError } from '../src/global-kb/errors.js';

const coded = (code: string, message = 'write ' + code + ' kb.internal.example:5432') =>
  Object.assign(new Error(message), { code });

describe('classifyGlobalKbError', () => {
  it.each([
    ['postgres.js connect timeout', coded('CONNECT_TIMEOUT'), 'timeout'],
    ['a socket timeout', coded('ETIMEDOUT'), 'timeout'],
    ['a statement cancelled by statement_timeout', coded('57014'), 'timeout'],
    ['the deadline', new GlobalKbDeadlineError(6000), 'timeout'],
    ['connection refused', coded('ECONNREFUSED'), 'refused'],
    ['connection reset', coded('ECONNRESET'), 'refused'],
    ['host unreachable', coded('EHOSTUNREACH'), 'refused'],
    ['network unreachable', coded('ENETUNREACH'), 'refused'],
    ['a host that does not resolve', coded('ENOTFOUND'), 'refused'],
    ['a resolver that is down', coded('EAI_AGAIN'), 'refused'],
    ['an invalid authorization', coded('28000'), 'auth'],
    ['a wrong password', coded('28P01'), 'auth'],
    ['a server signature that did not verify', coded('SASL_SIGNATURE_MISMATCH'), 'auth'],
    ['a missing relation', coded('42P01'), 'other'],
    ['a TLS failure', coded('DEPTH_ZERO_SELF_SIGNED_CERT'), 'other'],
    ['an error with no code', new Error('something else'), 'other'],
  ])('reads %s as %s', (_what, err, expected) => {
    expect(classifyGlobalKbError(err)).toBe(expected);
  });

  it('reads the code drizzle wraps, from the cause chain', () => {
    const wrapped = Object.assign(new Error('Failed query: select ...'), { cause: coded('57014') });
    expect(classifyGlobalKbError(wrapped)).toBe('timeout');
    const deeper = Object.assign(new Error('outer'), { cause: wrapped });
    expect(classifyGlobalKbError(deeper)).toBe('timeout');
  });

  it('stops walking a cyclic chain', () => {
    const a: { cause?: unknown } = new Error('a');
    const b: { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(classifyGlobalKbError(a)).toBe('other');
  });

  it('takes the first code it knows, outermost first', () => {
    const outer = Object.assign(coded('ECONNREFUSED'), { cause: coded('57014') });
    expect(classifyGlobalKbError(outer)).toBe('refused');
  });

  it('reads anything that is not an error as other, and never an inherited property as a code', () => {
    for (const value of [null, undefined, 'CONNECT_TIMEOUT', 42, {}, { code: 'constructor' }]) {
      expect(classifyGlobalKbError(value)).toBe('other');
    }
    expect(classifyGlobalKbError({ code: '__proto__' })).toBe('other');
  });

  it('returns a class and nothing of the error that said it', () => {
    const result = classifyGlobalKbError(coded('CONNECT_TIMEOUT'));
    expect(result).not.toContain('kb.internal.example');
    expect(['timeout', 'refused', 'auth', 'other']).toContain(result);
  });
});

describe('GlobalKbDeadlineError', () => {
  it('names its limit and carries a code the classifier knows', () => {
    const err = new GlobalKbDeadlineError(6000);
    expect(err.message).toBe('global KB call exceeded 6000 ms');
    expect(err.code).toBe('GLOBAL_KB_DEADLINE');
    expect(err).toBeInstanceOf(Error);
  });
});

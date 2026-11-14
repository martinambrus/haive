import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../src/logger/index.js';
import { dsnDialHost } from '../src/rag/connection.js';

const secret = (inner = '') =>
  `${randomBytes(6).toString('hex')}${inner}${randomBytes(6).toString('hex')}`;

describe('dsnDialHost', () => {
  // Dial targets measured through v4's transport/resolver, including a local IPv6 listener.
  it.each([
    ['postgres://u@db.lan:5432/rag', 'db.lan'],
    ['postgresql://u@10.0.0.5/rag', '10.0.0.5'],
    ['postgres://u@db.lan,other.lan/rag', null],
    ['postgres://u@h:abc/rag', null],
    ['postgres://u@/h:5432', 'localhost'],
    ['postgres://u@[::1]:5432/rag', '::1'],
    ['postgres://u@[fd00::5]:5432/rag', 'fd00::5'],
    ['postgres://u@%2Fvar%2Frun%2Fpostgresql/rag', null],
    ['postgres://u@ignored/rag?host=svc.lan', 'svc.lan'],
    ['postgres://u@ignored/rag?host=%2Fvar%2Frun%2Fpostgresql', null],
    ['postgres://u@ignored/rag?host=a.lan,b.lan', null],
    ['postgres://u@bad%20name/rag', null],
    ['postgres://u@%5B%3A%3A1%5D/rag', null],
    ['postgres://u@%20db.lan/rag', null],
    ['postgres://u@db.lan%0Aother.lan/rag', null],
    ['postgres://u@DB.Lan./rag', 'DB.Lan.'],
  ])('%s -> %j', (dsn, expected) => {
    expect(dsnDialHost(dsn)).toBe(expected);
  });

  it('reads a DSN with no host as the postgres.js default, never a socket path', () => {
    expect(dsnDialHost('postgres:///rag')).toBe('localhost');
  });

  it('never lets a malformed DSN with a password reach a log line or a thrown message', () => {
    const lines: string[] = [];
    const key = Object.getOwnPropertySymbols(logger).find(
      (symbol) => symbol.description === 'pino.stream',
    )!;
    const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[key]!;
    const spy = vi.spyOn(stream, 'write').mockImplementation((line) => {
      lines.push(line);
    });
    try {
      // An unescaped @ is accepted in v4 userinfo; an invalid port is still no hostname.
      const password = secret('@');
      let thrown = '';
      let value: string | null | undefined;
      try {
        value = dsnDialHost(`postgres://admin:${password}@db.lan:notaport/rag`);
      } catch (error) {
        thrown = String(error);
      }
      expect(value).toBeNull();
      expect(thrown).toBe('');
      expect(lines.join('')).not.toContain(password);
      expect(lines).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

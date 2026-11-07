import { describe, expect, it, vi } from 'vitest';
import { logger } from '../src/logger/index.js';
import { dsnDialHost } from '../src/rag/connection.js';

describe('dsnDialHost', () => {
  it.each([
    ['postgres://u:p@db.lan:5432/rag', 'db.lan'],
    ['postgresql://u:p@10.0.0.5/rag', '10.0.0.5'],
    ['postgres://u:p@db.lan,other.lan/rag', null],
    ['postgres://u:p@h:abc/rag', null],
    ['postgres://u:pw@/h:5432', null],
    ['postgres://u:p@[::1]:5432/rag', '['],
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
      let thrown = '';
      let value: string | null | undefined;
      try {
        value = dsnDialHost('postgres://admin:S3cretPw@db.lan:notaport/rag');
      } catch (error) {
        thrown = String(error);
      }
      expect(value).toBeNull();
      expect(thrown).toBe('');
      expect(lines.join('')).not.toContain('S3cretPw');
    } finally {
      spy.mockRestore();
    }
  });
});

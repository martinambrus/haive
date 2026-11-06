import { UPGRADE_JOURNAL_DDL } from '@haive/database';
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { ensureJournal, lastDoneChannel, recordAttempt } from './journal.js';

function mockAttemptSql() {
  const sql = Object.assign(
    vi.fn(async (..._args: unknown[]) => []),
    {
      json: vi.fn((v: unknown) => v),
    },
  );
  return Object.assign(sql, {
    begin: vi.fn(async (work: (tx: typeof sql) => Promise<void>) => work(sql)),
  });
}

describe('ensureJournal', () => {
  it('runs exactly the journal DDL the database package exports', async () => {
    const unsafe = vi.fn(async (..._args: unknown[]) => []);

    await ensureJournal({ unsafe } as unknown as Sql);

    expect(unsafe).toHaveBeenCalledTimes(1);
    expect(unsafe.mock.calls[0]?.[0]).toBe(UPGRADE_JOURNAL_DDL);
  });
});

describe('lastDoneChannel', () => {
  it('reads only the latest done channel with a stable id tie-break', async () => {
    const sql = vi.fn(async (..._args: unknown[]) => [{ channel: 'acme' }]);

    expect(await lastDoneChannel(sql as unknown as Sql)).toBe('acme');

    expect(sql).toHaveBeenCalledTimes(1);
    const [parts, ...values] = sql.mock.calls[0]!;
    const query = (parts as TemplateStringsArray).join('?').replace(/\s+/g, ' ').trim();
    expect(query).toBe(
      "SELECT channel FROM upgrade_runs WHERE status = 'done' ORDER BY started_at DESC, id DESC LIMIT 1",
    );
    expect(values).toEqual([]);
  });

  it('returns null when there is no done run', async () => {
    const sql = vi.fn(async () => []);
    expect(await lastDoneChannel(sql as unknown as Sql)).toBeNull();
  });
});

describe('recordAttempt', () => {
  it.each(['refused', 'failed'] as const)(
    'inserts one terminal %s row with an end timestamp',
    async (status) => {
      const sql = mockAttemptSql();
      await recordAttempt(sql as unknown as Sql, {
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        channel: 'public',
        status,
        error: 'reason',
        metadata: status === 'refused' ? { refusal: 'same-version' } : {},
      });
      expect(sql.begin).toHaveBeenCalledTimes(1);
      expect(sql).toHaveBeenCalledTimes(2);
      const [parts, ...values] = sql.mock.calls[0]!;
      expect((parts as TemplateStringsArray).join('?').replace(/\s+/g, ' ').trim()).toBe(
        "INSERT INTO upgrade_runs (from_version, to_version, channel, phase, status, error, metadata, ended_at) VALUES (?, ?, ?, 'preflight', ?, ?, ?, now())",
      );
      expect(values).toEqual([
        '1.0.0',
        '2.0.0',
        'public',
        status,
        'reason',
        status === 'refused' ? { refusal: 'same-version' } : {},
      ]);
    },
  );
});

it.each([2048, 2049, 1000000])('bounds stored attempt errors of length %i', async (length) => {
  const sql = mockAttemptSql();
  const error = 'x'.repeat(length);
  await recordAttempt(sql as unknown as Sql, {
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    channel: 'public',
    status: 'failed',
    error,
    metadata: {},
  });
  const stored = sql.mock.calls[0]![5] as string;
  expect(stored.length).toBeLessThanOrEqual(2048);
  if (length > 2048) expect(stored).toMatch(/\[truncated\]$/);
  else expect(stored).toBe(error);
});

it('stores a validated fallback for an invalid target in the non-nullable column', async () => {
  const sql = mockAttemptSql();
  await recordAttempt(sql as unknown as Sql, {
    fromVersion: '1.0.0',
    toVersion: 'bad/version',
    channel: 'public',
    status: 'failed',
    error: 'reason',
    metadata: {},
  });
  expect(sql.mock.calls[0]![2]).toBe('unknown');
});

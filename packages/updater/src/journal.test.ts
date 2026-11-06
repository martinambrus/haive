import { UPGRADE_JOURNAL_DDL } from '@haive/database';
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { ensureJournal, lastDoneChannel } from './journal.js';

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

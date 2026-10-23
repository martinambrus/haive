import { UPGRADE_JOURNAL_DDL } from '@haive/database';
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { ensureJournal } from './journal.js';

describe('ensureJournal', () => {
  it('runs exactly the journal DDL the database package exports', async () => {
    const unsafe = vi.fn(async (..._args: unknown[]) => []);

    await ensureJournal({ unsafe } as unknown as Sql);

    expect(unsafe).toHaveBeenCalledTimes(1);
    expect(unsafe.mock.calls[0]?.[0]).toBe(UPGRADE_JOURNAL_DDL);
  });
});

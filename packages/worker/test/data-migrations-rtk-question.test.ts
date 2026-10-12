import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { raiseRtkQuestions } from '../src/project-state/rtk-conflict.js';
import { runDataMigrations, runDestructiveDataMigrations } from '../src/data-migrations.js';

vi.mock('../src/project-state/rtk-conflict.js', () => ({ raiseRtkQuestions: vi.fn() }));

describe('the boot data migrations and the RTK question', () => {
  it('ask it at boot, as a convergent fix, and not after an upgrade is kept', async () => {
    const db = createFakeDb({ repositories: schema.repositories }).db as unknown as Database;

    await runDataMigrations(db);
    expect(raiseRtkQuestions).toHaveBeenCalledTimes(1);
    expect(raiseRtkQuestions).toHaveBeenCalledWith(db);

    vi.mocked(raiseRtkQuestions).mockClear();
    await runDestructiveDataMigrations(db).catch(() => undefined);
    expect(raiseRtkQuestions).not.toHaveBeenCalled();
  });
});

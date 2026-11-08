import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { ConfigUnavailableError, configService, retryWhileConfigUnavailable } from '@haive/shared';
import { DATA_MIGRATIONS, runDataMigrations, type DataMigration } from '../src/data-migrations.js';

const original = [...DATA_MIGRATIONS];
const install = (...migrations: DataMigration[]) =>
  DATA_MIGRATIONS.splice(0, DATA_MIGRATIONS.length, ...migrations);
const outage =
  (operation: string): DataMigration['run'] =>
  async () => {
    throw new ConfigUnavailableError(operation);
  };

afterEach(() => {
  DATA_MIGRATIONS.splice(0, DATA_MIGRATIONS.length, ...original);
  vi.restoreAllMocks();
});

describe('the boot data migrations and a configuration store outage', () => {
  const db = {} as Database;

  it('rethrows the typed outage so the boot retry owns it, and runs nothing after it', async () => {
    const later = vi.fn(async () => {});
    install(
      { id: 'needs-store', kind: 'convergent', run: outage('getFresh') },
      { id: 'later', kind: 'convergent', run: later },
    );

    await expect(runDataMigrations(db)).rejects.toBeInstanceOf(ConfigUnavailableError);
    expect(later).not.toHaveBeenCalled();
  });

  it('runs the migration again under the same retry the worker boots with', async () => {
    let calls = 0;
    const seed = vi.fn(async () => {
      if (++calls === 1) throw new ConfigUnavailableError('getFresh');
    });
    install({ id: 'seed', kind: 'convergent', run: seed });
    const sleep = vi.fn(async () => {});

    await retryWhileConfigUnavailable('worker bootstrap', () => runDataMigrations(db), { sleep });

    expect(seed).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('still logs and moves on for a failure that is not the outage', async () => {
    const later = vi.fn(async () => {});
    install(
      {
        id: 'broken',
        kind: 'convergent',
        run: async () => {
          throw new Error('boom');
        },
      },
      { id: 'later', kind: 'convergent', run: later },
    );

    await expect(runDataMigrations(db)).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('lets the outage the imported MCP server hold throws on purpose reach the boot retry', async () => {
    DATA_MIGRATIONS.splice(0, DATA_MIGRATIONS.length, ...original);
    vi.spyOn(configService, 'getEncryptionKey').mockRejectedValue(
      new ConfigUnavailableError('get'),
    );
    const fake = createFakeDb({ repositories: schema.repositories }).db as unknown as Database;

    await expect(runDataMigrations(fake)).rejects.toBeInstanceOf(ConfigUnavailableError);
  });
});

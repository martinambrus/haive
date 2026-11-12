import { ConfigService } from '../../src/config/config.service.js';
import { ConfigUnavailableError } from '../../src/config/config-unavailable.js';
import type { Database } from '@haive/database';

const service = new ConfigService();
let reserve: (() => void) | undefined;
let commit: (() => void) | undefined;
let discarded = false;
const db = {
  execute: async () => {
    await new Promise<void>((resolve) => {
      reserve = resolve;
      process.send!({ event: 'inventory' });
    });
    return [{ source: 'system_secrets', count: '1' }];
  },
  transaction: async (run: (tx: unknown) => Promise<unknown>) => {
    await new Promise<void>((resolve) => {
      commit = resolve;
      process.send!({ event: 'reserved' });
    });
    return run({
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: 'fixture' }] }),
        }),
      }),
      delete: async () => {
        discarded = true;
      },
    });
  },
} as unknown as Database;
process.on('message', async (command) => {
  if (command === 'reserve') {
    reserve!();
    return;
  }
  if (command === 'commit') {
    commit!();
    return;
  }
  if (command !== 'boot') return;
  try {
    await service.initialize(process.env.REDIS_URL, db);
    process.send!({ event: 'done', discarded, key: await service.getEncryptionKey() });
  } catch (error) {
    process.send!({
      event: 'error',
      retryable: error instanceof ConfigUnavailableError,
      message: (error as Error).message,
    });
  }
});

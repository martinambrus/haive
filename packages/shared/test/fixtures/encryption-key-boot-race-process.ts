import { Redis } from 'ioredis';
import { createDatabase } from '@haive/database';
import { CONFIG_KEYS, ConfigService } from '../../src/config/config.service.js';
import { ConfigUnavailableError } from '../../src/config/config-unavailable.js';
import {
  encryptionKeyBootDatabase,
  type EncryptionKeyBootDatabase,
} from '../../src/config/encryption-key-boot.js';

// One boot process against real stores. REDIS_URL, DATABASE_URL, CONFIG_ENCRYPTION_KEY,
// HAIVE_DISCARD_UNREADABLE_SECRETS and NODE_ENV are this process's own. With RACE_PAUSE=1 it holds
// right after its first Redis read of the encryption key came back empty, until told to resume.
const service = new ConfigService();
const client = createDatabase(process.env.DATABASE_URL!).$client;
const reader = new Redis(process.env.REDIS_URL!);
let resume: (() => void) | undefined;
let held = false;

// A test seam over a method that is private at compile time: the production code has no hook.
const seam = ConfigService.prototype as unknown as {
  redisCall: <T>(operation: string, run: (redis: Redis) => Promise<T>) => Promise<T>;
};
const redisCall = seam.redisCall;
seam.redisCall = async function <T>(
  this: unknown,
  operation: string,
  run: (redis: Redis) => Promise<T>,
): Promise<T> {
  const result = (await redisCall.call(this, operation, run)) as T;
  if (process.env.RACE_PAUSE === '1' && !held && operation === 'ensureEncryptionKey') {
    held = true;
    // The first read is `exists`; this process must have seen it empty.
    if ((result as unknown) !== 0)
      throw new Error('RACE_PAUSE expects an empty Redis at the first read');
    await new Promise<void>((release) => {
      resume = release;
      process.send!({ event: 'paused' });
    });
  }
  return result;
};

const boot = encryptionKeyBootDatabase(client);
const db = {
  execute: boot.execute.bind(boot),
  // Reported before a discard opens: the parent learns which key Redis held at that moment.
  transaction: async (...args: Parameters<EncryptionKeyBootDatabase['transaction']>) => {
    process.send!({ event: 'discarding', redisKey: await reader.get(CONFIG_KEYS.ENCRYPTION_KEY) });
    return boot.transaction(...args);
  },
} as unknown as EncryptionKeyBootDatabase;

process.on('message', async (command) => {
  if (command === 'resume') {
    resume?.();
    return;
  }
  if (command !== 'boot') return;
  try {
    await service.initialize(process.env.REDIS_URL, db);
    process.send!({ event: 'done', key: await service.getEncryptionKey() });
  } catch (error) {
    process.send!({
      event: 'error',
      retryable: error instanceof ConfigUnavailableError,
      name: (error as Error).name,
      message: (error as Error).message,
    });
  }
});

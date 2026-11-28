#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema } from '@haive/database';
import {
  SecretUnreadableError,
  configService,
  encryptionKeyBootDatabase,
  secretsService,
} from '@haive/shared';
import { safeErrorMessage } from '@haive/shared/logger';
import { recoverAdmin } from './recover-admin.js';

export async function main(args = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      email: { type: 'string' },
      'user-id': { type: 'string' },
      force: { type: 'boolean' },
    },
  });
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl || !values.email) {
    process.stderr.write(
      'Usage: recover-admin --email <addr> [--user-id <id>] [--force]; DATABASE_URL and REDIS_URL are required\n',
    );
    return 2;
  }
  const client = postgres(databaseUrl, { max: 1, max_lifetime: 0 });
  try {
    const db = drizzle(client, { schema });
    let key: string;
    let pepper: string;
    try {
      // Boot gets its own client: Drizzle rewires codecs on the one it wraps.
      const bootClient = postgres(databaseUrl, { max: 1, max_lifetime: 0 });
      try {
        await configService.initialize(redisUrl, () => encryptionKeyBootDatabase(bootClient));
      } finally {
        await bootClient.end({ timeout: 5 }).catch(() => {});
      }
      await secretsService.initialize(db);
      key = await configService.getEncryptionKey();
      pepper = await secretsService.getEmailBlindIndexPepper();
    } catch (err) {
      // A stored secret this key cannot read means the key (or Redis) is not this install's. The
      // boot message offers the discard override, which would delete this install's secrets.
      if (!(err instanceof SecretUnreadableError)) throw err;
      throw new Error(
        `This encryption key does not decrypt the stored system secrets (${err.secretKeys.join(', ')}): check DATABASE_URL, REDIS_URL and the key belong to this install. Nothing was changed.`,
        { cause: err },
      );
    }
    const result = await recoverAdmin(db, {
      email: values.email,
      userId: values['user-id'],
      force: values.force,
      reportInvalidationCount: (count) =>
        process.stdout.write(`Accounts whose passwords will be invalidated: ${count}\n`),
      key,
      pepper,
    });
    // Print only after commit. The password is never logged or stored as plaintext.
    process.stdout.write(
      `Recovered admin ${result.userId}. Change the password after signing in.\nTemporary password: ${result.temporaryPassword}\n`,
    );
    return 0;
  } finally {
    await configService.close().catch(() => {});
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => undefined)) ===
    (await realpath(fileURLToPath(import.meta.url)))
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

import { randomUUID } from 'node:crypto';
import { createDatabase, schema, type Database } from '@haive/database';
import { computeEmailBlindIndex, encryptEmail } from '@haive/shared';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { hashPassword } from '../src/auth/password.js';

export const FIELD_KEY = 'ab'.repeat(32);
export const PASSWORD = 'synthetic-original-password-1';

/** Pause both requests AFTER Postgres has returned their old state. Writes still run on
 * separate real connections: no fake database or scheduler decides which UPDATE wins. */
export function concurrentReads(table: string, needsPassword = false) {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  return {
    release,
    async afterRead(name: string, options: { columns?: { passwordHash?: boolean } }) {
      if (name !== table || (needsPassword && !options.columns?.passwordHash)) return;
      if (++arrived === 2) release();
      await ready;
    },
  };
}

export function instrumentDb<T extends object>(
  db: T,
  afterRead: (table: string, options: any) => Promise<void>,
  failInsert = false,
): T {
  return new Proxy(db, {
    get(target, key) {
      const value: any = Reflect.get(target, key, target);
      if (key === 'transaction') {
        return (fn: (tx: unknown) => Promise<unknown>) =>
          value.call(target, (tx: object) => fn(instrumentDb(tx, afterRead, failInsert)));
      }
      if (key === 'insert' && failInsert) {
        return (table: unknown) => {
          if (table === schema.refreshTokens) throw new Error('synthetic session insert failure');
          return value.call(target, table);
        };
      }
      if (key === 'query') {
        return new Proxy(value, {
          get(tables, table) {
            const query = Reflect.get(tables, table);
            return new Proxy(query, {
              get(methods, method) {
                if (method !== 'findFirst') return Reflect.get(methods, method);
                return async (options: unknown) => {
                  const row = await methods.findFirst(options);
                  await afterRead(String(table), options);
                  return row;
                };
              },
            });
          },
        });
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export async function makeUser(db: Database) {
  const email = `${randomUUID()}@auth-hardening.test.local`;
  const [user] = await db
    .insert(schema.users)
    .values({
      emailEncrypted: encryptEmail(email, FIELD_KEY),
      emailBlindIndex: computeEmailBlindIndex(email, 'ef'.repeat(32)),
      passwordHash: await hashPassword(PASSWORD),
      role: 'user',
    })
    .returning();
  const cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: user!.id, role: 'user', tv: 0 })}`;
  return { user: user!, cookie };
}

export { createDatabase, schema };

import { readFileSync, rmSync } from 'node:fs';
import { request } from '@playwright/test';
import { REGISTERED_USERS_FILE_ENV, type RegisteredUser } from './helpers/auth.js';
import { getSql, removeUser } from './helpers/db.js';

/** Removes every account this run registered that is still there: a test that timed out or
 *  crashed before its own cleanup leaves its user, and whatever the user owns, behind. */
export default async function globalTeardown(): Promise<void> {
  const file = process.env[REGISTERED_USERS_FILE_ENV];
  if (!file) return;
  const users = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RegisteredUser);
  const sql = getSql();
  try {
    for (const user of users) {
      try {
        await removeUser(sql, request, user);
      } catch (err) {
        console.warn(`could not remove e2e user ${user.userId}: ${String(err)}`);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
    rmSync(file, { force: true });
  }
}

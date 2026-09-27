import { test as base, type APIRequestContext } from '@playwright/test';
import type postgres from 'postgres';
import { registerUser, type RegisteredUser } from './auth.js';
import { getSql, removeUser, REPO_DELETE_DEADLINE_MS, TASK_CANCEL_DEADLINE_MS } from './db.js';

export interface TestUsers {
  /** `registerUser`, with the account and everything it owns removed once the test ends. */
  register(
    request: APIRequestContext,
    opts: Parameters<typeof registerUser>[2],
  ): Promise<RegisteredUser>;
}

/**
 * A test that times out is abandoned where it waits, so its own `finally` may never run, and a
 * task it seeded `running` is then left for the dev worker to act on. A fixture's teardown always
 * runs, on a time budget of its own.
 */
export const test = base.extend<{ sql: postgres.Sql; users: TestUsers }>({
  sql: async ({}, use) => {
    const sql = getSql();
    await use(sql);
    await sql.end({ timeout: 5 });
  },
  users: [
    async ({ sql, playwright }, use) => {
      const registered: RegisteredUser[] = [];
      await use({
        register: async (request, opts) => {
          const user = await registerUser(sql, request, opts);
          registered.push(user);
          return user;
        },
      });
      for (const user of registered.reverse()) await removeUser(sql, playwright.request, user);
    },
    { timeout: REPO_DELETE_DEADLINE_MS + TASK_CANCEL_DEADLINE_MS + 60_000 },
  ],
});

export { expect } from '@playwright/test';

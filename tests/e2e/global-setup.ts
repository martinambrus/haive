import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from '@playwright/test';
import { REGISTERED_USERS_FILE_ENV, registerUser } from './helpers/auth.js';
import { getSql } from './helpers/db.js';

const WEB_BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
const NIL = '00000000-0000-4000-8000-000000000000';
// `next dev` compiles a route on its first request. Public pages go before signing in (a signed-in
// visit redirects), the rest as an admin, since the middleware and admin pages redirect anyone else.
const PUBLIC_ROUTES = ['/login', '/register'];
const SIGNED_IN_ROUTES = [
  '/dashboard',
  '/tasks',
  '/tasks/new',
  `/tasks/${NIL}`,
  '/repos',
  '/repos/new',
  `/repos/${NIL}`,
  `/repos/${NIL}/plan`,
  `/repos/${NIL}/tooling`,
  `/repos/${NIL}/estimates`,
  '/settings',
  '/settings/account',
  '/settings/git-identity',
  '/settings/global-kb',
  '/cli-providers',
  `/cli-providers/${NIL}`,
  '/stats',
  '/admin',
  '/admin/users',
  '/admin/pricing',
  '/admin/audit',
];
const COMPILE_TIMEOUT_MS = 180_000;

/** Starts this run's record of registered accounts; the workers inherit the variable. */
export default async function globalSetup(): Promise<void> {
  const file = path.join(os.tmpdir(), `haive-e2e-users-${process.pid}-${Date.now()}.jsonl`);
  writeFileSync(file, '');
  process.env[REGISTERED_USERS_FILE_ENV] = file;
  await warmDevRoutes();
}

async function warmDevRoutes(): Promise<void> {
  const started = Date.now();
  const sql = getSql();
  const context = await request.newContext();
  const took: string[] = [];
  const warm = async (route: string) => {
    const begun = Date.now();
    const res = await context.get(new URL(route, WEB_BASE).toString(), {
      maxRedirects: 0,
      timeout: COMPILE_TIMEOUT_MS,
    });
    took.push(`${route} ${res.status()} in ${Date.now() - begun} ms`);
  };
  try {
    for (const route of PUBLIC_ROUTES) await warm(route);
    await registerUser(sql, context, { prefix: 'warm-up', role: 'admin' });
    for (const route of SIGNED_IN_ROUTES) await warm(route);
    console.log(`dev routes warmed in ${Date.now() - started} ms: ${took.join(', ')}`);
  } catch (err) {
    console.warn(`dev routes not warmed, the specs may meet a cold compile: ${String(err)}`);
  } finally {
    await context.dispose();
    await sql.end({ timeout: 5 });
  }
}

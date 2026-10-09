import { readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request, type FullConfig } from '@playwright/test';
import { REGISTERED_USERS_FILE_ENV, registerUser } from './helpers/auth.js';
import { getSql } from './helpers/db.js';

const WEB_BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
const NIL = '00000000-0000-4000-8000-000000000000';
const PAGE_FILE = /^page\.(tsx|ts|jsx|js)$/;
const COMPILE_TIMEOUT_MS = 180_000;

/** Starts this run's record of registered accounts; the workers inherit the variable. */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const file = path.join(os.tmpdir(), `haive-e2e-users-${process.pid}-${Date.now()}.jsonl`);
  writeFileSync(file, '');
  process.env[REGISTERED_USERS_FILE_ENV] = file;
  await warmDevRoutes(path.join(path.dirname(config.configFile ?? ''), 'packages/web/src/app'));
}

/** Every page of the web app as a URL: a route group adds no segment, a dynamic one takes the nil id. */
function pageRoutes(
  dir: string,
  url = '',
  groups: string[] = [],
): { url: string; groups: string[] }[] {
  const found: { url: string; groups: string[] }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && PAGE_FILE.test(entry.name)) found.push({ url: url || '/', groups });
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    if (entry.name.startsWith('(')) found.push(...pageRoutes(sub, url, [...groups, entry.name]));
    else
      found.push(
        ...pageRoutes(sub, `${url}/${entry.name.startsWith('[') ? NIL : entry.name}`, groups),
      );
  }
  return found;
}

async function warmDevRoutes(appDir: string): Promise<void> {
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
    // `next dev` compiles a route on its first request. The (auth) pages go before signing in (a
    // signed-in visit redirects), the rest as an admin, since the middleware redirects anyone else.
    const pages = pageRoutes(appDir);
    for (const page of pages) if (page.groups.includes('(auth)')) await warm(page.url);
    await registerUser(sql, context, { prefix: 'warm-up', role: 'admin' });
    for (const page of pages) if (!page.groups.includes('(auth)')) await warm(page.url);
    console.log(`dev routes warmed in ${Date.now() - started} ms: ${took.join(', ')}`);
  } catch (err) {
    console.warn(`dev routes not warmed, the specs may meet a cold compile: ${String(err)}`);
  } finally {
    await context.dispose();
    await sql.end({ timeout: 5 });
  }
}

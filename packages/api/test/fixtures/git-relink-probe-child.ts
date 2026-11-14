import { Hono } from 'hono';
import { initDatabase } from '../../src/db.js';
import { repoRoutes } from '../../src/routes/repos.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import type { AppEnv } from '../../src/context.js';

// Only the gated parent starts this process; no production entry point uses it.
if (!process.env.RELINK_DATABASE_URL) throw new Error('RELINK_DATABASE_URL is required');
const [url, actor, repository, remoteUrl] = process.argv.slice(2);
const target = new URL(url!);
if (
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  target.pathname !== '/relink_test' ||
  Number(target.port) < 1024
)
  throw new Error('Use the disposable relink_test database');
const db = initDatabase(url!);
const transaction = db.transaction.bind(db);
db.transaction = (callback, config) =>
  transaction(async (tx) => {
    const result = await callback(tx);
    process.send?.('before_commit');
    await new Promise<never>(() => undefined);
    return result;
  }, config);

// Invoke the production route with the same authenticated-context seam as the parent.
const handler = repoRoutes.routes.find(
  (route) => route.method === 'POST' && route.path === '/:id/remote',
)?.handler;
if (!handler) throw new Error('Relink handler not found');
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', actor!);
  await next();
});
app.post('/:id/remote', handler);
app.onError(errorHandler);
await app.request(`/${repository}/remote`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ remoteUrl }),
});

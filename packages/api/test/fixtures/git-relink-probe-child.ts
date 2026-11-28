import { Hono } from 'hono';
import { configService } from '@haive/shared';
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
initDatabase(url!);
// This process has no configuration store; the relink is admitted in the normal state.
configService.getFresh = async () => 'normal';

// Mount both production handlers: the mutation-claim middleware and the relink itself.
const handlers = repoRoutes.routes.filter(
  (route) => route.method === 'POST' && route.path === '/:id/remote',
);
if (handlers.length !== 2) throw new Error('Relink handlers not found');
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', actor!);
  await next();
});
for (const route of handlers) app.post('/:id/remote', route.handler);
app.onError(errorHandler);
await app.request(`/${repository}/remote`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ remoteUrl }),
});

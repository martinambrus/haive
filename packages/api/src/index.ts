import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from '@haive/shared';
import { bootstrap } from './bootstrap.js';
import type { AppEnv } from './context.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { cliProviderRoutes } from './routes/cli-providers.js';
import { repoRoutes } from './routes/repos.js';
import { repoCredentialsRoutes } from './routes/repo-credentials.js';
import { githubOauthRoutes } from './routes/github-oauth.js';
import { filesystemRoutes } from './routes/filesystem.js';
import { taskRoutes } from './routes/tasks.js';
import { installTerminalWebSocket } from './routes/terminal.js';
import { terminalSessionRoutes } from './routes/terminal-sessions.js';

export function createApiApp(webOrigin: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requestLogger);
  app.use(
    '*',
    cors({
      origin: webOrigin,
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );

  app.onError(errorHandler);

  app.get('/health', (c) => c.json({ status: 'ok', service: 'haive-api' }));

  app.route('/auth', authRoutes);
  app.route('/cli-providers', cliProviderRoutes);
  app.route('/repos', repoRoutes);
  app.route('/repo-credentials', repoCredentialsRoutes);
  app.route('/github-oauth', githubOauthRoutes);
  app.route('/filesystem', filesystemRoutes);
  app.route('/tasks', taskRoutes);
  app.route('/terminal-sessions', terminalSessionRoutes);
  app.route('/admin', adminRoutes);

  return app;
}

async function main(): Promise<void> {
  const { apiPort, webOrigin } = await bootstrap();

  const app = createApiApp(webOrigin);

  const server = serve({ fetch: app.fetch, port: apiPort }, (info) => {
    logger.info({ port: info.port }, 'haive-api listening');
  }) as unknown as Server;

  installTerminalWebSocket(server);
}

const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/packages/api/src/index.ts') ||
  process.argv[1]?.endsWith('/packages/api/dist/index.js');

if (invokedAsScript) {
  main().catch((err) => {
    logger.error({ err }, 'API bootstrap failed');
    process.exit(1);
  });
}

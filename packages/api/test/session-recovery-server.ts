/** Isolated browser fixture: real auth routes, signing, middleware and Postgres rotation.
 * Synthetic secrets and authenticated sidebar fixtures keep this independent of provider APIs. */
import type { Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileRoutes } from '../src/routes/tasks/files.js';
import { serve } from '@hono/node-server';
import { installTerminalWebSocket } from '../src/routes/terminal.js';
import { installIdeWebSocket } from '../src/routes/ide.js';
import jwt from 'jsonwebtoken';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { configService, secretsService, decryptEmail, CONFIG_KEYS } from '@haive/shared';
import { eq } from 'drizzle-orm';
import { initDatabase } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { authRoutes } from '../src/routes/auth.js';
import { userSettingsRoutes } from '../src/routes/user-settings.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requireAuth } from '../src/middleware/auth.js';
import { setAuthCookies } from '../src/auth/cookies.js';
import { signAccessToken, signRefreshToken, hashRefreshToken } from '../src/auth/jwt.js';
import { isForeignOrigin } from '../src/lib/request-origin.js';
import type { AppEnv } from '../src/context.js';
import { FIELD_KEY, makeUser, schema } from './auth-hardening-db.js';

const url = process.env.SESSION_RECOVERY_DATABASE_URL;
if (
  !url ||
  new URL(url).host !== '127.0.0.1:46537' ||
  !new URL(url).pathname.startsWith('/auth_hardening_test')
) {
  throw new Error('Use the isolated fixture port and an auth_hardening_test database');
}
const redisUrl = process.env.SESSION_RECOVERY_REDIS_URL;
if (!redisUrl || new URL(redisUrl).host !== '127.0.0.1:46437') {
  throw new Error('Use the isolated Redis fixture port');
}
const db = initDatabase(url);
initRedis(redisUrl);
configService.getEncryptionKey = async () => FIELD_KEY;
let registrationMode: 'open' | 'closed' = 'closed';
configService.get = async (key) =>
  key === CONFIG_KEYS.REGISTRATION_MODE ? registrationMode : null;
secretsService.getJwtSecret = async () => 'cd'.repeat(32);
secretsService.getEmailBlindIndexPepper = async () => 'ef'.repeat(32);
const web = process.env.SESSION_RECOVERY_WEB_ORIGIN ?? 'http://127.0.0.1:46100';
const app = new Hono<AppEnv>().onError(errorHandler);
const workspaces = new Map<string, string>();
let meStatus: 503 | null = null;
let holdNextMe = false;
let heldMe = false;
let releaseMe: (() => void) | undefined;
app.use('*', cors({ origin: web, credentials: true }));
app.use('*', async (c, next) => {
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    isForeignOrigin(c.req.header('origin'), c.req.header('host'), [web])
  ) {
    return c.json({ error: 'Foreign origin' }, 403);
  }
  await next();
});
app.post('/__fixture/me-status', async (c) => {
  meStatus = (await c.req.json<{ status: 503 | null }>()).status;
  return c.json({ ok: true });
});
app.post('/__fixture/registration-mode', async (c) => {
  registrationMode = (await c.req.json<{ mode: 'open' | 'closed' }>()).mode;
  return c.json({ ok: true });
});
app.post('/__fixture/hold-me', (c) => {
  holdNextMe = true;
  return c.json({ ok: true });
});
app.get('/__fixture/held-me', (c) => c.json({ held: heldMe }));
app.post('/__fixture/release-me', (c) => {
  releaseMe?.();
  return c.json({ ok: true });
});
app.use('/auth/me', async (c, next) => {
  if (meStatus) return c.json({ error: 'Synthetic upstream unavailable' }, meStatus);
  const hold = holdNextMe;
  holdNextMe = false;
  await next();
  if (hold) {
    heldMe = true;
    await new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    heldMe = false;
    releaseMe = undefined;
  }
});
app.post('/__fixture/session', async (c) => {
  const { user } = await makeUser(db);
  const body = await c.req.json<{ role?: 'admin' | 'user'; mustChangePassword?: boolean }>();
  await db
    .update(schema.users)
    .set({ role: body.role ?? 'user', mustChangePassword: body.mustChangePassword ?? false })
    .where(eq(schema.users.id, user.id));
  const access = await signAccessToken({ sub: user.id, role: body.role ?? 'user', tv: 0 });
  const { token, expiresAt } = await signRefreshToken(user.id, 0);
  await db
    .insert(schema.refreshTokens)
    .values({ userId: user.id, tokenHash: hashRefreshToken(token), expiresAt });
  setAuthCookies(c, access, token);
  return c.json({ id: user.id, email: decryptEmail(user.emailEncrypted, FIELD_KEY) });
});
app.post('/__fixture/workspace/:id', async (c) => {
  const userId = c.req.param('id');
  const root = await mkdtemp(join(tmpdir(), 'h2b-raw-'));
  workspaces.set(userId, root);
  const svgPath = join(root, 'untrusted.svg');
  await writeFile(
    svgPath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><script>localStorage.setItem("raw-script-ran","yes")</script><rect width="16" height="16" fill="red"/></svg>',
  );
  const [repo] = await db
    .insert(schema.repositories)
    .values({
      userId,
      name: 'Raw fixture',
      source: 'local_path',
      localPath: root,
    })
    .returning();
  const [task] = await db
    .insert(schema.tasks)
    .values({
      userId,
      repositoryId: repo!.id,
      title: 'Raw fixture',
      type: 'workflow',
    })
    .returning();
  return c.json({ taskId: task!.id, svgPath });
});
app.use('/tasks/*', requireAuth);
app.route('/tasks', fileRoutes);
app.delete('/__fixture/session/:id', async (c) => {
  await db.delete(schema.users).where(eq(schema.users.id, c.req.param('id')));
  const root = workspaces.get(c.req.param('id'));
  if (root) await rm(root, { recursive: true, force: true });
  workspaces.delete(c.req.param('id'));
  return c.json({ ok: true });
});
app.post('/__fixture/expire-access/:id', (c) => {
  const token = jwt.sign({ sub: c.req.param('id'), role: 'user', tv: 0 }, 'cd'.repeat(32), {
    algorithm: 'HS256',
    expiresIn: -60,
  });
  c.header('set-cookie', `haive_access=${token}; Path=/; HttpOnly; SameSite=Lax`);
  return c.json({ ok: true });
});
app.route('/auth', authRoutes);
app.post('/__fixture/echo', requireAuth, (c) => new Response(c.req.raw.body));
app.get('/__fixture/events', requireAuth, (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: 'first' });
    await stream.sleep(35_000);
    await stream.writeSSE({ data: 'after-default-proxy-timeout' });
  }),
);
app.get('/ide/:id/*', requireAuth, (c) =>
  c.req.path.endsWith('/redirect')
    ? c.redirect(`/ide/${c.req.param('id')}/asset.js`)
    : c.text('editor asset'),
);
app.get('/user-settings/ui-prefs', requireAuth, (c) =>
  c.json({ settingsJson: '{"sidebarWidthPx":333}' }),
);
app.get('/modules', requireAuth, (c) =>
  c.json({
    modules: [
      {
        id: 'session-fixture',
        name: 'Session fixture',
        version: '1',
        nav: [{ href: '/m/session-fixture', label: 'Authenticated fixture' }],
        pages: {},
        hasGlobalSettings: false,
        hasAdminSettings: false,
        compiledWeb: false,
      },
    ],
  }),
);
app.get('/system/state', requireAuth, (c) => c.json({ globalPause: false, maintenance: 'normal' }));
app.get('/user-settings/account', requireAuth, (c) =>
  c.json({ name: null, phone: null, email: 'synthetic@fixture.test' }),
);
app.route('/user-settings', userSettingsRoutes);
app.get('/health', (c) => c.json({ ok: true }));
app.get('*', requireAuth, (c) =>
  c.json({ tasks: [], repositories: [], providers: [], state: 'normal' }),
);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 46101 });
installTerminalWebSocket(server as unknown as Server);
installIdeWebSocket(server as unknown as Server);
async function stop() {
  server.close();
  await closeRedis();
  await db.$client.end({ timeout: 5 });
  process.exit(0);
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());

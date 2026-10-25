/** Isolated browser fixture: real auth routes, signing, middleware and Postgres rotation.
 * Synthetic secrets and authenticated sidebar fixtures keep this independent of provider APIs. */
import { serve } from '@hono/node-server';
import jwt from 'jsonwebtoken';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
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
const web = 'http://127.0.0.1:46100';
const app = new Hono<AppEnv>().onError(errorHandler);
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
app.delete('/__fixture/session/:id', async (c) => {
  await db.delete(schema.users).where(eq(schema.users.id, c.req.param('id')));
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
async function stop() {
  server.close();
  await closeRedis();
  await db.$client.end({ timeout: 5 });
  process.exit(0);
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());

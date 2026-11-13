import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ db: undefined as unknown, warn: vi.fn() }));
vi.mock('@haive/shared', async (original) => {
  const actual = await original<typeof import('@haive/shared')>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      warn: h.warn,
      child: () => ({ warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
  };
});
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: vi.fn() }) }));
vi.mock('../src/lib/auth-throttle.js', () => ({
  reserveAuthAttempt: async () => ({ refund: async () => undefined }),
  AuthThrottleError: class extends Error {},
}));
vi.mock('../src/middleware/auth.js', () => {
  const auth = async (c: { set: (k: string, v: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-000000000001');
    c.set('userRole', 'admin');
    await next();
  };
  return {
    requireAuth: auth,
    requireAuthAllowingPasswordChange: auth,
    requireAdmin: async (_c: unknown, next: () => unknown) => next(),
  };
});
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  computeEmailBlindIndex,
  configService,
  encrypt,
  encryptEmail,
  secretsService,
} from '@haive/shared';
import { hashPassword } from '../src/auth/password.js';
import { adminRoutes } from '../src/routes/admin.js';
import { authRoutes } from '../src/routes/auth.js';
import { userSettingsRoutes } from '../src/routes/user-settings.js';
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const key = '11'.repeat(32);
const oldKey = '22'.repeat(32);
const id = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const app = new Hono<AppEnv>();
app.route('/admin', adminRoutes);
app.route('/auth', authRoutes);
app.route('/user-settings', userSettingsRoutes);
app.route('/admin/maintenance', maintenanceRoutes);
app.onError(errorHandler);
let fake: ReturnType<typeof createFakeDb>;
// The shared fake deliberately has no joins. Supply joined read results at that seam;
// the real handlers still perform the decryption and response shaping.
function joinedReads(results: unknown[][]) {
  const select = () => {
    const rows = results.shift() ?? [];
    const query = {
      leftJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      offset: () => query,
      from: () => query,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return query;
  };
  h.db = { ...fake.db, select, selectDistinct: select };
}
beforeEach(() => {
  h.warn.mockClear();
  vi.spyOn(configService, 'getEncryptionKey').mockResolvedValue(key);
  vi.spyOn(configService, 'getFresh').mockResolvedValue('maintenance');
  vi.spyOn(secretsService, 'getEmailBlindIndexPepper').mockResolvedValue('pepper');
  vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('test-jwt-secret');
  fake = createFakeDb({
    users: schema.users,
    auditEvents: schema.auditEvents,
    refreshTokens: schema.refreshTokens,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    cliProviders: schema.cliProviders,
    cliInvocations: schema.cliInvocations,
  });
  h.db = fake.db;
  fake.insert(schema.users, {
    id,
    name: 'Admin',
    emailEncrypted: encryptEmail('old@example.com', oldKey),
    phoneEncrypted: encrypt('+33123456789', oldKey),
    emailBlindIndex: 'old-index',
    passwordHash: 'old-hash',
    role: 'admin',
    status: 'active',
    tokenVersion: 0,
    mustChangePassword: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

it('admin users returns an unreadable email without failing the list', async () => {
  const res = await app.request('/admin/users');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ users: [{ id, email: null, emailReadable: false }] });
  expect(h.warn).toHaveBeenCalledWith({ userId: id }, expect.any(String));
  expect(JSON.stringify(h.warn.mock.calls)).not.toContain(
    fake.rows(schema.users)[0]!.emailEncrypted,
  );
});
it('audit distinguishes an unreadable actor from a missing actor', async () => {
  joinedReads([
    [
      {
        id: taskId,
        actorUserId: id,
        actorEmailEncrypted: fake.rows(schema.users)[0]!.emailEncrypted,
        action: 'user.update',
        targetType: 'user',
        createdAt: new Date(),
      },
    ],
    [{ count: 1 }],
    [],
    [],
  ]);
  const res = await app.request('/admin/audit');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    events: [{ actorEmail: null, actorEmailReadable: false }],
  });
  expect(h.warn).toHaveBeenCalledWith({ userId: id }, expect.any(String));
});
it('auth me returns an unreadable email', async () => {
  const res = await app.request('/auth/me');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ user: { email: null, emailReadable: false } });
});
it('login returns a session even when a matching user has unreadable fields', async () => {
  fake.patch(schema.users, id, {
    emailBlindIndex: computeEmailBlindIndex('admin@example.com', 'pepper'),
    passwordHash: await hashPassword('temporary-password'),
  });
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'temporary-password' }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ user: { email: null, emailReadable: false } });
  expect(res.headers.get('set-cookie')).toContain('haive_access=');
});
it('account returns nulls and flags for an unreadable email and phone', async () => {
  const res = await app.request('/user-settings/account');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    email: null,
    emailReadable: false,
    phone: null,
    phoneReadable: false,
  });
});
it('a recovered email can sign in while its old phone remains unreadable', async () => {
  fake.patch(schema.users, id, {
    emailEncrypted: encryptEmail('admin@example.com', key),
    emailBlindIndex: computeEmailBlindIndex('admin@example.com', 'pepper'),
    passwordHash: await hashPassword('temporary-password'),
    mustChangePassword: true,
    tokenVersion: 1,
  });
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'temporary-password' }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    user: { email: 'admin@example.com', emailReadable: true },
  });
});
it('maintenance returns unreadable owners for tasks, parked tasks and background jobs', async () => {
  const owner = {
    ownerId: id,
    ownerEmailEncrypted: fake.rows(schema.users)[0]!.emailEncrypted,
    ownerName: 'Admin',
  };
  const task = {
    id: taskId,
    title: 'Task',
    status: 'running',
    pausedAt: null,
    updatedAt: new Date(),
    ...owner,
  };
  joinedReads([
    [task],
    [],
    [{ ...task, id: '00000000-0000-4000-8000-000000000003', status: 'waiting_user' }],
    [{ id: taskId, name: 'Repo', status: 'cloning', updatedAt: new Date(), ...owner }],
    [],
    [],
    [],
  ]);
  const res = await app.request('/admin/maintenance/blocking');
  expect(res.status).toBe(200);
  const data = (await res.json()) as { tasks: unknown[]; parked: unknown[]; jobs: unknown[] };
  expect(h.warn).toHaveBeenCalledWith({ userId: id }, expect.any(String));
  for (const group of [data.tasks, data.parked, data.jobs]) {
    expect(group).not.toHaveLength(0);
    expect(group[0]).toMatchObject({ ownerEmail: null, ownerEmailReadable: false });
  }
});

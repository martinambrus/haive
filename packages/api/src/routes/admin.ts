import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Hono } from 'hono';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, decryptEmail, logger } from '@haive/shared';
import { getDb } from '../db.js';
import { hashPassword } from '../auth/password.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

const log = logger.child({ module: 'admin' });

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', requireAuth);
adminRoutes.use('*', requireAdmin);

const userActionSchema = z.object({
  action: z.enum(['deactivate', 'activate', 'reset_password', 'set_role']),
  role: z.enum(['admin', 'user']).optional(),
});

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';

export function generateTemporaryPassword(length = 24): string {
  if (length < 12) {
    throw new Error('temporary password length must be >= 12');
  }
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[i] ?? 0;
    const idx = byte % PASSWORD_ALPHABET.length;
    out += PASSWORD_ALPHABET[idx];
  }
  return out;
}

adminRoutes.get('/users', async (c) => {
  const db = getDb();
  const fieldKey = await configService.getEncryptionKey();
  const rows = await db
    .select({
      id: schema.users.id,
      emailEncrypted: schema.users.emailEncrypted,
      role: schema.users.role,
      status: schema.users.status,
      tokenVersion: schema.users.tokenVersion,
      createdAt: schema.users.createdAt,
      updatedAt: schema.users.updatedAt,
    })
    .from(schema.users)
    .orderBy(desc(schema.users.createdAt));

  const users = rows.map((row) => ({
    id: row.id,
    email: decryptEmail(row.emailEncrypted, fieldKey),
    role: row.role,
    status: row.status,
    tokenVersion: row.tokenVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));

  return c.json({ users });
});

adminRoutes.post('/users/:id/action', async (c) => {
  const targetUserId = c.req.param('id');
  const callerUserId = c.get('userId');
  const body = userActionSchema.parse(await c.req.json());
  const db = getDb();

  const target = await db.query.users.findFirst({
    where: eq(schema.users.id, targetUserId),
    columns: {
      id: true,
      role: true,
      status: true,
      tokenVersion: true,
    },
  });
  if (!target) throw new HttpError(404, 'User not found');

  const now = new Date();

  if (body.action === 'deactivate') {
    if (target.id === callerUserId) {
      throw new HttpError(400, 'Cannot deactivate the calling admin');
    }
    await db
      .update(schema.users)
      .set({
        status: 'deactivated',
        tokenVersion: target.tokenVersion + 1,
        updatedAt: now,
      })
      .where(eq(schema.users.id, targetUserId));
    log.info({ targetUserId, callerUserId }, 'user deactivated');
    return c.json({ ok: true, action: 'deactivate' });
  }

  if (body.action === 'activate') {
    await db
      .update(schema.users)
      .set({ status: 'active', updatedAt: now })
      .where(eq(schema.users.id, targetUserId));
    log.info({ targetUserId, callerUserId }, 'user activated');
    return c.json({ ok: true, action: 'activate' });
  }

  if (body.action === 'reset_password') {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    await db
      .update(schema.users)
      .set({
        passwordHash,
        tokenVersion: target.tokenVersion + 1,
        updatedAt: now,
      })
      .where(eq(schema.users.id, targetUserId));
    log.info({ targetUserId, callerUserId }, 'user password reset');
    return c.json({ ok: true, action: 'reset_password', temporaryPassword });
  }

  if (body.action === 'set_role') {
    if (!body.role) throw new HttpError(400, 'role required for set_role');
    if (target.id === callerUserId && body.role !== 'admin') {
      throw new HttpError(400, 'Cannot demote the calling admin');
    }
    await db
      .update(schema.users)
      .set({ role: body.role, updatedAt: now })
      .where(eq(schema.users.id, targetUserId));
    log.info({ targetUserId, callerUserId, role: body.role }, 'user role changed');
    return c.json({ ok: true, action: 'set_role', role: body.role });
  }

  throw new HttpError(400, 'Unknown admin action');
});

adminRoutes.get('/health', async (c) => {
  const db = getDb();
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [userCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where status = 'active')::int`,
      deactivated: sql<number>`count(*) filter (where status = 'deactivated')::int`,
      admins: sql<number>`count(*) filter (where role = 'admin')::int`,
    })
    .from(schema.users);

  const taskRows = await db
    .select({
      status: schema.tasks.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.tasks)
    .groupBy(schema.tasks.status);

  const containerRows = await db
    .select({
      status: schema.containers.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.containers)
    .groupBy(schema.containers.status);

  const recentErrors = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.status, 'failed'), gte(schema.tasks.updatedAt, twentyFourHoursAgo)))
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(25);

  return c.json({
    users: userCounts ?? { total: 0, active: 0, deactivated: 0, admins: 0 },
    tasks: Object.fromEntries(taskRows.map((r) => [r.status, r.count])),
    containers: Object.fromEntries(containerRows.map((r) => [r.status, r.count])),
    recentFailures: recentErrors.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      updatedAt: r.updatedAt.toISOString(),
    })),
    timestamp: now.toISOString(),
  });
});

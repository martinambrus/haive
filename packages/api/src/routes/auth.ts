import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { count, eq, and, isNull, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  loginRequestSchema,
  registerRequestSchema,
  computeEmailBlindIndex,
  encryptEmail,
  decryptEmail,
  CONFIG_KEYS,
  configService,
  logger,
  parseRegistrationMode,
  secretsService,
} from '@haive/shared';
import { getDb } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashRefreshToken,
} from '../auth/jwt.js';
import { setAuthCookies, clearAuthCookies, getRefreshCookie } from '../auth/cookies.js';
import { checkInvite, hashInviteToken } from '../lib/invites.js';
import { decideRegistration } from '../lib/registration.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

const log = logger.child({ module: 'auth' });

export const authRoutes = new Hono<AppEnv>();

/** Set on an install that wants the first registration gated. Read once: it is process config, and
 *  a value that changed under a running api would make the gate non-deterministic. */
const setupToken = (process.env.SETUP_TOKEN ?? '').trim();

/** Compare two secrets without leaking their contents through timing.
 *
 *  Both sides are hashed first so the comparison is over fixed-width buffers — `timingSafeEqual`
 *  THROWS on a length mismatch, and branching on length beforehand would leak the token's length. */
function timingSafeEqualString(a: string, b: string | undefined): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256')
    .update(b ?? '')
    .digest();
  return timingSafeEqual(ha, hb);
}

async function issueTokens(
  userId: string,
  role: 'admin' | 'user',
  tokenVersion: number,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const accessToken = await signAccessToken({ sub: userId, role, tv: tokenVersion });
  const { token: refreshToken, expiresAt } = await signRefreshToken(userId, tokenVersion);
  return { accessToken, refreshToken, expiresAt };
}

authRoutes.post('/register', async (c) => {
  const body = registerRequestSchema.parse(await c.req.json());
  const db = getDb();
  const fieldKey = await configService.getEncryptionKey();
  const pepper = await secretsService.getEmailBlindIndexPepper();
  const blindIndex = computeEmailBlindIndex(body.email, pepper);

  const passwordHash = await hashPassword(body.password);
  const emailEncrypted = encryptEmail(body.email, fieldKey);
  // Read before the transaction, like the hashing above: it is a cached Redis read, and doing it
  // under the bootstrap lock would serialise every registration behind a network round trip.
  const mode = parseRegistrationMode(await configService.get(CONFIG_KEYS.REGISTRATION_MODE));

  // Hashing is deliberately outside the transaction below: bcrypt takes ~100ms and the transaction
  // holds a lock every other registration queues behind.
  const user = await db.transaction(async (tx) => {
    // Serialise the count-then-insert. Without it two simultaneous first-registrations both read
    // zero users and BOTH become admin — the one race this feature has, and it is invisible in
    // testing because it needs concurrency to appear.
    //
    // Transaction-scoped, matching plan/mirror.ts and _global-kb-promote.ts; it releases when this
    // transaction ends. NOT the session-scoped form the migration runner uses — see
    // packages/database/src/migrate/lock.ts, which explains why that one is different.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('haive_bootstrap'), hashtext('first_admin'))`,
    );

    const existing = await tx.query.users.findFirst({
      where: eq(schema.users.emailBlindIndex, blindIndex),
      columns: { id: true },
    });
    if (existing) throw new HttpError(409, 'Email already registered');

    const counted = await tx.select({ n: count() }).from(schema.users);
    const userCount = Number(counted[0]?.n ?? 0);

    // Looked up INSIDE the transaction, and consumed there too: that is what makes an invite
    // single-use. Two people redeeming the same link at once both pass `checkInvite`, but only one
    // UPDATE can match `consumed_at IS NULL`, and the loser's whole registration rolls back.
    let invite: { id: string; role: 'admin' | 'user' } | null = null;
    if (body.inviteToken) {
      const row = await tx.query.userInvites.findFirst({
        where: eq(schema.userInvites.tokenHash, hashInviteToken(body.inviteToken)),
        columns: {
          id: true,
          role: true,
          emailBlindIndex: true,
          expiresAt: true,
          revokedAt: true,
          consumedAt: true,
        },
      });
      const verdict = checkInvite(row ?? null, blindIndex);
      if (!verdict.valid) {
        log.warn({ refusal: verdict.refusal }, 'invite rejected');
        throw new HttpError(403, verdict.message);
      }
      invite = { id: row!.id, role: verdict.role };
    }

    const decision = decideRegistration({
      userCount,
      mode,
      hasValidInvite: invite !== null,
      setupTokenConfigured: setupToken.length > 0,
      setupTokenMatches:
        setupToken.length > 0 && timingSafeEqualString(setupToken, body.setupToken),
    });
    if (!decision.allow) throw new HttpError(403, decision.message);

    // An invite's role wins over the mode's default: that is the whole point of inviting someone
    // as an administrator. The first-run branch still outranks both — it is already `admin`.
    const role = decision.firstRun ? decision.role : (invite?.role ?? decision.role);

    const inserted = await tx
      .insert(schema.users)
      .values({
        emailEncrypted,
        emailBlindIndex: blindIndex,
        passwordHash,
        role,
      })
      .returning({
        id: schema.users.id,
        role: schema.users.role,
        status: schema.users.status,
        tokenVersion: schema.users.tokenVersion,
        createdAt: schema.users.createdAt,
      });

    if (invite) {
      // Guarded on `consumed_at IS NULL` rather than trusting the read above: between that read
      // and this write another transaction could have consumed it. Zero rows means it lost the
      // race, and throwing rolls this whole registration back.
      const consumed = await tx
        .update(schema.userInvites)
        .set({ consumedAt: new Date(), consumedByUserId: inserted[0]!.id })
        .where(and(eq(schema.userInvites.id, invite.id), isNull(schema.userInvites.consumedAt)))
        .returning({ id: schema.userInvites.id });
      if (consumed.length === 0) {
        throw new HttpError(
          409,
          'That invitation was just used. Ask an administrator for a new one.',
        );
      }
    }

    if (decision.firstRun) {
      log.info({ userId: inserted[0]!.id }, 'first account created — anointed as administrator');
    }
    return inserted[0]!;
  });
  const { accessToken, refreshToken, expiresAt } = await issueTokens(
    user.id,
    user.role,
    user.tokenVersion,
  );
  await db.insert(schema.refreshTokens).values({
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt,
  });
  setAuthCookies(c, accessToken, refreshToken);

  return c.json(
    {
      user: {
        id: user.id,
        email: body.email,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt.toISOString(),
      },
    },
    201,
  );
});

/**
 * Does this install still need its first account?
 *
 * UNAUTHENTICATED, and it has to be: an install with zero users has nobody who could authenticate,
 * which is the entire condition being reported. It discloses only what any visitor learns by
 * POSTing to `/register` and reading the response, and `maintenanceGate` already lets `/auth/*`
 * through so a stack mid-upgrade can still answer it.
 *
 * `setupTokenRequired` is reported so the setup page can ask for the token instead of letting the
 * operator discover the requirement through a 403.
 */
authRoutes.get('/registration-status', async (c) => {
  const counted = await getDb().select({ n: count() }).from(schema.users);
  const userCount = Number(counted[0]?.n ?? 0);
  return c.json({
    setupNeeded: userCount === 0,
    setupTokenRequired: userCount === 0 && setupToken.length > 0,
    // So the register page can decline to offer a form that cannot succeed.
    mode: parseRegistrationMode(await configService.get(CONFIG_KEYS.REGISTRATION_MODE)),
  });
});

authRoutes.post('/login', async (c) => {
  const body = loginRequestSchema.parse(await c.req.json());
  const db = getDb();
  const fieldKey = await configService.getEncryptionKey();
  const pepper = await secretsService.getEmailBlindIndexPepper();
  const blindIndex = computeEmailBlindIndex(body.email, pepper);

  const user = await db.query.users.findFirst({
    where: eq(schema.users.emailBlindIndex, blindIndex),
  });
  if (!user || user.status !== 'active') {
    throw new HttpError(401, 'Invalid credentials');
  }

  const ok = await verifyPassword(body.password, user.passwordHash);
  if (!ok) throw new HttpError(401, 'Invalid credentials');

  const { accessToken, refreshToken, expiresAt } = await issueTokens(
    user.id,
    user.role,
    user.tokenVersion,
  );
  await db.insert(schema.refreshTokens).values({
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt,
  });
  setAuthCookies(c, accessToken, refreshToken);

  return c.json({
    user: {
      id: user.id,
      email: decryptEmail(user.emailEncrypted, fieldKey),
      role: user.role,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
    },
  });
});

authRoutes.post('/refresh', async (c) => {
  const token = getRefreshCookie(c);
  if (!token) throw new HttpError(401, 'No refresh token');

  let payload;
  try {
    payload = await verifyRefreshToken(token);
  } catch {
    throw new HttpError(401, 'Invalid refresh token');
  }

  const db = getDb();
  const tokenHash = hashRefreshToken(token);
  const row = await db.query.refreshTokens.findFirst({
    where: and(
      eq(schema.refreshTokens.tokenHash, tokenHash),
      eq(schema.refreshTokens.userId, payload.sub),
    ),
  });
  if (!row || row.revokedAt || row.expiresAt < new Date()) {
    throw new HttpError(401, 'Refresh token invalid or expired');
  }

  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, payload.sub),
    columns: { id: true, role: true, status: true, tokenVersion: true },
  });
  if (!user || user.status !== 'active' || user.tokenVersion !== payload.tv) {
    throw new HttpError(401, 'User not found or token revoked');
  }

  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.refreshTokens.id, row.id));

  const {
    accessToken,
    refreshToken: newRefresh,
    expiresAt,
  } = await issueTokens(user.id, user.role, user.tokenVersion);
  await db.insert(schema.refreshTokens).values({
    userId: user.id,
    tokenHash: hashRefreshToken(newRefresh),
    expiresAt,
  });
  setAuthCookies(c, accessToken, newRefresh);

  return c.json({ ok: true });
});

/**
 * Log out. Deliberately NOT behind `requireAuth`.
 *
 * The handler never reads the authenticated user — it revokes whatever refresh token the caller
 * presents and clears their cookies — so the guard bought nothing and cost the one case that
 * matters: a user whose token has just been invalidated (a `reset_password` bumps `tokenVersion`)
 * got a 401 from the one endpoint that would have cleaned up their browser.
 *
 * No new exposure. Revoking needs the token itself, which anyone holding it could already use, and
 * the cookies are `SameSite=Lax`, so a cross-site POST carries none of them.
 */
authRoutes.post('/logout', async (c) => {
  const token = getRefreshCookie(c);
  const db = getDb();
  if (token) {
    const tokenHash = hashRefreshToken(token);
    await db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(schema.refreshTokens.tokenHash, tokenHash));
  }
  clearAuthCookies(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const fieldKey = await configService.getEncryptionKey();
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
  });
  if (!user) throw new HttpError(404, 'User not found');
  return c.json({
    user: {
      id: user.id,
      email: decryptEmail(user.emailEncrypted, fieldKey),
      role: user.role,
      status: user.status,
      // The app layout already makes this call, so forcing a password change costs no extra
      // request. Reported here and not on /login or /register: on those two the holder has just
      // CHOSEN the password, so the answer is always false.
      mustChangePassword: user.mustChangePassword,
      createdAt: user.createdAt.toISOString(),
    },
  });
});

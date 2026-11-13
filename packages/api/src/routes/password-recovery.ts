import { Hono } from 'hono';
import { safeErrorDetails } from '@haive/shared/logger';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { z } from 'zod';
import {
  CONFIG_KEYS,
  configService,
  secretsService,
  computeEmailBlindIndex,
  emailSchema,
  passwordSchema,
  logger,
} from '@haive/shared';
import { getDb } from '../db.js';
import { clearAuthCookies } from '../auth/cookies.js';
import { AuthThrottleError, reserveAuthAttempt } from '../lib/auth-throttle.js';
import { ANONYMOUS_AUDIT_ACTOR, recordAuditEvent } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import {
  assertPasswordResetLive,
  consumePasswordReset,
  findPasswordResetRecipient,
  issuePasswordReset,
} from '../lib/password-resets.js';
import { webOrigin } from '../lib/request-origin.js';
import { closeUserSockets } from '../lib/user-sockets.js';
import { hashInviteToken } from '../lib/invites.js';
import type { AppEnv } from '../context.js';

const log = logger.child({ module: 'password-recovery' });
const forgotSchema = z.object({ email: z.string().trim().toLowerCase().pipe(emailSchema) });
const resetSchema = z.object({
  // Malformed credentials reach the same generic refusal as an unknown or expired token.
  token: z.string().min(1).max(255).catch(''),
  newPassword: passwordSchema,
});
export const passwordRecoveryRoutes = new Hono<AppEnv>();

async function available(): Promise<boolean> {
  const enabled = await configService.getFresh(CONFIG_KEYS.MAIL_ENABLED);
  return enabled === 'true' || enabled === '1';
}

passwordRecoveryRoutes.get('/forgot-password/available', async (c) => {
  try {
    return c.json({ available: await available() });
  } catch {
    // Public availability fails closed during a config outage, without exposing its diagnosis.
    log.warn({ code: 'password_recovery_unavailable' }, 'Password recovery availability failed');
    return c.json({ available: false });
  }
});

passwordRecoveryRoutes.post('/forgot-password', async (c) => {
  const { email } = forgotSchema.parse(await c.req.json());
  const response = c.json(
    { message: 'If an account can be recovered, a reset link will be emailed.' },
    202,
  );
  try {
    const pepper = await secretsService.getEmailBlindIndexPepper();
    const blindIndex = computeEmailBlindIndex(email, pepper);
    await reserveAuthAttempt(c, 'recover', blindIndex);
    setImmediate(() => {
      void (async () => {
        if (!(await available())) return;
        const fieldKey = await configService.getEncryptionKey();
        const db = getDb();
        const recipient = await findPasswordResetRecipient(db, email, blindIndex, fieldKey);
        if (!recipient) return;
        const token = await issuePasswordReset(db, recipient.userId, recipient.claimEmailEncrypted);
        if (token === null) return;
        // Invites use window.location.origin. The server counterpart is the configured WEB_ORIGIN,
        // never an untrusted Host/Origin header. The raw link stays only in this process and SMTP.
        const link = new URL('/reset-password', webOrigin());
        link.searchParams.set('token', token);
        const result = await sendMail({
          to: recipient.to,
          subject: 'Reset your Haive password',
          text: `Open this link to choose a new password:\n\n${link.href}\n\nThis link expires in 30 minutes. A new request made more than two minutes later replaces it. If you did not request it, ignore this email.`,
        });
        if (!result.ok) log.warn({ code: result.code }, 'Password recovery mail was not delivered');
      })().catch((error: unknown) => {
        // Keep only the class and a short error code (SQLSTATE or errno), never messages, query values or SMTP text.
        const { name, code } = safeErrorDetails(error);
        log.warn(
          {
            code: 'password_recovery_failed',
            errorName: name,
            ...(typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? { errorCode: code } : {}),
          },
          'Password recovery could not be completed',
        );
      });
    });
  } catch (error) {
    if (error instanceof AuthThrottleError && error.auditAllowed) {
      setImmediate(() => {
        void (async () => {
          const db = getDb();
          const pepper = await secretsService.getEmailBlindIndexPepper();
          const existing =
            error.limiter === 'account'
              ? await db.query.users.findFirst({
                  where: eq(schema.users.emailBlindIndex, computeEmailBlindIndex(email, pepper)),
                  columns: { id: true },
                })
              : undefined;
          await recordAuditEvent(db, {
            actorUserId: ANONYMOUS_AUDIT_ACTOR,
            action: 'auth.password_reset.throttled',
            targetType: 'user',
            targetId: existing?.id ?? null,
            metadata: { reason: 'throttled', limiter: error.limiter },
          });
        })().catch(() => {
          log.warn({ code: 'password_recovery_audit_failed' }, 'Password recovery audit failed');
        });
      });
    }
    // Throttling and configuration failures preserve the same non-enumerating response.
    log.warn({ code: 'password_recovery_refused' }, 'Password recovery request was not admitted');
  }
  return response;
});

passwordRecoveryRoutes.post('/reset-password', async (c) => {
  const body = resetSchema.parse(await c.req.json());
  const tokenHash = hashInviteToken(body.token);
  // A private bridge peer has no address bucket; each token still has its own budget.
  await reserveAuthAttempt(c, 'reset', tokenHash);
  const db = getDb();
  await assertPasswordResetLive(db, tokenHash);
  const fieldKey = await configService.getEncryptionKey();
  const pepper = await secretsService.getEmailBlindIndexPepper();
  const userId = await consumePasswordReset(db, body.token, body.newPassword, fieldKey, pepper);
  closeUserSockets(userId);
  clearAuthCookies(c);
  return c.json({ ok: true });
});

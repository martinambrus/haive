import { randomBytes } from 'node:crypto';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { isUniqueViolationOf, schema, type Database } from '@haive/database';
import { computeEmailBlindIndex, encryptEmail, tryDecryptEmail } from '@haive/shared';
import { HttpError } from '../context.js';
import { hashPassword } from '../auth/password.js';
import { insertAuditEvent, logAuditEvent, type AuditEvent } from './audit.js';
import { issuePasswordResetInTransaction } from './password-resets.js';

const taken = () =>
  new HttpError(409, 'That email is already linked to another account.', 'relink_email_taken');

/** Caller supplies a normalized address. No network I/O or configuration reads under user locks. */
export async function relinkUser(
  db: Database,
  userId: string,
  actorUserId: string,
  email: string,
  fieldKey: string,
  pepper: string,
  now = new Date(),
): Promise<{ userId: string; token: string }> {
  // Spend bcrypt time before holding the user lock. Nobody receives or knows this password.
  const passwordHash = await hashPassword(randomBytes(32).toString('hex'));
  const emailEncrypted = encryptEmail(email, fieldKey);
  const emailBlindIndex = computeEmailBlindIndex(email, pepper);
  try {
    const result = await db.transaction(async (tx) => {
      const [user] = await tx
        .select({
          id: schema.users.id,
          status: schema.users.status,
          emailEncrypted: schema.users.emailEncrypted,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for('no key update');
      if (!user) throw new HttpError(404, 'User not found');
      // Compare the stored id: Postgres accepts other spellings of the same uuid in the URL.
      if (user.id === actorUserId) throw new HttpError(400, 'Cannot relink the calling admin');
      if (user.status !== 'active')
        throw new HttpError(
          409,
          'Reactivate this account before relinking it.',
          'relink_deactivated',
        );
      if (tryDecryptEmail(user.emailEncrypted, fieldKey) !== null)
        throw new HttpError(
          409,
          'This account already has a readable email.',
          'relink_not_orphaned',
        );
      const holder = await tx.query.users.findFirst({
        where: and(eq(schema.users.emailBlindIndex, emailBlindIndex), ne(schema.users.id, user.id)),
        columns: { id: true },
      });
      if (holder) throw taken();
      // Refresh revokes its row before inserting a successor (FK key-share on users).
      // Revoke refresh rows before changing the unique email index can upgrade our user lock.
      await tx
        .update(schema.refreshTokens)
        .set({ revokedAt: now })
        .where(
          and(eq(schema.refreshTokens.userId, user.id), isNull(schema.refreshTokens.revokedAt)),
        );
      await tx
        .update(schema.users)
        .set({
          emailEncrypted,
          emailBlindIndex,
          passwordHash,
          mustChangePassword: true,
          tokenVersion: sql`${schema.users.tokenVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(schema.users.id, user.id));
      const audit: AuditEvent = {
        actorUserId,
        action: 'user.relink',
        targetType: 'user',
        targetId: user.id,
      };
      await insertAuditEvent(tx, audit);
      // Plain reset: the email has already been set. Atomic issuance lets a database/audit
      // failure leave the account orphaned and retryable, with all its original state.
      const issued = await issuePasswordResetInTransaction(tx, user.id, null, {
        now,
        bypassCooldown: true,
      });
      if (!issued) throw new Error('Relink reset issuance was refused');
      return { userId: user.id, issued, audit };
    });
    logAuditEvent(result.audit);
    logAuditEvent(result.issued.event);
    return { userId: result.userId, token: result.issued.token };
  } catch (error) {
    if (isUniqueViolationOf(error, 'users_email_blind_index_idx')) throw taken();
    throw error;
  }
}

import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { isUniqueViolationOf, schema, type Database } from '@haive/database';
import { computeEmailBlindIndex, encryptEmail, tryDecryptEmail } from '@haive/shared';
import { HttpError } from '../context.js';
import {
  ANONYMOUS_AUDIT_ACTOR,
  insertAuditEvent,
  logAuditEvent,
  type AuditEvent,
} from './audit.js';
import { generateInviteToken, hashInviteToken } from './invites.js';

export const PASSWORD_RESET_TTL_MS = 30 * 60_000;
const invalid = () =>
  new HttpError(400, 'That reset link is invalid or expired. Request a new one.');

/** Shared issuance seam: a later administrator relink can choose the user explicitly. Lock the
 * user before touching resets so simultaneous issuance/redemption always uses the same lock order. */
export async function issuePasswordReset(
  db: Database,
  userId: string,
  claimEmailEncrypted: string | null = null,
  { now = new Date(), ttlMs = PASSWORD_RESET_TTL_MS }: { now?: Date; ttlMs?: number } = {},
): Promise<string> {
  const token = generateInviteToken();
  const event: AuditEvent = {
    actorUserId: ANONYMOUS_AUDIT_ACTOR,
    action: 'auth.password_reset.request',
    targetType: 'user',
    targetId: userId,
    metadata: { claim: claimEmailEncrypted !== null },
  };
  await db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for('update');
    if (!locked.length) throw invalid();
    await tx
      .update(schema.passwordResets)
      .set({ consumedAt: now })
      .where(
        and(eq(schema.passwordResets.userId, userId), isNull(schema.passwordResets.consumedAt)),
      );
    await tx.insert(schema.passwordResets).values({
      userId,
      claimEmailEncrypted,
      tokenHash: hashInviteToken(token),
      expiresAt: new Date(now.getTime() + ttlMs),
    });
    await insertAuditEvent(tx, event);
  });
  logAuditEvent(event);
  return token;
}

/** Lookup and decrypt happen after the HTTP answer, including writes on the successful path. */
export async function findPasswordResetRecipient(
  db: Database,
  email: string,
  blindIndex: string,
  fieldKey: string,
): Promise<{ userId: string; to: string; claimEmailEncrypted: string | null } | null> {
  const matched = await db.query.users.findFirst({
    where: eq(schema.users.emailBlindIndex, blindIndex),
  });
  if (matched) {
    const to = tryDecryptEmail(matched.emailEncrypted, fieldKey);
    if (to !== null) return { userId: matched.id, to, claimEmailEncrypted: null };
  }
  const discard = await db.query.auditEvents.findFirst({
    where: eq(schema.auditEvents.action, 'config.discard_unreadable_secrets'),
    columns: { id: true },
  });
  if (!discard) return null;
  const candidates = await db.query.users.findMany({
    where: sql`lower(trim(${schema.users.gitEmail})) = ${email.trim().toLowerCase()}`,
  });
  const orphans = candidates.filter(
    (u) =>
      u.gitEmail?.trim().toLowerCase() === email.trim().toLowerCase() &&
      tryDecryptEmail(u.emailEncrypted, fieldKey) === null,
  );
  if (orphans.length !== 1) return null;
  return { userId: orphans[0]!.id, to: email, claimEmailEncrypted: encryptEmail(email, fieldKey) };
}

/** Admission hint only: the guarded consume in the transaction remains authoritative. */
export async function assertPasswordResetLive(db: Database, token: string): Promise<void> {
  const candidate = await db.query.passwordResets.findFirst({
    where: and(
      eq(schema.passwordResets.tokenHash, hashInviteToken(token)),
      isNull(schema.passwordResets.consumedAt),
      gt(schema.passwordResets.expiresAt, sql`now()`),
    ),
    columns: { id: true },
  });
  if (!candidate) throw invalid();
}

export async function consumePasswordReset(
  db: Database,
  token: string,
  passwordHash: string,
  fieldKey: string,
  pepper: string,
  now?: Date,
): Promise<string> {
  const tokenHash = hashInviteToken(token);
  const changedAt = now ?? sql`now()`;
  let event: AuditEvent | undefined;
  try {
    const userId = await db.transaction(async (tx) => {
      const candidate = await tx.query.passwordResets.findFirst({
        where: eq(schema.passwordResets.tokenHash, tokenHash),
      });
      if (!candidate) throw invalid();
      await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, candidate.userId))
        .for('update');
      const [claimed] = await tx
        .update(schema.passwordResets)
        .set({ consumedAt: changedAt })
        .where(
          and(
            eq(schema.passwordResets.tokenHash, tokenHash),
            isNull(schema.passwordResets.consumedAt),
            gt(schema.passwordResets.expiresAt, changedAt),
          ),
        )
        .returning();
      if (!claimed) throw invalid();
      let emailUpdate = {};
      if (claimed.claimEmailEncrypted !== null) {
        const email = tryDecryptEmail(claimed.claimEmailEncrypted, fieldKey);
        if (email === null) throw invalid();
        const emailBlindIndex = computeEmailBlindIndex(email, pepper);
        const holder = await tx.query.users.findFirst({
          where: and(
            eq(schema.users.emailBlindIndex, emailBlindIndex),
            ne(schema.users.id, claimed.userId),
          ),
          columns: { id: true },
        });
        if (holder) throw new HttpError(409, 'That email is already linked to another account.');
        emailUpdate = { emailEncrypted: encryptEmail(email, fieldKey), emailBlindIndex };
      }
      await tx
        .update(schema.users)
        .set({
          ...emailUpdate,
          passwordHash,
          mustChangePassword: false,
          tokenVersion: sql`${schema.users.tokenVersion} + 1`,
          updatedAt: changedAt,
        })
        .where(eq(schema.users.id, claimed.userId));
      await tx
        .update(schema.refreshTokens)
        .set({ revokedAt: changedAt })
        .where(
          and(
            eq(schema.refreshTokens.userId, claimed.userId),
            isNull(schema.refreshTokens.revokedAt),
          ),
        );
      event = {
        actorUserId: claimed.userId,
        action: 'auth.password_reset.complete',
        targetType: 'user',
        targetId: claimed.userId,
        metadata: { claim: claimed.claimEmailEncrypted !== null },
      };
      await insertAuditEvent(tx, event);
      return claimed.userId;
    });
    logAuditEvent(event!);
    return userId;
  } catch (error) {
    // The unique constraint also fences an email acquired concurrently after our pre-check.
    if (isUniqueViolationOf(error, 'users_email_blind_index_idx'))
      throw new HttpError(409, 'That email is already linked to another account.');
    throw error;
  }
}

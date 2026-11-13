import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  computeEmailBlindIndex,
  encryptEmail,
  registerRequestSchema,
  tryDecryptEmail,
} from '@haive/shared';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
const CLEAR_ACTION = 'user.recovery.clear_password';
export const RECOVERY_PASSWORD_ROUNDS = 12;

export interface RecoveryOptions {
  email: string;
  userId?: string;
  key: string;
  pepper: string;
}

/** Host-authorized recovery. All user writes and their audit evidence commit together.
 * The injected hash function lets unit controls use a small bcrypt cost. */
export async function recoverAdmin(
  db: Database,
  options: RecoveryOptions,
  hashPassword: (value: string) => Promise<string> = (value) =>
    bcrypt.hash(value, RECOVERY_PASSWORD_ROUNDS),
): Promise<{ userId: string; temporaryPassword: string }> {
  const email = options.email.trim().toLowerCase();
  if (!registerRequestSchema.shape.email.safeParse(email).success)
    throw new Error('A valid --email is required');
  const blindIndex = computeEmailBlindIndex(email, options.pepper);
  const temporaryPassword = randomBytes(32).toString('base64url');
  const passwordHash = await hashPassword(temporaryPassword);

  return db.transaction(async (tx) => {
    // A consistent lock order serializes recovery runs and fences concurrent account edits.
    const users = await tx.select().from(schema.users).orderBy(asc(schema.users.id)).for('update');
    const admins = users.filter((user) => user.role === 'admin');
    const selected = options.userId
      ? admins.find((user) => user.id === options.userId!.toLowerCase())
      : admins.length === 1
        ? admins[0]
        : undefined;
    if (!selected) {
      throw new Error(
        `Select an admin with --user-id. Admin ids: ${admins.map((user) => user.id).join(', ') || '(none)'}`,
      );
    }

    const emails = new Map(
      users.map((user) => [user.id, tryDecryptEmail(user.emailEncrypted, options.key)]),
    );
    if (
      users.some(
        (user) =>
          user.id !== selected.id &&
          emails.get(user.id) !== null &&
          (user.emailBlindIndex === blindIndex || emails.get(user.id) === email),
      )
    ) {
      throw new Error('The email is already held by a readable user');
    }

    // An orphan remains unreadable after its password is cleared. Audit evidence of the
    // exact ciphertext and token version keeps a retry from invalidating it again.
    const cleared = await tx
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, CLEAR_ACTION));
    for (const user of users) {
      if (user.id === selected.id || emails.get(user.id) !== null) continue;
      const emailDigest = createHash('sha256').update(user.emailEncrypted).digest('hex');
      const alreadyCleared = cleared.some((event) => {
        const metadata = event.metadata as Record<string, unknown> | null;
        return (
          event.targetId === user.id &&
          metadata?.emailDigest === emailDigest &&
          metadata.tokenVersion === user.tokenVersion
        );
      });
      if (!alreadyCleared) {
        await tx
          .update(schema.users)
          .set({
            passwordHash: await hashPassword(randomBytes(32).toString('hex')),
            mustChangePassword: true,
            tokenVersion: sql`${schema.users.tokenVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, user.id));
        await tx.insert(schema.auditEvents).values({
          actorUserId: SYSTEM_ACTOR,
          action: CLEAR_ACTION,
          targetType: 'user',
          targetId: user.id,
          metadata: { emailDigest, tokenVersion: user.tokenVersion + 1 },
        });
      }
      // A damaged row can still hold the requested index. Free only an unreadable
      // row's collision, in this same transaction, before assigning it to the admin.
      if (user.emailBlindIndex === blindIndex) {
        await tx
          .update(schema.users)
          .set({ emailBlindIndex: randomBytes(32).toString('hex') })
          .where(eq(schema.users.id, user.id));
      }
    }

    const relink = emails.get(selected.id) !== email || selected.emailBlindIndex !== blindIndex;
    await tx
      .update(schema.users)
      .set({
        ...(relink
          ? { emailEncrypted: encryptEmail(email, options.key), emailBlindIndex: blindIndex }
          : {}),
        passwordHash,
        mustChangePassword: true,
        status: 'active',
        tokenVersion: sql`${schema.users.tokenVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, selected.id));
    await tx.insert(schema.auditEvents).values({
      actorUserId: SYSTEM_ACTOR,
      action: 'user.recover_admin',
      targetType: 'user',
      targetId: selected.id,
      metadata: { relinked: relink, reactivated: selected.status !== 'active' },
    });
    return { userId: selected.id, temporaryPassword };
  });
}

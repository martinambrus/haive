import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, inArray, or, sql } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';

export { createDatabase, schema };
export const KEK = 'ab'.repeat(32);
export async function makeActor(db: Database) {
  const [user] = await db
    .insert(schema.users)
    .values({
      emailEncrypted: randomUUID(),
      emailBlindIndex: randomBytes(16).toString('hex'),
      passwordHash: 'synthetic-hash',
      role: 'admin',
    })
    .returning();
  return user!;
}
interface AuditScope {
  anonymous?: boolean;
  registrationBlindIndex?: string;
}
export async function refuseAudit(db: Database, userId: string, scope: AuditScope = {}) {
  if (!/^[a-f0-9-]{36}$/.test(userId)) throw new Error('Invalid test actor');
  const registration = scope.registrationBlindIndex ?? '';
  if (registration && !/^[a-f0-9]{64}$/.test(registration))
    throw new Error('Invalid test registration');
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION refuse_security_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.actor_user_id = TG_ARGV[0]::uuid OR NEW.target_id = TG_ARGV[0]::uuid
        OR (TG_ARGV[1] = 'anonymous' AND NEW.actor_user_id = '00000000-0000-0000-0000-000000000000'::uuid
          AND NEW.target_id IS NULL AND NEW.action IN ('auth.login.failure', 'auth.login.throttled'))
        OR (TG_ARGV[2] <> '' AND NEW.action = 'user.register' AND EXISTS (
          SELECT 1 FROM users WHERE id = NEW.target_id AND email_blind_index = TG_ARGV[2]))
      THEN RAISE EXCEPTION 'audit insert refused'; END IF;
      RETURN NEW;
    END $$
  `);
  await db.execute(
    sql.raw(
      `CREATE TRIGGER refuse_security_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_security_audit('${userId}', '${scope.anonymous ? 'anonymous' : ''}', '${registration}')`,
    ),
  );
}
export async function allowAudit(db: Database) {
  await db.execute(sql`DROP TRIGGER IF EXISTS refuse_security_audit ON audit_events`);
  await db.execute(sql`DROP FUNCTION IF EXISTS refuse_security_audit()`);
}
export const audits = (db: Database) => db.select().from(schema.auditEvents);
export async function cleanActor(db: Database, userId: string, scope: AuditScope = {}) {
  await db
    .delete(schema.auditEvents)
    .where(
      or(
        eq(schema.auditEvents.actorUserId, userId),
        eq(schema.auditEvents.targetId, userId),
        ...(scope.anonymous
          ? [
              and(
                eq(schema.auditEvents.actorUserId, '00000000-0000-0000-0000-000000000000'),
                isNull(schema.auditEvents.targetId),
                inArray(schema.auditEvents.action, ['auth.login.failure', 'auth.login.throttled']),
              ),
            ]
          : []),
      ),
    );
  await db.delete(schema.users).where(eq(schema.users.id, userId));
}

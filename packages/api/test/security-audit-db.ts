import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';

export const url = process.env.SECURITY_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/t376_audit_test'))
  throw new Error('Use a dedicated t376_audit_test database');
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
export async function refuseAudit(db: Database, table = 'audit_events') {
  if (!['audit_events', 'global_kb_audit_events'].includes(table)) throw new Error('Bad table');
  await db.execute(
    sql.raw(
      "CREATE OR REPLACE FUNCTION refuse_t376_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit insert refused'; END $$",
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE TRIGGER refuse_t376_audit BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_t376_audit()`,
    ),
  );
}
export async function allowAudit(db: Database, table = 'audit_events') {
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS refuse_t376_audit ON ${table}`));
  await db.execute(sql.raw('DROP FUNCTION IF EXISTS refuse_t376_audit()'));
}
export const audits = (db: Database) => db.select().from(schema.auditEvents);
export async function cleanActor(db: Database, userId: string) {
  await db.delete(schema.auditEvents);
  await db.delete(schema.users).where(eq(schema.users.id, userId));
}

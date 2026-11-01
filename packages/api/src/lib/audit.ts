import { sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';

const log = logger.child({ module: 'audit' });

/** No authenticated actor. A fixed sentinel records no login identifier or derived fingerprint. */
export const ANONYMOUS_AUDIT_ACTOR = '00000000-0000-0000-0000-000000000000';

export interface AuditEvent {
  /** Who performed the action (plain uuid; no FK). */
  actorUserId: string;
  /** Namespaced action, e.g. 'credential.update', 'user.set_role'. */
  action: string;
  /** Affected entity kind, e.g. 'repo_credential', 'user'. */
  targetType: string;
  /** Affected entity id, when applicable. */
  targetId?: string | null;
  /** Extra non-secret context (host, label, changed-field booleans, role). */
  metadata?: Record<string, unknown> | null;
}

export function logAuditEvent(event: AuditEvent): void {
  log.info(
    {
      actorUserId: event.actorUserId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId ?? null,
      ...(event.metadata ?? {}),
    },
    `audit: ${event.action}`,
  );
}

/** Throws on a failed insert, so inside a transaction a failed row fails the change; log after the commit. */
export async function insertAuditEvent(
  db: Pick<Database, 'insert'>,
  event: AuditEvent,
): Promise<void> {
  await db.insert(schema.auditEvents).values({
    actorUserId: event.actorUserId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId ?? null,
    metadata: event.metadata ?? null,
    // clock_timestamp(), not the default now(): inside a transaction now() is when it began.
    createdAt: sql`clock_timestamp()`,
  });
}

/** Dual-write an audit event: a pino line (stream — greppable, shippable) plus a
 *  durable audit_events row (survives log rotation). The DB insert is
 *  best-effort — an audit-write failure is itself logged but never breaks the
 *  user operation, which has already succeeded by the time this is called. Never
 *  pass secret/username plaintext in metadata. Not for security actions (users,
 *  invites, credentials, secrets): those write insertAuditEvent inside the change's
 *  transaction, so a row that cannot be written undoes the change. */
export async function recordAuditEvent(
  db: Pick<Database, 'insert'>,
  event: AuditEvent,
): Promise<void> {
  logAuditEvent(event);
  try {
    await insertAuditEvent(db, event);
  } catch (err) {
    log.error({ err, action: event.action }, 'failed to write audit event');
  }
}

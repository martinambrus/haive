import type { Database } from '@haive/database';
import { logger } from '@haive/shared';
import { insertAuditEvent, writeAuditLog, type AuditEvent } from '@haive/shared/audit';

const log = logger.child({ module: 'audit' });

/** No authenticated actor. A fixed sentinel records no login identifier or derived fingerprint. */
export const ANONYMOUS_AUDIT_ACTOR = '00000000-0000-0000-0000-000000000000';

export { insertAuditEvent, type AuditEvent };

/** Call only after the transaction that inserted this event commits. Logs through the api's
 *  own `audit` child logger. */
export function logAuditEvent(event: AuditEvent): void {
  writeAuditLog(log, event);
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

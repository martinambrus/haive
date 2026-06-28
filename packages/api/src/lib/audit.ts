import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { getDb } from '../db.js';

const log = logger.child({ module: 'audit' });

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

/** Dual-write an audit event: a pino line (stream — greppable, shippable) plus a
 *  durable audit_events row (survives log rotation). The DB insert is
 *  best-effort — an audit-write failure is itself logged but never breaks the
 *  user operation, which has already succeeded by the time this is called. Never
 *  pass secret/username plaintext in metadata. */
export async function recordAuditEvent(
  db: ReturnType<typeof getDb>,
  event: AuditEvent,
): Promise<void> {
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
  try {
    await db.insert(schema.auditEvents).values({
      actorUserId: event.actorUserId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId ?? null,
      metadata: event.metadata ?? null,
    });
  } catch (err) {
    log.error({ err, action: event.action }, 'failed to write audit event');
  }
}

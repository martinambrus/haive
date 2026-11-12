import { sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from './logger/index.js';

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

/** Call only after the transaction that inserted this event commits. */
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
  options: { id?: string } = {},
): Promise<void> {
  await db.insert(schema.auditEvents).values({
    // A caller compensating a failed external effect needs its exact committed row.
    ...(options.id ? { id: options.id } : {}),
    actorUserId: event.actorUserId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId ?? null,
    metadata: event.metadata ?? null,
    // clock_timestamp(), not the default now(): inside a transaction now() is when it began.
    createdAt: sql`clock_timestamp()`,
  });
}

/** Counts changed exclusions without recording repository path values. */
export function summarizeScopeChange(
  before: string[] | null | undefined,
  after: string[] | null | undefined,
): { addedCount: number; removedCount: number } {
  const previous = new Set(before ?? []);
  const wanted = new Set(after ?? []);
  return {
    addedCount: [...wanted].filter((glob) => !previous.has(glob)).length,
    removedCount: [...previous].filter((glob) => !wanted.has(glob)).length,
  };
}

/** Presence, counts and booleans only; never include rules, commands or other setting text. */
export function summarizeSecurityFields(fields: string[], updates: Record<string, unknown>) {
  return {
    values: Object.fromEntries(
      fields.map((field) => {
        const value = updates[field];
        return [
          field,
          field === 'appAuth'
            ? Boolean((value as { enabled?: boolean } | null)?.enabled)
            : typeof value === 'boolean'
              ? value
              : Array.isArray(value)
                ? value.length
                : value && typeof value === 'object'
                  ? Object.keys(value).length
                  : value !== null,
        ];
      }),
    ),
  };
}

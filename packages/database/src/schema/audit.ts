import { pgTable, uuid, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

/** Append-only audit trail for security-sensitive mutations (git credential
 *  create/update/delete, admin user actions). Durable counterpart to the pino
 *  audit log line, which goes to stdout and rotates. Deliberately NO foreign
 *  keys: audit rows must outlive the user/credential they reference, so
 *  actorUserId/targetId are plain uuids. Never updated or deleted by
 *  application code. Secret/username plaintext is never stored — only
 *  non-sensitive metadata (host, label, changed-field booleans, role). */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Who performed the action (plain uuid; no FK so the row survives deletion). */
    actorUserId: uuid('actor_user_id').notNull(),
    /** Namespaced action, e.g. 'credential.update', 'user.set_role'. */
    action: varchar('action', { length: 64 }).notNull(),
    /** Affected entity kind, e.g. 'repo_credential', 'user'. */
    targetType: varchar('target_type', { length: 64 }).notNull(),
    /** Affected entity id, when applicable. */
    targetId: uuid('target_id'),
    /** Extra non-secret context. */
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('audit_events_actor_idx').on(table.actorUserId),
    index('audit_events_target_idx').on(table.targetId),
    index('audit_events_created_idx').on(table.createdAt),
    index('audit_events_action_idx').on(table.action),
  ],
);

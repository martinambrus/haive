import { sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { sameValue } from '@haive/shared/project-state';

const log = logger.child({ module: 'audit' });

export interface AuditEvent {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditActor {
  userId: string;
  kind: 'repository_owner' | 'task_user' | 'resolving_user';
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

/** An audit refusal must fail the setting's own transaction. */
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
    createdAt: sql`clock_timestamp()`,
  });
}

/** The API-audited portable columns. Never copy values into the event or its log. */
export async function auditRepositorySettings(
  tx: Pick<Database, 'insert'>,
  {
    repositoryId,
    actor,
    source,
    before,
    updates,
  }: {
    repositoryId: string;
    actor: AuditActor;
    source:
      'project_state_sync' | 'project_state_resolve' | 'rag_source_selection' | 'clone_import';
    before: object;
    updates: Record<string, unknown>;
  },
): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  for (const [field, action] of [
    ['scopeExcludeGlobs', 'repository.scope.update'],
    ['agentRulesOverride', 'repository.security.update'],
  ] as const) {
    if (
      !Object.hasOwn(updates, field) ||
      sameValue((before as Record<string, unknown>)[field] ?? null, updates[field] ?? null)
    )
      continue;
    let summary: Record<string, unknown>;
    if (field === 'scopeExcludeGlobs') {
      const previous = new Set(
        (before as { scopeExcludeGlobs?: string[] | null }).scopeExcludeGlobs ?? [],
      );
      const wanted = new Set((updates[field] as string[] | null) ?? []);
      summary = {
        addedCount: [...wanted].filter((glob) => !previous.has(glob)).length,
        removedCount: [...previous].filter((glob) => !wanted.has(glob)).length,
      };
    } else {
      // Match the API's presence summary; never include the rule text.
      summary = { values: { agentRulesOverride: updates[field] != null } };
    }
    const event: AuditEvent = {
      actorUserId: actor.userId,
      action,
      targetType: 'repository',
      targetId: repositoryId,
      metadata: { source, actorKind: actor.kind, fields: [field], ...summary },
    };
    await insertAuditEvent(tx, event);
    events.push(event);
  }
  return events;
}

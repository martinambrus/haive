import type { Database } from '@haive/database';
import { sameValue } from '@haive/shared/project-state';
import {
  insertAuditEvent,
  summarizeScopeChange,
  summarizeSecurityFields,
  type AuditEvent,
} from '@haive/shared/audit';
export { insertAuditEvent, logAuditEvent, type AuditEvent } from '@haive/shared/audit';

export interface AuditActor {
  userId: string;
  kind: 'repository_owner' | 'task_user' | 'resolving_user';
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
      const delta = summarizeScopeChange(
        (before as { scopeExcludeGlobs?: string[] | null }).scopeExcludeGlobs,
        updates[field] as string[] | null,
      );
      // The API audits membership changes, not null/empty, ordering or duplicate-only changes.
      if (!delta.addedCount && !delta.removedCount) continue;
      summary = delta;
    } else {
      summary = summarizeSecurityFields([field], updates);
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

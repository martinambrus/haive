import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import type { IntegrationRequirement } from '../modularity/contracts.js';
import { listIntegrationProviders, loadProviderEnablement } from './providers.js';
import {
  resolveRequirements,
  resolveTarget,
  type IntegrationResolution,
  type ResolverChoice,
  type ResolverConnection,
  type ResolverContext,
  type ResolverPreference,
  type ResolverRepository,
  type TargetResolution,
} from './resolver.js';

export type ResolutionSubject =
  | { taskId: string }
  | {
      draft: {
        userId: string;
        repositoryId: string | null;
        choices?: ReadonlyMap<string, string>;
      };
    };

async function loadRepository(
  db: Database | DbTx,
  repositoryId: string | null,
): Promise<ResolverRepository | null> {
  if (repositoryId === null) return null;
  const [row] = await db
    .select({
      remoteUrl: schema.repositories.remoteUrl,
      restricted: schema.repositories.integrationsRestricted,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId));
  if (row === undefined) return null;
  const entries = row.restricted
    ? await db
        .select({ connectionId: schema.integrationGrants.connectionId })
        .from(schema.integrationGrants)
        .where(
          and(
            eq(schema.integrationGrants.targetKind, 'repository'),
            eq(schema.integrationGrants.repositoryId, repositoryId),
            isNull(schema.integrationGrants.categoryId),
          ),
        )
    : [];
  return {
    remoteUrl: row.remoteUrl,
    restricted: row.restricted,
    allowedConnectionIds: new Set(entries.map((entry) => entry.connectionId)),
  };
}

export async function loadResolverContext(
  db: Database | DbTx,
  subject: ResolutionSubject,
): Promise<ResolverContext> {
  let ownerUserId: string;
  let repositoryId: string | null;
  if ('taskId' in subject) {
    const [task] = await db
      .select({ userId: schema.tasks.userId, repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, subject.taskId));
    if (task === undefined) throw new Error(`task ${subject.taskId} was not found`);
    ownerUserId = task.userId;
    repositoryId = task.repositoryId;
  } else {
    ownerUserId = subject.draft.userId;
    repositoryId = subject.draft.repositoryId;
  }

  const repository = await loadRepository(db, repositoryId);
  const enablement = await loadProviderEnablement(db);
  const providers = listIntegrationProviders().map((spec) => ({
    id: spec.id,
    categories: spec.categories,
    enabled: enablement.get(spec.id) ?? false,
  }));

  const connectionRows = await db
    .select({
      id: schema.integrationConnections.id,
      providerId: schema.integrationConnections.providerId,
      scope: schema.integrationConnections.scope,
      ownerUserId: schema.integrationConnections.ownerUserId,
      status: schema.integrationConnections.status,
      credentialProvider: schema.repoCredentials.provider,
      credentialHost: schema.repoCredentials.host,
    })
    .from(schema.integrationConnections)
    .leftJoin(
      schema.repoCredentials,
      eq(schema.repoCredentials.id, schema.integrationConnections.repoCredentialId),
    )
    .where(
      and(
        eq(schema.integrationConnections.scope, 'user'),
        eq(schema.integrationConnections.ownerUserId, ownerUserId),
      ),
    )
    .orderBy(asc(schema.integrationConnections.createdAt), asc(schema.integrationConnections.id));
  const connections: ResolverConnection[] = connectionRows.map((row) => ({
    id: row.id,
    providerId: row.providerId,
    scope: row.scope,
    ownerUserId: row.ownerUserId,
    status: row.status,
    credential:
      row.credentialHost === null
        ? null
        : { provider: row.credentialProvider, host: row.credentialHost },
  }));

  const preferences = new Map<string, ResolverPreference>();
  const defaults = new Map<string, string>();
  const preferenceRows = await db
    .select({
      userId: schema.integrationCategoryPreferences.userId,
      categoryId: schema.integrationCategoryPreferences.categoryId,
      providerId: schema.integrationCategoryPreferences.providerId,
      connectionId: schema.integrationCategoryPreferences.connectionId,
    })
    .from(schema.integrationCategoryPreferences)
    .where(
      or(
        eq(schema.integrationCategoryPreferences.userId, ownerUserId),
        isNull(schema.integrationCategoryPreferences.userId),
      ),
    );
  for (const row of preferenceRows) {
    if (row.userId === null) defaults.set(row.categoryId, row.providerId);
    else
      preferences.set(row.categoryId, {
        providerId: row.providerId,
        connectionId: row.connectionId,
      });
  }

  const choices = new Map<string, ResolverChoice>();
  const grants = new Map<string, string>();
  if ('taskId' in subject) {
    const choiceRows = await db
      .select({
        categoryId: schema.taskIntegrationChoices.categoryId,
        providerId: schema.taskIntegrationChoices.providerId,
        connectionId: schema.taskIntegrationChoices.connectionId,
      })
      .from(schema.taskIntegrationChoices)
      .where(eq(schema.taskIntegrationChoices.taskId, subject.taskId));
    for (const row of choiceRows) {
      choices.set(row.categoryId, { providerId: row.providerId, connectionId: row.connectionId });
    }
    const grantRows = await db
      .select({
        categoryId: schema.integrationGrants.categoryId,
        connectionId: schema.integrationGrants.connectionId,
      })
      .from(schema.integrationGrants)
      .where(
        and(
          eq(schema.integrationGrants.targetKind, 'task'),
          eq(schema.integrationGrants.taskId, subject.taskId),
          isNotNull(schema.integrationGrants.categoryId),
        ),
      );
    for (const row of grantRows) grants.set(row.categoryId!, row.connectionId);
  } else {
    for (const [categoryId, connectionId] of subject.draft.choices ?? []) {
      const providerId = connections.find((c) => c.id === connectionId)?.providerId ?? null;
      choices.set(categoryId, { providerId, connectionId });
    }
  }

  return {
    ownerUserId,
    repository,
    providers,
    connections,
    choices,
    grants,
    preferences,
    defaults,
  };
}

export async function resolveStepIntegrations(
  db: Database | DbTx,
  subject: ResolutionSubject,
  requirements: readonly IntegrationRequirement[],
): Promise<IntegrationResolution[]> {
  if (requirements.length === 0) return [];
  return resolveRequirements(await loadResolverContext(db, subject), requirements);
}

export async function resolveTaskCategories(
  db: Database | DbTx,
  args: ResolutionSubject & { categories: readonly string[] },
): Promise<TargetResolution[]> {
  const context = await loadResolverContext(db, args);
  return args.categories.map((category) => resolveTarget(context, { category }));
}

export async function recordTaskGrants(
  db: Database | DbTx,
  taskId: string,
  resolutions: readonly IntegrationResolution[],
): Promise<void> {
  const connectionByCategory = new Map<string, string>();
  for (const resolution of resolutions) {
    if (resolution.status !== 'resolved' || resolution.categoryId === null) continue;
    if (!connectionByCategory.has(resolution.categoryId)) {
      connectionByCategory.set(resolution.categoryId, resolution.connectionId);
    }
  }
  if (connectionByCategory.size === 0) return;
  await db
    .insert(schema.integrationGrants)
    .values(
      [...connectionByCategory].map(([categoryId, connectionId]) => ({
        targetKind: 'task' as const,
        taskId,
        categoryId,
        connectionId,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.integrationGrants.taskId, schema.integrationGrants.categoryId],
      targetWhere: sql`${schema.integrationGrants.targetKind} = 'task'`,
      set: { connectionId: sql`excluded.connection_id` },
      setWhere: sql`${schema.integrationGrants.connectionId} IS DISTINCT FROM excluded.connection_id`,
    });
}

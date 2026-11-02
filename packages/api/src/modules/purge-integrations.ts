import { and, inArray, or, sql, type AnyColumn } from 'drizzle-orm';
import { LIVE_TASK_STATUSES, schema, type Database } from '@haive/database';
import { modulePackageId, MODULE_DEPENDENTS_CAP } from '@haive/shared/modularity';

export interface ModuleIntegrationCounts {
  providerConfigs: number;
  connections: number;
  userSettings: number;
  preferences: number;
  taskChoices: number;
  grants: number;
}

export const emptyModuleIntegrationCounts = (): ModuleIntegrationCounts => ({
  providerConfigs: 0,
  connections: 0,
  userSettings: 0,
  preferences: 0,
  taskChoices: 0,
  grants: 0,
});

/** Same persisted scoped-id grammar as parseProviderId/parseCategoryId, even after uninstall. */
export function moduleIntegrationIdPattern(moduleId: string): string {
  if (modulePackageId(`@haive/module-${moduleId}`) !== moduleId)
    throw new Error('Invalid module id');
  return `^module\\.${moduleId}\\.[a-z0-9][a-z0-9_-]*$`;
}

export function moduleIntegrationPredicates(moduleId: string) {
  const pattern = moduleIntegrationIdPattern(moduleId);
  const owned = (column: AnyColumn) => sql`${column} ~ ${pattern}`;
  const connections = owned(schema.integrationConnections.providerId);
  const ownedConnection = (column: AnyColumn) =>
    inArray(
      column,
      sql`(SELECT ${schema.integrationConnections.id} FROM ${schema.integrationConnections} WHERE ${connections})`,
    );
  return {
    providerConfigs: owned(schema.integrationProviderConfigs.providerId),
    connections,
    userSettings: owned(schema.integrationUserSettings.providerId),
    preferences: or(
      owned(schema.integrationCategoryPreferences.categoryId),
      owned(schema.integrationCategoryPreferences.providerId),
      ownedConnection(schema.integrationCategoryPreferences.connectionId),
    )!,
    taskChoices: or(
      owned(schema.taskIntegrationChoices.categoryId),
      owned(schema.taskIntegrationChoices.providerId),
      ownedConnection(schema.taskIntegrationChoices.connectionId),
    )!,
    grants: or(
      owned(schema.integrationGrants.categoryId),
      ownedConnection(schema.integrationGrants.connectionId),
    )!,
  };
}

export function moduleIntegrationTaskPredicate(moduleId: string) {
  const p = moduleIntegrationPredicates(moduleId);
  return sql`(EXISTS (SELECT 1 FROM ${schema.taskIntegrationChoices} WHERE ${schema.taskIntegrationChoices.taskId} = ${schema.tasks.id} AND ${p.taskChoices})
    OR EXISTS (SELECT 1 FROM ${schema.integrationGrants} WHERE ${schema.integrationGrants.taskId} = ${schema.tasks.id} AND ${p.grants}))`;
}

export async function moduleIntegrationDependents(db: Pick<Database, 'select'>, moduleId: string) {
  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      ownerId: schema.tasks.userId,
      currentStepId: schema.tasks.currentStepId,
    })
    .from(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.status, [...LIVE_TASK_STATUSES]),
        moduleIntegrationTaskPredicate(moduleId),
      ),
    )
    .orderBy(schema.tasks.id)
    .limit(MODULE_DEPENDENTS_CAP + 1);
  return {
    tasks: rows.slice(0, MODULE_DEPENDENTS_CAP),
    capped: rows.length > MODULE_DEPENDENTS_CAP,
  };
}

/** One statement gives the confirmation a consistent snapshot; no account labels or secrets. */
export async function previewModuleIntegrations(
  db: Pick<Database, 'select'>,
  moduleId: string,
): Promise<ModuleIntegrationCounts> {
  const p = moduleIntegrationPredicates(moduleId);
  const [row] = await db
    .select({
      providerConfigs: sql<number>`(SELECT count(*)::int FROM ${schema.integrationProviderConfigs} WHERE ${p.providerConfigs})`,
      connections: sql<number>`(SELECT count(*)::int FROM ${schema.integrationConnections} WHERE ${p.connections})`,
      userSettings: sql<number>`(SELECT count(*)::int FROM ${schema.integrationUserSettings} WHERE ${p.userSettings})`,
      preferences: sql<number>`(SELECT count(*)::int FROM ${schema.integrationCategoryPreferences} WHERE ${p.preferences})`,
      taskChoices: sql<number>`(SELECT count(*)::int FROM ${schema.taskIntegrationChoices} WHERE ${p.taskChoices})`,
      grants: sql<number>`(SELECT count(*)::int FROM ${schema.integrationGrants} WHERE ${p.grants})`,
    })
    .from(sql`(SELECT 1) AS snapshot`);
  return row!;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Explicitly remove references before accounts: a cascade/SET NULL must not hide or double-count them. */
export async function deleteModuleIntegrations(
  tx: Transaction,
  moduleId: string,
): Promise<ModuleIntegrationCounts> {
  const p = moduleIntegrationPredicates(moduleId);
  const deleted = async (
    table: Parameters<Transaction['delete']>[0],
    predicate: ReturnType<typeof sql>,
  ) => {
    const result = await tx.execute(
      sql`WITH deleted AS (DELETE FROM ${table} WHERE ${predicate} RETURNING 1) SELECT count(*)::int AS n FROM deleted`,
    );
    return Number(result[0]!.n);
  };
  const grants = await deleted(schema.integrationGrants, p.grants);
  const taskChoices = await deleted(schema.taskIntegrationChoices, p.taskChoices);
  const preferences = await deleted(schema.integrationCategoryPreferences, p.preferences);
  const userSettings = await deleted(schema.integrationUserSettings, p.userSettings);
  const providerConfigs = await deleted(schema.integrationProviderConfigs, p.providerConfigs);
  const connections = await deleted(schema.integrationConnections, p.connections);
  return { providerConfigs, connections, userSettings, preferences, taskChoices, grants };
}

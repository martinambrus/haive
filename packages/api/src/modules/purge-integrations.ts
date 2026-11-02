import { and, inArray, sql } from 'drizzle-orm';
import { LIVE_TASK_STATUSES, schema, type Database } from '@haive/database';
import { MODULE_DEPENDENTS_CAP } from '@haive/shared/modularity';

import {
  moduleIntegrationPredicates,
  moduleIntegrationTaskPredicate,
} from '@haive/shared/modularity-server';
export {
  moduleIntegrationIdPattern,
  moduleIntegrationPredicates,
  moduleIntegrationTaskPredicate,
} from '@haive/shared/modularity-server';

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
  const deleted = async (statement: ReturnType<typeof sql>) => {
    const result = await tx.execute(
      sql`WITH deleted AS (${statement} RETURNING 1) SELECT count(*)::int AS n FROM deleted`,
    );
    return Number(result[0]!.n);
  };
  const grants = await deleted(tx.delete(schema.integrationGrants).where(p.grants).getSQL());
  const taskChoices = await deleted(
    tx.delete(schema.taskIntegrationChoices).where(p.taskChoices).getSQL(),
  );
  const preferences = await deleted(
    tx.delete(schema.integrationCategoryPreferences).where(p.preferences).getSQL(),
  );
  const userSettings = await deleted(
    tx.delete(schema.integrationUserSettings).where(p.userSettings).getSQL(),
  );
  const providerConfigs = await deleted(
    tx.delete(schema.integrationProviderConfigs).where(p.providerConfigs).getSQL(),
  );
  const connections = await deleted(
    tx.delete(schema.integrationConnections).where(p.connections).getSQL(),
  );
  return { providerConfigs, connections, userSettings, preferences, taskChoices, grants };
}

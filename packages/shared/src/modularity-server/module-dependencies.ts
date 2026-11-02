import { inArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { schema } from '@haive/database';
import { modulePackageId } from '../modularity/contracts.js';

/** Same persisted scoped-id grammar as parseProviderId/parseCategoryId, even after uninstall. */
export function moduleIntegrationIdPattern(moduleId: string): string;
export function moduleIntegrationIdPattern(moduleId: string | SQL): string | SQL;
export function moduleIntegrationIdPattern(moduleId: string | SQL): string | SQL {
  if (typeof moduleId !== 'string')
    return sql`('^module[.]' || ${moduleId} || '[.][a-z0-9][a-z0-9_-]*$')`;
  if (modulePackageId(`@haive/module-${moduleId}`) !== moduleId)
    throw new Error('Invalid module id');
  return `^module\\.${moduleId}\\.[a-z0-9][a-z0-9_-]*$`;
}

export function moduleIntegrationPredicates(moduleId: string | SQL) {
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

export function moduleIntegrationTaskPredicate(moduleId: string | SQL) {
  const p = moduleIntegrationPredicates(moduleId);
  return sql`(EXISTS (SELECT 1 FROM ${schema.taskIntegrationChoices} WHERE ${schema.taskIntegrationChoices.taskId} = ${schema.tasks.id} AND ${p.taskChoices})
    OR EXISTS (SELECT 1 FROM ${schema.integrationGrants} WHERE ${schema.integrationGrants.taskId} = ${schema.tasks.id} AND ${p.grants}))`;
}

/** Correlated to tasks; persisted ownership only, never loaded provider declarations. */
export function moduleTaskDependency(moduleId: string | SQL): SQL {
  const prefix =
    typeof moduleId === 'string' ? `module.${moduleId}.` : sql`('module.' || ${moduleId} || '.')`;
  const source =
    typeof moduleId === 'string' ? `module:${moduleId}` : sql`('module:' || ${moduleId})`;
  return sql`(EXISTS (SELECT 1 FROM ${schema.taskTypeDefinitions} WHERE ${schema.taskTypeDefinitions.slug} = ${schema.tasks.type} AND ${schema.taskTypeDefinitions.source} = ${source})
    OR CASE WHEN jsonb_typeof(${schema.tasks.runListSnapshot}) = 'array' THEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(${schema.tasks.runListSnapshot}) AS s(id) WHERE starts_with(s.id, ${prefix})) ELSE false END
    OR EXISTS (SELECT 1 FROM ${schema.moduleTaskAdmissions} WHERE ${schema.moduleTaskAdmissions.moduleId} = ${moduleId} AND ${schema.moduleTaskAdmissions.taskId} = ${schema.tasks.id})
    OR ${moduleIntegrationTaskPredicate(moduleId)}
    OR EXISTS (SELECT 1 FROM ${schema.cliInvocations} WHERE ${schema.cliInvocations.taskId} = ${schema.tasks.id}
      AND ${schema.cliInvocations.supersededAt} IS NULL
      AND (${schema.cliInvocations.endedAt} IS NULL OR (
        ${schema.cliInvocations.mode} = 'agent_mining' AND EXISTS (
          SELECT 1 FROM ${schema.taskSteps} WHERE ${schema.taskSteps.id} = ${schema.cliInvocations.taskStepId}
          AND ${schema.taskSteps.stepId} = ${schema.tasks.currentStepId} AND ${schema.taskSteps.round} = ${schema.tasks.currentRound}
          AND ${schema.taskSteps.status} IN ('pending', 'running', 'waiting_cli', 'waiting_form')
          AND EXISTS (SELECT 1 FROM ${schema.taskStepAgentMinings} WHERE ${schema.taskStepAgentMinings.taskStepId} = ${schema.taskSteps.id} AND ${schema.taskStepAgentMinings.cliInvocationId} = ${schema.cliInvocations.id})
          AND EXISTS (SELECT 1 FROM ${schema.taskStepAgentMinings} WHERE ${schema.taskStepAgentMinings.taskStepId} = ${schema.taskSteps.id} AND ${schema.taskStepAgentMinings.status} IN ('pending', 'running'))
        )))
      AND CASE WHEN jsonb_typeof(${schema.cliInvocations.integrations}) = 'array' THEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(${schema.cliInvocations.integrations}) AS binding(value)
        WHERE binding.value ->> 'providerId' ~ ${moduleIntegrationIdPattern(moduleId)}
           OR binding.value ->> 'categoryId' ~ ${moduleIntegrationIdPattern(moduleId)}
      ) ELSE false END))`;
}

import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { parseIntegrationBindings, type IntegrationBinding } from '@haive/shared/integrations';

export const TASK_ID = '0b9a6c3e-4f1d-4a52-8c11-0a1b2c3d4e01';
export const STEP_ROW_ID = '0b9a6c3e-4f1d-4a52-8c11-0a1b2c3d4e02';
export const INV_1 = '0b9a6c3e-4f1d-4a52-8c11-0a1b2c3d4e03';
export const INV_2 = '0b9a6c3e-4f1d-4a52-8c11-0a1b2c3d4e04';
export const INV_3 = '0b9a6c3e-4f1d-4a52-8c11-0a1b2c3d4e05';
export const CONNECTION_ID = '5b0f9c1e-1111-4111-8111-111111111111';

export const STAMP: IntegrationBinding[] = [
  {
    requirementId: 'pull-requests',
    categoryId: 'forge',
    providerId: 'github',
    connectionId: CONNECTION_ID,
    access: 'write',
  },
];

if (parseIntegrationBindings(STAMP).length !== 1) throw new Error('the harness stamp must parse');

export interface InvocationRow {
  id: string;
  integrations: unknown;
}

/** The tables a wiring run reads, with the evaluated `where` of the shared fake: a lookup that ignores its id finds the wrong stamp. */
export function fakeDatabase(
  opts: {
    invocations?: InvocationRow[];
    customSteps?: unknown;
    stepId?: string;
    /** Leave the invocations table out: any read of it throws, as a database without it would. */
    withoutInvocations?: boolean;
  } = {},
): Database {
  const fake = createFakeDb({
    tasks: schema.tasks,
    envTemplates: schema.envTemplates,
    taskSteps: schema.taskSteps,
    repositories: schema.repositories,
    ...(opts.withoutInvocations ? {} : { cliInvocations: schema.cliInvocations }),
  });
  fake.insert(schema.tasks, {
    id: TASK_ID,
    envTemplateId: null,
    repositoryId: null,
    customSteps: opts.customSteps ?? null,
  });
  fake.insert(schema.taskSteps, {
    id: STEP_ROW_ID,
    taskId: TASK_ID,
    stepId: opts.stepId ?? 'custom.demo.audit',
  });
  for (const row of opts.withoutInvocations ? [] : (opts.invocations ?? [])) {
    fake.insert(schema.cliInvocations, {
      id: row.id,
      taskId: TASK_ID,
      taskStepId: STEP_ROW_ID,
      integrations: row.integrations,
    });
  }
  return fake.db as unknown as Database;
}

/** Every invocation of the task carries the same stamp, as the siblings of a fan-out do. */
export const stampedDatabase = (stamp: unknown = STAMP): Database =>
  fakeDatabase({
    invocations: [INV_1, INV_2, INV_3].map((id) => ({ id, integrations: stamp })),
  });

import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

// The fake database enforces uuid columns, so these stand in for the literal ids the Git seam
// fixtures used before they entered the real checkout lease.
export const PLAN_REPO_ID = '00000000-0000-4000-8000-000000000001';
export const PLAN_USER_ID = '00000000-0000-4000-8000-000000000002';
export const PLAN_TASK_ID = '00000000-0000-4000-8000-000000000003';
export const PLAN_STEP_ID = '00000000-0000-4000-8000-000000000004';

/** Git seam fixtures still enter the real checkout lease and ownership policy. */
export function createPlanCheckoutDb(storagePath = '/repo'): Database {
  const fake = createFakeDb({
    repositories: schema.repositories,
    planMirrorState: schema.planMirrorState,
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    taskSteps: schema.taskSteps,
  });
  fake.insert(schema.repositories, {
    id: PLAN_REPO_ID,
    userId: PLAN_USER_ID,
    status: 'ready',
    source: 'blank',
    storagePath,
    localPath: null,
    branch: 'main',
    credentialsSecretId: null,
  });
  fake.insert(schema.planMirrorState, {
    repositoryId: PLAN_REPO_ID,
    revision: 1,
    writtenRevision: 1,
  });
  return fake.db as unknown as Database;
}

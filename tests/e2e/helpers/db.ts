import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';

const DEFAULT_URL = 'postgres://haive:haive_dev_password@localhost:5432/haive';

export function getSql(): postgres.Sql {
  const url = process.env.PLAYWRIGHT_DATABASE_URL ?? DEFAULT_URL;
  return postgres(url, { max: 1, idle_timeout: 5 });
}

export interface TaskFixture {
  taskId: string;
  failedStepId: string;
  middleStepId: string;
  lastStepId: string;
}

export interface RepoFixture {
  repoId: string;
  name: string;
}

export async function seedTaskFixture(
  sql: postgres.Sql,
  userId: string,
  titleSuffix: string,
): Promise<TaskFixture> {
  const taskId = randomUUID();
  const failedStepId = randomUUID();
  const middleStepId = randomUUID();
  const lastStepId = randomUUID();
  const now = new Date();

  await sql`
    insert into tasks (
      id, user_id, type, title, status, error_message,
      current_step_id, current_step_index, created_at, updated_at
    ) values (
      ${taskId}, ${userId}, 'workflow',
      ${`e2e retry/skip ${titleSuffix} ${randomBytes(3).toString('hex')}`},
      'failed', 'simulated failure', 'failing-step', 0, ${now}, ${now}
    )
  `;

  await sql`
    insert into task_steps (
      id, task_id, step_id, step_index, title, status, error_message,
      ended_at, created_at, updated_at
    ) values
      (${failedStepId}, ${taskId}, 'failing-step', 0, 'Failing step', 'failed', 'kaboom', ${now}, ${now}, ${now}),
      (${middleStepId}, ${taskId}, 'middle-step', 1, 'Middle step', 'pending', null, null, ${now}, ${now}),
      (${lastStepId}, ${taskId}, 'last-step', 2, 'Last step', 'pending', null, null, ${now}, ${now})
  `;

  return { taskId, failedStepId, middleStepId, lastStepId };
}

export async function cleanupTaskFixture(sql: postgres.Sql, taskId: string): Promise<void> {
  await sql`delete from task_events where task_id = ${taskId}`;
  await sql`delete from task_steps where task_id = ${taskId}`;
  await sql`delete from tasks where id = ${taskId}`;
}

export async function seedRepoFixture(
  sql: postgres.Sql,
  userId: string,
  nameSuffix: string,
): Promise<RepoFixture> {
  const repoId = randomUUID();
  const name = `e2e repo ${nameSuffix} ${randomBytes(3).toString('hex')}`;
  const now = new Date();

  await sql`
    insert into repositories (
      id, user_id, name, source, local_path, remote_url, branch,
      status, detected_framework, created_at, updated_at
    ) values (
      ${repoId}, ${userId}, ${name}, 'local_path', '/tmp/e2e-fake', null, 'main',
      'ready', 'drupal7', ${now}, ${now}
    )
  `;

  return { repoId, name };
}

export async function cleanupRepoFixture(sql: postgres.Sql, repoId: string): Promise<void> {
  await sql`delete from repositories where id = ${repoId}`;
}

export async function cleanupUser(sql: postgres.Sql, userId: string): Promise<void> {
  await sql`delete from refresh_tokens where user_id = ${userId}`;
  await sql`delete from users where id = ${userId}`;
}

export async function readStepStatus(sql: postgres.Sql, stepPkId: string): Promise<string | null> {
  const rows = await sql<{ status: string }[]>`
    select status from task_steps where id = ${stepPkId}
  `;
  return rows[0]?.status ?? null;
}

export async function readTaskStatus(
  sql: postgres.Sql,
  taskId: string,
): Promise<{ status: string; currentStepId: string | null } | null> {
  const rows = await sql<{ status: string; current_step_id: string | null }[]>`
    select status, current_step_id from tasks where id = ${taskId}
  `;
  const row = rows[0];
  if (!row) return null;
  return { status: row.status, currentStepId: row.current_step_id };
}

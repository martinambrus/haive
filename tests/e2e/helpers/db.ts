import { randomBytes, randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import postgres from 'postgres';
import { API_BASE } from './auth.js';

const DEFAULT_URL = 'postgres://haive:haive_dev_password@localhost:5432/haive';

export function getSql(): postgres.Sql {
  const url = process.env.PLAYWRIGHT_DATABASE_URL ?? DEFAULT_URL;
  return postgres(url, { max: 1, idle_timeout: 5 });
}

/**
 * The failed step's id, and why it is not an arbitrary string.
 *
 * The user-facing Skip action is ALLOWLISTED server-side: `isStepSkippable` admits only the ids in
 * `SKIPPABLE_STEP_IDS` (plus `01-worktree-setup` on a `run_app` task), the skip handler answers 409
 * for anything else, and `canSkip` comes back false so the UI never renders the button. A synthetic
 * id like `failing-step` therefore cannot be skipped at all, which is what the earlier fixture used.
 *
 * If this id is ever dropped from that allowlist the skip specs fail loudly with a 409 naming it —
 * which is the right failure, and better than a fixture that silently stops covering the action.
 */
export const FIXTURE_FAILED_STEP_ID = '11a-gate-4-push';
export const FIXTURE_MIDDLE_STEP_ID = '11b-kb-commit';
export const FIXTURE_LAST_STEP_ID = '11c-rag-reindex';

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
      'failed', 'simulated failure', ${FIXTURE_FAILED_STEP_ID}, 0, ${now}, ${now}
    )
  `;

  await sql`
    insert into task_steps (
      id, task_id, step_id, step_index, title, status, error_message,
      ended_at, created_at, updated_at
    ) values
      (${failedStepId}, ${taskId}, ${FIXTURE_FAILED_STEP_ID}, 0, 'Failing step', 'failed', 'kaboom', ${now}, ${now}, ${now}),
      (${middleStepId}, ${taskId}, ${FIXTURE_MIDDLE_STEP_ID}, 1, 'Middle step', 'pending', null, null, ${now}, ${now}),
      (${lastStepId}, ${taskId}, ${FIXTURE_LAST_STEP_ID}, 2, 'Last step', 'pending', null, null, ${now}, ${now})
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

/**
 * Delete a repository through the api, which also has the worker remove its checkout; a row deleted
 * by SQL leaves the tree on disk. The api refuses while a clone holds the root, so that is waited
 * out first. `request` must carry the owner's session.
 */
export async function deleteRepoViaApi(
  sql: postgres.Sql,
  request: APIRequestContext,
  repoId: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const rows = await sql<{ status: string; claimed: Date | null }[]>`
      select status, root_claimed_at as claimed from repositories where id = ${repoId}
    `;
    if (rows.length === 0) return;
    const settled = rows[0]!.status !== 'cloning' && rows[0]!.claimed === null;
    if (settled || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const res = await request.delete(`${API_BASE}/repos/${repoId}`);
  expect.soft(res.status(), `delete of repository ${repoId}: ${await res.text()}`).toBe(200);
  if (res.status() !== 200) await sql`delete from repositories where id = ${repoId}`;
}

/** Delete a user's CLI providers through the api before the user goes, so the worker is asked to
 *  remove any image one built. `request` must carry that user's session. */
export async function deleteProvidersViaApi(
  sql: postgres.Sql,
  request: APIRequestContext,
  userId: string,
): Promise<void> {
  const rows = await sql<{ id: string }[]>`select id from cli_providers where user_id = ${userId}`;
  for (const { id } of rows) {
    const res = await request.delete(`${API_BASE}/cli-providers/${id}`);
    expect.soft(res.status(), `delete of provider ${id}: ${await res.text()}`).toBe(200);
  }
}

export async function cleanupUser(sql: postgres.Sql, userId: string): Promise<void> {
  await sql`delete from refresh_tokens where user_id = ${userId}`;
  // Before the user, not after: `consumed_by_user_id` is ON DELETE SET NULL, so deleting the user
  // first would strand the redeemed invite with nothing left to identify it by.
  await sql`delete from user_invites where consumed_by_user_id = ${userId}`;
  await sql`delete from users where id = ${userId}`;
}

export interface ProviderImageState {
  status: string | null;
  error: string | null;
}

/** Poll until the worker moves a provider's image off `building`, and return the last state read.
 *  Asserting `ready` on it makes a failed build fail with its own error rather than a timeout. */
export async function waitForProviderImage(
  sql: postgres.Sql,
  providerId: string,
  timeoutMs: number,
): Promise<ProviderImageState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await sql<{ status: string; error: string | null }[]>`
      select sandbox_image_build_status as status, sandbox_image_build_error as error
      from cli_providers where id = ${providerId}
    `;
    const state = { status: rows[0]?.status ?? null, error: rows[0]?.error ?? null };
    if (state.status !== 'building' || Date.now() >= deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
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

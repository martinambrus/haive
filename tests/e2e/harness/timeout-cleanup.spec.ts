import { randomUUID } from 'node:crypto';
import { expect, test } from '../helpers/fixtures.js';

/**
 * What a timed-out test leaves behind. The first test seeds a user and a `running` task and then
 * waits on something its page closing does not end, as a poll, a sleep or a query does, so a
 * `finally` in its body would never run. The second runs after the first one's teardown, in the
 * same worker, and checks that nothing it seeded is left.
 */
test.describe.configure({ mode: 'default' });

let seeded: { userId: string; taskId: string } | null = null;

test('times out after seeding a user and a running task', async ({ page, sql, users }) => {
  test.setTimeout(10_000);
  test.info().expectedStatus = 'timedOut';
  const { userId } = await users.register(page.request, { prefix: 'harness-timeout' });
  const taskId = randomUUID();
  await sql`
    insert into tasks (id, user_id, type, title, status, current_step_id, current_step_index)
    values (${taskId}, ${userId}, 'workflow', 'e2e harness: a test that times out', 'running',
      '02-pre-rag-sync', 0)
  `;
  seeded = { userId, taskId };
  await new Promise(() => {});
});

test('the timed-out test left no user and no task behind', async ({ sql }) => {
  expect(seeded, 'the first test seeded its user and task').not.toBeNull();
  expect(await sql`select 1 from users where id = ${seeded!.userId}`).toHaveLength(0);
  expect(await sql`select 1 from tasks where id = ${seeded!.taskId}`).toHaveLength(0);
});

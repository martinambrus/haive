import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { checkoutWorktreeRefusal } from '../src/repo-rebuild.js';

const checkout = '/repos/checkout';
const inside = `${checkout}/.haive/worktrees/feature`;
const taskId = '00000000-0000-4000-8000-000000000001';
const repositoryId = '00000000-0000-4000-8000-000000000002';
const otherTaskId = '00000000-0000-4000-8000-000000000003';

function fixture(status = 'failed', worktreePath: string | null = null) {
  const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
  fake.insert(schema.tasks, {
    id: taskId,
    repositoryId,
    status,
    worktreePath,
    worktreeBranch: null,
  });
  const step = (output: unknown, round = 0, id = taskId, stepId = '01-worktree-setup') =>
    fake.insert(schema.taskSteps, { taskId: id, stepId, round, status: 'done', output });
  return { ...fake, db: fake.db as unknown as Database, step };
}

describe('checkoutWorktreeRefusal', () => {
  it.each(['failed', 'created'])('refuses a %s task with only a legacy pointer', async (status) => {
    const fake = fixture(status);
    fake.step({ mode: 'worktree', worktreePath: inside });
    expect(await checkoutWorktreeRefusal(fake.db, repositoryId, checkout)).toContain(
      '1 task has a worktree inside this checkout',
    );
  });

  it.each(['completed', 'cancelled'])('ignores a %s legacy task', async (status) => {
    const fake = fixture(status);
    fake.step({ worktreePath: inside });
    expect(await checkoutWorktreeRefusal(fake.db, repositoryId, checkout)).toBeNull();
  });

  it('uses the latest setup round and counts each task once', async () => {
    const fake = fixture();
    fake.step({ worktreePath: inside });
    fake.step({ worktreePath: inside }, 1);
    expect(await checkoutWorktreeRefusal(fake.db, repositoryId, checkout)).toContain('1 task has');
    fake.step({ worktreePath: `${checkout}-other/feature` }, 2);
    expect(await checkoutWorktreeRefusal(fake.db, repositoryId, checkout)).toBeNull();
  });

  it('prefers the durable pointer to legacy output', async () => {
    const fake = fixture('failed', `${checkout}-other/feature`);
    fake.step({ worktreePath: inside });
    expect(await checkoutWorktreeRefusal(fake.db, repositoryId, checkout)).toBeNull();
  });

  it.each([null, {}, { worktreePath: 42 }, { worktreePath: '' }])(
    'ignores missing or invalid legacy paths: %j',
    async (output) => {
      const fake = fixture();
      fake.step(output);
      expect(await checkoutWorktreeRefusal(fake.db, repositoryId, checkout)).toBeNull();
    },
  );

  it('ignores other tasks and other step outputs', async () => {
    const fake = fixture();
    fake.step({ worktreePath: inside }, 0, otherTaskId);
    fake.step({ worktreePath: inside }, 0, taskId, '02-other-step');
    expect(await checkoutWorktreeRefusal(fake.db, repositoryId, checkout)).toBeNull();
  });
});

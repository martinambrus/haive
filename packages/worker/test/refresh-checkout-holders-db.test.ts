import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { checkoutHoldingTasks } from '../src/repo/refresh.js';

const url = process.env.CHECKOUT_HOLDERS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/checkout_holders_test')) {
  throw new Error('Use a dedicated checkout_holders_test database');
}

describe.skipIf(!url)('root checkout holders', () => {
  let db: Database;
  const userId = randomUUID();
  let repositoryId: string;
  beforeAll(async () => {
    db = createDatabase(url!);
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'x',
      emailBlindIndex: userId,
      passwordHash: 'x',
    });
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'scratch',
        source: 'blank',
      })
      .returning();
    repositoryId = repo!.id;
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });

  it.each([
    ['skipped', '/old/worktree', 'old-branch', {}, 1],
    ['done', '/active/worktree', 'active-branch', {}, 0],
    ['done', null, null, { worktreePath: '/legacy/worktree', branchName: 'legacy' }, 0],
    ['done', null, 'branch-only', {}, 0],
    ['done', null, null, {}, 1],
  ] as const)(
    'latest 01 %s with columns %s / %s and output %j counts %i',
    async (status, worktreePath, worktreeBranch, output, expected) => {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId,
          type: 'workflow',
          title: 'holder',
          status: 'running',
          worktreePath,
          worktreeBranch,
        })
        .returning();
      try {
        await db.insert(schema.taskSteps).values([
          {
            taskId: task!.id,
            stepId: '01-worktree-setup',
            stepIndex: 1,
            title: 'worktree',
            round: 0,
            status: 'done',
            output: { worktreePath: '/earlier', branchName: 'earlier' },
          },
          {
            taskId: task!.id,
            stepId: '01-worktree-setup',
            stepIndex: 1,
            title: 'worktree',
            round: 1,
            status,
            output,
          },
        ]);
        expect(await checkoutHoldingTasks(db, repositoryId, { rootOnly: true })).toBe(expected);
        expect(await checkoutHoldingTasks(db, repositoryId)).toBe(1);
        expect(
          await checkoutHoldingTasks(db, repositoryId, { rootOnly: true, excludeTaskId: task!.id }),
        ).toBe(0);
      } finally {
        await db.delete(schema.tasks).where(eq(schema.tasks.id, task!.id));
      }
    },
  );
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  boundedLockWait,
  createDatabase,
  isLockNotAvailable,
  type Database,
  schema,
} from '../src/index.js';
import { checkRevive, lockRepositoryTasksKey } from '../src/repository-task-lock.js';

const url = process.env.REPOSITORY_TASK_LOCK_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/repository_task_lock_test'))
  throw new Error('Use a dedicated repository_task_lock_test database');

describe.skipIf(!url)('Retry waiting behind repository deletion, on Postgres', () => {
  let db: Database;
  let userId: string;
  beforeAll(async () => {
    db = createDatabase(url!);
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'retry-lock',
        emailBlindIndex: 'retry-lock',
        passwordHash: 'x',
        name: 'Retry',
      })
      .returning();
    userId = user!.id;
  });
  afterAll(async () => {
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });
  it.each(['workflow', 'onboarding', 'onboarding_upgrade'])(
    '%s re-reads existence after its wait',
    async (type) => {
      const [repo] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'deleted',
          source: 'git_https',
        })
        .returning();
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: repo!.id,
          type,
          title: 'failed',
          status: 'failed',
        })
        .returning();
      let retry: Promise<unknown> | undefined;
      await db.transaction(async (deleting) => {
        await lockRepositoryTasksKey(deleting, repo!.id);
        retry = db.transaction(async (tx) => {
          const checked = await checkRevive(tx, task!.id);
          if (checked?.refusal) return checked.refusal;
          await tx
            .update(schema.tasks)
            .set({ status: 'running' })
            .where(eq(schema.tasks.id, task!.id));
          return null;
        });
        // Observe the real waiter, not a sleep that merely hopes Retry reached the key.
        let waiting = false;
        for (let i = 0; i < 200; i++) {
          const rows = await db.$client.unsafe(
            "select 1 from pg_stat_activity where datname = current_database() and wait_event = 'advisory'",
          );
          if (rows.length) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await deleting.delete(schema.repositories).where(eq(schema.repositories.id, repo!.id));
      });
      expect(await retry).toEqual({ reason: 'no-repository' });
      const [stored] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task!.id));
      expect(stored).toMatchObject({ status: 'failed', repositoryId: null });
    },
  );
});

describe.skipIf(!url)('lock key spelling, on Postgres', () => {
  let db: Database;
  beforeAll(() => {
    db = createDatabase(url!);
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  const id = randomUUID();
  const waitFor = (spelled: string) =>
    db.transaction((waiter) =>
      boundedLockWait(waiter, () => lockRepositoryTasksKey(waiter, id), 50).then(() => spelled),
    );
  // One representative spelling: the variants are covered by the pure helper's tests
  // (canonical-uuid.test.ts, lock-key-spelling.test.ts).
  it('a holder of a noncanonical spelling excludes a waiter on the canonical id', async () => {
    const spelled = id.replaceAll('-', '').toUpperCase();
    let refused: unknown;
    await db.transaction(async (holder) => {
      await lockRepositoryTasksKey(holder, spelled);
      refused = await waitFor(spelled).catch((err: unknown) => err);
    });
    // The text of a key is not a row: an unfixed key lets the waiter in beside the holder.
    expect(
      isLockNotAvailable(refused),
      `the waiter was not refused beside the holder of ${spelled}: it took its own key`,
    ).toBe(true);
    expect(await waitFor('after')).toBe('after');
  });
  it('a holder of the canonical id excludes a waiter until it commits', async () => {
    let refused: unknown;
    await db.transaction(async (holder) => {
      await lockRepositoryTasksKey(holder, id);
      refused = await waitFor('during').catch((err: unknown) => err);
    });
    expect(isLockNotAvailable(refused)).toBe(true);
    expect(await waitFor('after')).toBe('after');
  });
});

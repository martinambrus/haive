import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { stampRepositoryOnboarded } from '../src/repo/onboarded.js';

type TaskRow = { id: string; type: string; repositoryId: string | null } | undefined;

function makeDb(task: TaskRow): { db: Database; updates: Record<string, unknown>[] } {
  const updates: Record<string, unknown>[] = [];
  const db = {
    query: { tasks: { findFirst: async () => task } },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  } as unknown as Database;
  return { db, updates };
}

describe('stampRepositoryOnboarded', () => {
  it('stamps the repository when an onboarding task completed', async () => {
    const { db, updates } = makeDb({ id: 't1', type: 'onboarding', repositoryId: 'r1' });
    await stampRepositoryOnboarded(db, 't1');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.onboardedAt).toBeInstanceOf(Date);
  });

  it('ignores every other task type', async () => {
    // onboarding_upgrade reconciles template artifacts on an already-onboarded repo; a
    // workflow task says nothing about onboarding at all.
    for (const type of ['workflow', 'onboarding_upgrade', 'run_app', 'plan_build']) {
      const { db, updates } = makeDb({ id: 't1', type, repositoryId: 'r1' });
      await stampRepositoryOnboarded(db, 't1');
      expect(updates, type).toEqual([]);
    }
  });

  it('ignores a task with no repository, and a task that is gone', async () => {
    const noRepo = makeDb({ id: 't1', type: 'onboarding', repositoryId: null });
    await stampRepositoryOnboarded(noRepo.db, 't1');
    expect(noRepo.updates).toEqual([]);

    const missing = makeDb(undefined);
    await stampRepositoryOnboarded(missing.db, 't1');
    expect(missing.updates).toEqual([]);
  });

  it('swallows a database failure — bookkeeping must not break a terminal transition', async () => {
    const db = {
      query: {
        tasks: {
          findFirst: async () => {
            throw new Error('connection lost');
          },
        },
      },
    } as unknown as Database;
    await expect(stampRepositoryOnboarded(db, 't1')).resolves.toBeUndefined();
  });
});

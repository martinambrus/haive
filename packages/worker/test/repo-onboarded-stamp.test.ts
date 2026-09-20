import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { stampRepositoryOnboarded } from '../src/repo/onboarded.js';

/**
 * What is left here is the one contract a fake can still prove.
 *
 * This file used to assert which tasks stamp and which do not, against a hand-rolled `db` whose
 * `update().set().where()` recorded the values. Those assertions are gone rather than repaired:
 * the decision is now a single statement whose WHERE carries the whole rule — the task's type,
 * its `completed` status, and `onboarding_reset_at < tasks.completed_at` — and a fake that
 * answers whatever the shape demands proves only that the shape was copied correctly. Worse, the
 * old fake had no `select`, so once the statement grew its EXISTS subquery every one of those
 * cases threw early and passed by asserting an empty list for the wrong reason.
 *
 * The predicate is covered against a real database in `onboarding-reset-claim-smoke`, where
 * dropping a term actually fails something.
 */
describe('stampRepositoryOnboarded', () => {
  it('swallows a database failure — bookkeeping must not break a terminal transition', async () => {
    const db = {
      select: () => {
        throw new Error('connection lost');
      },
      update: () => {
        throw new Error('connection lost');
      },
    } as unknown as Database;
    await expect(stampRepositoryOnboarded(db, 't1')).resolves.toBeUndefined();
  });
});

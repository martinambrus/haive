import { describe, expect, it } from 'vitest';
import { addRepoJobOrMarkError } from '../src/routes/repos.js';

/**
 * The enqueue half of "a repository cannot strand at `cloning`".
 *
 * The row is committed at `cloning` before the job is added, so a throwing `queue.add` leaves a
 * repository whose job never existed. The worker's boot reconciler cannot cover that in bounded
 * time — it ignores rows younger than its cutoff, because a young row is indistinguishable from
 * one whose enqueue is still in flight — so the failure is closed here, where it happens and
 * where there is no race.
 */

interface RecordedUpdate {
  set: Record<string, unknown>;
}

function makeDb(recorded: RecordedUpdate[], updateThrows = false) {
  return {
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          if (updateThrows) throw new Error('database is down too');
          recorded.push({ set });
        },
      }),
    }),
  } as unknown as Parameters<typeof addRepoJobOrMarkError>[0];
}

describe('addRepoJobOrMarkError', () => {
  it('writes nothing when the enqueue succeeds', async () => {
    const recorded: RecordedUpdate[] = [];

    await addRepoJobOrMarkError(makeDb(recorded), 'repo-1', async () => undefined);

    expect(recorded).toHaveLength(0);
  });

  it('marks the repository error when the enqueue throws, and rethrows', async () => {
    const recorded: RecordedUpdate[] = [];

    await expect(
      addRepoJobOrMarkError(makeDb(recorded), 'repo-1', async () => {
        throw new Error('redis is down');
      }),
      // Rethrown, because the caller's request really did fail and must say so.
    ).rejects.toThrow('redis is down');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.set.status).toBe('error');
    // `error` is the status Retry renders on, so this is what hands the user a way back.
    expect(String(recorded[0]!.set.statusMessage)).toContain('Retry');
  });

  it('still rethrows the ORIGINAL error when the status write fails too', async () => {
    // If the database is unreachable as well there is nothing to be done, and masking the cause
    // with a second error helps nobody diagnosing it.
    const recorded: RecordedUpdate[] = [];

    await expect(
      addRepoJobOrMarkError(makeDb(recorded, true), 'repo-1', async () => {
        throw new Error('redis is down');
      }),
    ).rejects.toThrow('redis is down');

    expect(recorded).toHaveLength(0);
  });
});

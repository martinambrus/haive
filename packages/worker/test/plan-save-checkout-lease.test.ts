import { planCheckoutAccess } from '../src/repo/checkout-access-scope.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireRootClaim } from '@haive/database';
import { cleanup, h, payload, REPO, setup } from './support/plan-mirror-failure.js';
import { save, pull } from '../src/queues/plan-mirror-queue.js';
import type { Database } from '@haive/database';
beforeEach(setup);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it.each([
  ['save', save],
  ['pull', pull],
] as const)('%s excludes a rebuild during consecutive checkout commands', async (_name, run) => {
  let reached = false;
  h.fetch.mockImplementationOnce(async () => {
    reached = true;
    const competing = await acquireRootClaim(h.db as Database, REPO, 'rebuild');
    try {
      expect(competing, 'a rebuild must not claim during plan Git').toBeNull();
    } finally {
      await competing?.release();
    }
    throw new Error('lease checked');
  });
  await expect(run(payload)).rejects.toThrow('lease checked');
  expect(reached).toBe(true);
});

it('retains the Pull lease until a rejected SQL callback finishes its physical work', async () => {
  const db = h.db as Database;
  const transaction = db.transaction.bind(db);
  const atRestore = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const connectionFailed = Promise.withResolvers<never>();
  const driverRejected = Promise.withResolvers<void>();
  let transactions = 0;
  vi.spyOn(db, 'transaction').mockImplementation((work) => {
    const running = transaction(work);
    if (++transactions !== 2) return running;
    return Promise.race([running, connectionFailed.promise]).finally(() =>
      driverRejected.resolve(),
    );
  });
  h.restore.mockImplementationOnce(async () => {
    atRestore.resolve();
    await release.promise;
    return { outcome: 'clean' };
  });
  let finished = false;
  const result = pull(payload)
    .catch((err: unknown) => err)
    .finally(() => {
      finished = true;
    });
  try {
    await atRestore.promise;
    connectionFailed.reject(new Error('connection failed'));
    await driverRejected.promise;
    const rival = await acquireRootClaim(db, REPO, 'rebuild');
    try {
      expect(rival).toBeNull();
    } finally {
      await rival?.release();
    }
    expect(finished).toBe(false);
  } finally {
    release.resolve();
    expect(await result).toMatchObject({ message: 'connection failed' });
  }
});

it('does not report a successful Save after losing its verified mutation capability', async () => {
  h.commit.mockImplementationOnce(async () => {
    const access = planCheckoutAccess();
    if (access.mode !== 'mutation' || !access.owner) throw new Error('missing plan owner');
    await access.owner.release();
    return { committed: true, commitSha: 'saved' };
  });
  await expect(save({ ...payload, push: false })).rejects.toMatchObject({
    code: 'checkout_unavailable',
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Database, RootClaimHandle } from '@haive/database';
import { planCheckoutDatabase, withPlanCheckoutAccess } from '../src/repo/checkout-access-scope.js';

describe('the plan checkout database facade', () => {
  it('passes the transaction config on to the driver', async () => {
    const config = { isolationLevel: 'serializable' } as const;
    const db = { transaction: vi.fn(async (work: (tx: unknown) => unknown) => work({})) };
    const owner = {} as RootClaimHandle;

    await withPlanCheckoutAccess({ mode: 'mutation', owner }, () =>
      planCheckoutDatabase(db as unknown as Database).transaction(async () => undefined, config),
    );

    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), config);
  });

  it('is the database itself outside a mutation', () => {
    const db = {} as Database;
    expect(planCheckoutDatabase(db)).toBe(db);
  });
});

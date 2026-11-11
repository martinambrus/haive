import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { ConfigUnavailableError, configService, logger } from '@haive/shared';

const head = vi.hoisted(() => vi.fn());
vi.mock('../src/repo/checkout-head.js', () => ({ readNamedCheckout: head }));
import { sweepCheckoutRepositories, watchCheckout } from '../src/project-state/watch.js';

const REPO = '00000000-0000-4000-8000-0000000000d1';

function observationDb() {
  head.mockResolvedValue({ ref: 'refs/heads/feature-x', sha: 'a'.repeat(40) });
  const set = vi.fn(() => ({ where: async () => [] }));
  const db = {
    select: () => ({
      from: () => ({
        where: async () => [{ storagePath: '/fixture', localPath: null, status: 'ready' }],
      }),
    }),
    update: () => ({ set }),
  } as unknown as Database;
  return { db, set };
}

/** A database that fails the test on first touch. */
const untouched = () =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`db touched: ${String(prop)}`);
      },
    },
  ) as unknown as Database;

afterEach(() => vi.restoreAllMocks());

describe('the checkout watch when the config store is unavailable', () => {
  it('records the branch before holding record import with a warning', async () => {
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(new ConfigUnavailableError('get'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const { db, set } = observationDb();
    await expect(watchCheckout(db, REPO)).resolves.toBe('held');
    expect(set).toHaveBeenCalledWith({ checkoutBranch: 'feature-x' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(ConfigUnavailableError) }),
      expect.any(String),
    );
  });

  it('queues nothing in a sweep, with a warning and no database read', async () => {
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(new ConfigUnavailableError('get'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const enqueue = vi.fn(async () => undefined);

    await expect(sweepCheckoutRepositories(untouched(), enqueue)).resolves.toBe(0);

    expect(enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(ConfigUnavailableError) }),
      expect.any(String),
    );
  });

  it('still rejects on any other error', async () => {
    const boom = new Error('ConfigService not initialized');
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(boom);
    const { db, set } = observationDb();
    await expect(watchCheckout(db, REPO)).rejects.toBe(boom);
    expect(set).toHaveBeenCalledWith({ checkoutBranch: 'feature-x' });
    await expect(sweepCheckoutRepositories(untouched(), async () => undefined)).rejects.toBe(boom);
  });
});

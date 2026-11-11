import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigUnavailableError, configService, logger } from '@haive/shared';

const h = vi.hoisted(() => ({ add: vi.fn(), wait: vi.fn(), events: {} }));
vi.mock('../src/queues.js', async (load) => ({
  ...(await load<typeof import('../src/queues.js')>()),
  getPlanMirrorQueue: () => ({ add: h.add }),
  getPlanMirrorQueueEvents: () => h.events,
}));
import { enqueueCheckoutSync, observeCheckoutBranchForReset } from '../src/lib/plan-mirror.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000a1';

afterEach(() => {
  vi.restoreAllMocks();
  h.add.mockReset();
  h.wait.mockReset();
  vi.useRealTimers();
});

describe('reset-time branch observation', () => {
  it('waits for a unique observation on every reset, even when record sync is disabled', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    h.add.mockResolvedValue({ waitUntilFinished: h.wait });
    h.wait.mockResolvedValue({ branch: 'main' });

    expect(await observeCheckoutBranchForReset(REPO, USER)).toBe('main');
    expect(await observeCheckoutBranchForReset(REPO, USER)).toBe('main');

    expect(h.add.mock.calls[0]).toEqual([
      'observe-checkout-branch',
      { repositoryId: REPO, userId: USER },
      {
        jobId: expect.stringContaining(`reset-checkout-${REPO}-`),
        removeOnComplete: { age: 300 },
        removeOnFail: { age: 300 },
      },
    ]);
    expect(h.add.mock.calls[0]?.[2].jobId).not.toBe(h.add.mock.calls[1]?.[2].jobId);
    expect(h.wait).toHaveBeenCalledWith(h.events, 5_000);
  });

  it.each(['enqueue', 'worker'] as const)('bounds a stalled %s to five seconds', async (stage) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    h.add.mockImplementation(async () => {
      if (stage === 'enqueue') return new Promise(() => {});
      return { waitUntilFinished: h.wait };
    });
    h.wait.mockImplementation(() => new Promise(() => {}));
    const result = observeCheckoutBranchForReset(REPO, USER);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: REPO }),
      expect.any(String),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true, null])(
    'treats a worker result of %s (cannot observe, or an older worker) as unknown',
    async (result) => {
      h.add.mockResolvedValue({ waitUntilFinished: h.wait });
      h.wait.mockResolvedValue(result);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      expect(await observeCheckoutBranchForReset(REPO, USER)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it('returns a detached checkout as unknown without a warning', async () => {
    h.add.mockResolvedValue({ waitUntilFinished: h.wait });
    h.wait.mockResolvedValue({ branch: null });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(await observeCheckoutBranchForReset(REPO, USER)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('enqueueCheckoutSync', () => {
  it('skips the hint and resolves when the config read rejects', async () => {
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(
      new ConfigUnavailableError('getBoolean', { cause: new Error('ECONNREFUSED') }),
    );
    await expect(enqueueCheckoutSync(REPO, USER)).resolves.toBeUndefined();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('adds nothing when the sync is switched off', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    await enqueueCheckoutSync(REPO, USER);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('adds one job keyed by the repository when the sync is on', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    await enqueueCheckoutSync(REPO, USER);
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.add.mock.calls[0]?.[2]).toMatchObject({ jobId: `checkout-sync-${REPO}` });
  });
});

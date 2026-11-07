import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigUnavailableError, configService } from '@haive/shared';

const h = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('../src/queues.js', async (load) => ({
  ...(await load<typeof import('../src/queues.js')>()),
  getPlanMirrorQueue: () => ({ add: h.add }),
}));
import { enqueueCheckoutSync } from '../src/lib/plan-mirror.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000a1';

afterEach(() => {
  vi.restoreAllMocks();
  h.add.mockReset();
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigUnavailableError, configService } from '@haive/shared';
import type { Database } from '@haive/database';
import { refreshModelPrices } from './model-prices.js';

describe('refreshModelPrices with an unreadable config store', () => {
  afterEach(() => vi.restoreAllMocks());

  it('skips the cycle with a recorded error and touches neither db nor network', async () => {
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(new ConfigUnavailableError('get'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error('db touched');
        },
      },
    ) as unknown as Database;
    const result = await refreshModelPrices(db);
    expect(result.ok).toBe(false);
    expect(result.refreshed).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.name).toBe('price:config');
    expect(result.errors[0]!.error).toContain('Configuration store unavailable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

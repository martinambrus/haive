import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, ConfigService } from '../src/config/config.service.js';

// Key existence is the "never written" marker the one-time upgrade seed reads, so a default
// here would make every boot look like an admin had already saved a list.
describe('the private endpoint allowlist default', () => {
  it('is not seeded, while the other defaults still are', async () => {
    const seeded = new Map<string, string>();
    const svc = new ConfigService() as unknown as { redis: unknown; seedDefaults(): Promise<void> };
    svc.redis = {
      pipeline: () => ({
        setnx: (key: string, value: string) => void seeded.set(key, value),
        exec: async () => [],
      }),
    };
    await svc.seedDefaults();

    expect(seeded.has(CONFIG_KEYS.PRIVATE_ENDPOINT_ALLOWLIST)).toBe(false);
    expect(seeded.get(CONFIG_KEYS.GLOBAL_KB_ENABLED)).toBe('true');
    expect(seeded.get(CONFIG_KEYS.REGISTRATION_MODE)).toBe('closed');
  });
});

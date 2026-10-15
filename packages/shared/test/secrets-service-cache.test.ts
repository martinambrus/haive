import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { encrypt, generateEncryptionKey } from '../src/crypto/index.js';

const h = vi.hoisted(() => ({ key: '' }));

vi.mock('../src/config/config.service.js', () => ({
  configService: { getEncryptionKey: async () => h.key },
}));

import { SecretsService } from '../src/config/secrets.service.js';

describe('SecretsService cache', () => {
  let stored: string | null;
  let reads: number;
  let service: SecretsService;

  beforeEach(async () => {
    vi.useFakeTimers();
    h.key = generateEncryptionKey();
    stored = encrypt('old', h.key);
    reads = 0;
    const db = {
      delete: () => ({
        where: async () => {
          stored = null;
        },
      }),
      query: {
        systemSecrets: {
          findFirst: async () => {
            reads += 1;
            return stored === null ? undefined : { encryptedValue: stored };
          },
        },
      },
    } as unknown as Database;
    service = new SecretsService();
    await service.initialize(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-reads a value changed in the database once 30 s have passed', async () => {
    expect(await service.get('k')).toBe('old');
    stored = encrypt('new', h.key);
    vi.advanceTimersByTime(30_001);
    expect(await service.get('k')).toBe('new');
    expect(reads).toBe(2);
  });

  it('returns the cached value without a database read within 30 s', async () => {
    expect(await service.get('k')).toBe('old');
    stored = encrypt('new', h.key);
    vi.advanceTimersByTime(29_000);
    expect(await service.get('k')).toBe('old');
    expect(reads).toBe(1);
  });

  it('getFresh reads the database inside the window', async () => {
    expect(await service.get('k')).toBe('old');
    stored = encrypt('new', h.key);
    expect(await service.getFresh('k')).toBe('new');
    expect(reads).toBe(2);
  });

  it('forgets a deleted value at once instead of serving it from the cache', async () => {
    expect(await service.get('k')).toBe('old');
    await service.delete('k');
    expect(await service.get('k')).toBeNull();
    expect(reads).toBe(2);
  });

  it('does not cache a missing row', async () => {
    stored = null;
    expect(await service.get('k')).toBeNull();
    stored = encrypt('late', h.key);
    expect(await service.get('k')).toBe('late');
    expect(reads).toBe(2);
  });
});

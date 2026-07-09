import { describe, expect, it, vi } from 'vitest';

// A scan that throws must not degrade to "no masks": that would hand the agent every
// secret the deny-list exists to hide, with a log line as the only trace. Mocked
// because a real I/O fault is not reproducible from a fixture (a missing root returns
// [] rather than throwing).
vi.mock('tinyglobby', () => ({
  glob: () => Promise.reject(new Error('EIO: i/o error, scandir')),
}));

const { computeSecretMasks, SecretMaskError } =
  await import('../src/queues/cli-exec/secret-mask.js');

describe('computeSecretMasks scan failure', () => {
  it('throws SecretMaskError instead of returning an empty mask set', async () => {
    const err = await computeSecretMasks('/some/repo', {}, '/work').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretMaskError);
    expect((err as Error).message).toContain('secret-mask scan of /some/repo failed');
    expect((err as Error).message).toContain('EIO');
  });
});

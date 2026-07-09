import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A scan that throws must not degrade to "no masks": that would hand the agent every
// secret the deny-list exists to hide, with a log line as the only trace. Mocked
// because a real I/O fault is not reproducible from a fixture (glob answers [] for a
// missing root rather than throwing, which is why the root is asserted separately).
vi.mock('tinyglobby', () => ({
  glob: () => Promise.reject(new Error('EIO: i/o error, scandir')),
}));

const { computeSecretMasks, SecretMaskError } =
  await import('../src/queues/cli-exec/secret-mask.js');

// A real directory: the root assertion runs before the glob, so a fake path would fail
// on the wrong branch and never reach the mocked scan.
const root = await mkdtemp(path.join(os.tmpdir(), 'haive-secret-mask-scan-'));

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('computeSecretMasks scan failure', () => {
  it('throws SecretMaskError instead of returning an empty mask set', async () => {
    const err = await computeSecretMasks(root, {}, '/work').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretMaskError);
    expect((err as Error).message).toContain(`secret-mask scan of ${root} failed`);
    expect((err as Error).message).toContain('EIO');
  });

  it('throws SecretMaskError when the root does not exist, without scanning', async () => {
    const err = await computeSecretMasks('/definitely/not/here', {}, '/work').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SecretMaskError);
    expect((err as Error).message).toContain('is not a readable directory');
    // Reached the assertion, not the (mocked, always-throwing) scan.
    expect((err as Error).message).not.toContain('EIO');
  });
});

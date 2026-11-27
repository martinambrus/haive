import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...real, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.inspect }) };
});
import {
  checkoutIdentity,
  runnerCheckoutMatches,
  checkoutMountMatches,
} from '../src/sandbox/checkout-identity.js';
let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('detects a replacement at the same pathname after loss of all in-process mount state', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'checkout-identity-'));
  vi.stubEnv('REPO_STORAGE_ROOT', root);
  await mkdir(path.join(root, 'user/repo'), { recursive: true });
  const old = await checkoutIdentity('user/repo/.haive/worktree');
  h.inspect.mockResolvedValue({ stdout: old });
  expect(await runnerCheckoutMatches('runner', 'user/repo')).toBe(true);
  await rename(path.join(root, 'user/repo'), path.join(root, 'user/aside'));
  await mkdir(path.join(root, 'user/repo'));
  expect(await checkoutIdentity('user/repo')).not.toBe(old);
  expect(await runnerCheckoutMatches('runner', 'user/repo')).toBe(false);
  h.inspect.mockResolvedValue({ stdout: '' });
  expect(await runnerCheckoutMatches('runner', 'user/repo')).toBe(true);
  h.inspect.mockRejectedValue(
    Object.assign(new Error('arbitrary Docker text'), { code: 'ETIMEDOUT' }),
  );
  expect(await runnerCheckoutMatches('runner', 'user/repo')).toBe(true);
  await expect(
    runnerCheckoutMatches('runner', 'user/repo', { onUnknown: 'retry' }),
  ).rejects.toMatchObject({
    name: 'RunnerProbeError',
    retryable: true,
    cause: { code: 'ETIMEDOUT' },
  });
});

it.each([undefined, '', '<no value>'])('always keeps a legacy label %s', async (mounted) => {
  expect(await checkoutMountMatches('user/repo', mounted, '1:2')).toBe(true);
});

it('compares stamped inode only across device remounts', async () => {
  expect(await checkoutMountMatches('user/repo', '999:2', '1:2')).toBe(true);
  expect(await checkoutMountMatches('user/repo', '999:3', '1:2')).toBe(false);
});

it('keeps a legacy scratch shell without consulting repository UUID columns', async () => {
  expect(await checkoutMountMatches('user/_scratch/task', '', '1:2')).toBe(true);
});

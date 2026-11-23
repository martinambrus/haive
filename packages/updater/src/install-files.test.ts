import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inInstall } from './install-files.js';
import { setEnvVar } from './run.js';
import { STACK_LOCK_NAME } from './stack-lock.js';
import { bindStackLease, withStackLease } from './lease-fence.js';
import { UpgradeRefusal } from './refusal.js';

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return { ...real, open: vi.fn(real.open) };
});

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'install-files-'));
  await fs.writeFile(join(dir, '.env'), 'HAIVE_VERSION=1.0.0\n', { mode: 0o600 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const rejectChown = async (code: string) => {
  const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[1] === 'wx')
      vi.spyOn(handle, 'chown').mockRejectedValue(
        Object.assign(new Error('chown refused'), { code }),
      );
    return handle;
  });
};

it('preserves pin writes on shares refusing chown when ownership already matches', async () => {
  await rejectChown('EPERM');
  await setEnvVar(join(dir, '.env'), 'HAIVE_VERSION', '1.1.0');
  expect(await fs.readFile(join(dir, '.env'), 'utf8')).toBe('HAIVE_VERSION=1.1.0\n');
  expect((await fs.stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
});

it.each(['different-owner', 'other-error'])(
  'still fails chown for %s without replacing the pin',
  async (kind) => {
    const owner = await fs.stat(join(dir, '.env'));
    const code = kind === 'different-owner' ? 'EPERM' : 'EIO';
    await rejectChown(code);
    await expect(
      inInstall(dir, (root) =>
        root.atomic('.env', Buffer.from('changed'), {
          ...owner,
          uid: kind === 'different-owner' ? owner.uid + 1 : owner.uid,
        }),
      ),
    ).rejects.toMatchObject({ code });
    expect(await fs.readFile(join(dir, '.env'), 'utf8')).toBe('HAIVE_VERSION=1.0.0\n');
    expect(await fs.readdir(dir)).toEqual(['.env']);
  },
);

it('pins remove exemptions to STACK_LOCK_NAME and its stale tombs only', async () => {
  const exempt = [STACK_LOCK_NAME, `${STACK_LOCK_NAME}.stale.1234abcd`];
  const fenced = [
    `${STACK_LOCK_NAME}.stale`,
    `${STACK_LOCK_NAME}.stale-other`,
    `${STACK_LOCK_NAME}-other`,
  ];
  for (const name of [...exempt, ...fenced]) await fs.writeFile(join(dir, name), 'keep');
  const check = vi.fn(async () => {
    throw new UpgradeRefusal('stack-lock-lost', 'test loss');
  });
  await withStackLease(async () => {
    bindStackLease(check);
    await inInstall(dir, async (root) => {
      for (const name of exempt) await root.remove(name);
      expect(check).not.toHaveBeenCalled();
      for (const name of fenced) {
        await expect(root.remove(name)).rejects.toMatchObject({ refusal: 'stack-lock-lost' });
        expect(await fs.readFile(join(dir, name), 'utf8')).toBe('keep');
      }
    });
  });
  expect(check).toHaveBeenCalledTimes(fenced.length);
  for (const name of exempt)
    await expect(fs.stat(join(dir, name))).rejects.toMatchObject({ code: 'ENOENT' });
});

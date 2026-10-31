import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutMissing } from '../src/repo/checkout-head.js';

describe('checkoutMissing', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'checkout-missing-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is true for a path nothing exists at', async () => {
    expect(await checkoutMissing(join(root, 'gone'))).toBe(true);
  });

  it('is false for an existing directory', async () => {
    expect(await checkoutMissing(root)).toBe(false);
  });

  it('is true for a regular file used as the path', async () => {
    const file = join(root, 'file');
    await writeFile(file, 'not a directory');

    expect(await checkoutMissing(file)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    'rejects with EACCES instead of reading an unreadable parent as a gone checkout',
    async () => {
      const parent = join(root, 'locked');
      const checkout = join(parent, 'checkout');
      await mkdir(checkout, { recursive: true });
      await chmod(parent, 0o000);
      try {
        await expect(checkoutMissing(checkout)).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        await chmod(parent, 0o755);
      }
    },
  );
});

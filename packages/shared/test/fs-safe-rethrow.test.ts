import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ error: new Error() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  open: async () => {
    throw h.error;
  },
}));
import {
  lstatNoFollow,
  openFileNoFollow,
  readFileNoFollow,
  readLinkNoFollow,
  readdirNoFollow,
} from '../src/fs-safe.js';

const reads = [
  (opts = {}) => readLinkNoFollow('/anchor', 'link', opts),
  (opts = {}) => openFileNoFollow('/anchor', 'file', 'read', opts),
  (opts = {}) => readFileNoFollow('/anchor', 'file', opts),
  (opts = {}) => readdirNoFollow('/anchor', 'dir', opts),
  (opts = {}) => lstatNoFollow('/anchor', 'file', opts),
];
afterEach(() => vi.restoreAllMocks());
it.each(reads.map((read, i) => [i, read] as const))(
  'read %s throws only the selected errnos in lenient mode',
  async (_i, read) => {
    for (const code of ['EMFILE', 'ENFILE']) {
      h.error = Object.assign(new Error('injected'), { code });
      await expect(read({ rethrow: new Set(['EMFILE', 'ENFILE']) })).rejects.toBe(h.error);
      await expect(read()).resolves.toBeNull();
    }
    for (const code of ['ENOENT', 'ENOTDIR', 'EACCES']) {
      h.error = Object.assign(new Error('injected'), { code });
      await expect(read({ rethrow: new Set(['EMFILE', 'ENFILE']) })).resolves.toBeNull();
    }
  },
);

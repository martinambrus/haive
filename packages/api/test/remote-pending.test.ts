import { mkdtemp, mkdir, writeFile, symlink, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared';

const h = vi.hoisted(() => ({ db: undefined as unknown, fresh: vi.fn(), git: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db, withFreshDatabase: h.fresh }));
vi.mock('../src/lib/relink-git.js', () => ({
  relinkGit: h.git,
  verifyRelinkCheckout: vi.fn(),
  gitFailureText: () => 'git failed',
}));
import { REMOTE_PENDING_PATH, startRemoteReconcileSweep } from '../src/lib/remote-reconcile.js';

let root: string;
let stop: (() => void) | undefined;
// Advancing a fake timer does not drain real filesystem I/O. The next timer is
// armed only after the whole sweep pass has settled, including its cleanup.
async function pass(ms: number) {
  const schedule = globalThis.setTimeout;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    ...args: Parameters<typeof setTimeout>
  ) => {
    const timer = schedule(...args);
    if (args[1] === 10) finished();
    return timer;
  }) as typeof setTimeout);
  try {
    await vi.advanceTimersByTimeAsync(ms);
    await done;
  } finally {
    spy.mockRestore();
  }
}
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), 'remote-pending-'));
  const fake = createFakeDb({ repositories: schema.repositories });
  const repo = {
    id: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    name: 'pending',
    storagePath: root,
    localPath: null,
    remoteUrl: 'https://saved.test/repo',
  };
  fake.insert(schema.repositories, repo);
  h.db = { query: { repositories: { findMany: vi.fn().mockResolvedValue([repo]) } } };
  h.fresh.mockImplementation((run: (db: unknown) => Promise<unknown>) => run(fake.db));
  h.git.mockResolvedValue({ ok: true, exitedClean: true, code: 0, stdout: '', stderr: '' });
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'info').mockImplementation(() => {});
});
afterEach(async () => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it.each(['pending\n', 'x', '', 'x'.repeat(100)])(
  'settles and removes a regular marker regardless of its bytes (case %#)',
  async (content) => {
    await mkdir(join(root, '.haive'));
    await writeFile(join(root, REMOTE_PENDING_PATH), content);
    vi.useFakeTimers();
    stop = startRemoteReconcileSweep({ intervalMs: 10 });
    await pass(0);
    expect(h.git).toHaveBeenCalledOnce();
    await expect(lstat(join(root, REMOTE_PENDING_PATH))).rejects.toMatchObject({ code: 'ENOENT' });
    await pass(10);
    expect(h.git).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  },
);

it.each(['marker directory', 'marker symlink', 'haive symlink', 'haive file'])(
  'warns once per pass and skips git for %s',
  async (shape) => {
    const target = join(root, 'target');
    await mkdir(target);
    await writeFile(join(target, 'kept'), 'outside marker');
    if (shape === 'haive symlink') await symlink(target, join(root, '.haive'));
    else if (shape === 'haive file') await writeFile(join(root, '.haive'), 'kept');
    else {
      await mkdir(join(root, '.haive'));
      if (shape === 'marker directory') await mkdir(join(root, REMOTE_PENDING_PATH));
      else await symlink(join(target, 'kept'), join(root, REMOTE_PENDING_PATH));
    }
    vi.useFakeTimers();
    stop = startRemoteReconcileSweep({ intervalMs: 10 });
    await pass(0);
    expect(h.git).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await pass(10);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(h.git).not.toHaveBeenCalled();
    expect(await lstat(join(target, 'kept'))).toBeDefined();
  },
);

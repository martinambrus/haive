import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
import { startRemoteReconcileSweep } from '../src/lib/remote-reconcile.js';

let root: string;
let stop: (() => void) | undefined;
let scheduledNextPass: (() => void) | undefined;
const schedule = ((...args: Parameters<typeof setTimeout>) => {
  const timer = setTimeout(...args);
  if (args[1] === 10) scheduledNextPass?.();
  return timer;
}) as typeof setTimeout;
// Advancing a fake timer does not drain real filesystem I/O. The next timer is
// armed only after the whole sweep pass has settled, including its cleanup.
async function pass(ms: number) {
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  scheduledNextPass = finished;
  try {
    await vi.advanceTimersByTimeAsync(ms);
    await done;
  } finally {
    scheduledNextPass = undefined;
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
    remoteUrl: null,
    remoteRelinkIntent: null,
  };
  fake.insert(schema.repositories, repo);
  h.db = fake.db;
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

it('ignores a sandbox-planted marker without database intent during a sweep', async () => {
  await mkdir(join(root, '.haive'));
  await writeFile(join(root, '.haive/remote-relink-pending'), 'pending\n');
  vi.useFakeTimers();
  stop = startRemoteReconcileSweep({ intervalMs: 10, schedule });
  await pass(0);
  expect(h.git).not.toHaveBeenCalled();
  expect(h.fresh).not.toHaveBeenCalled();
});

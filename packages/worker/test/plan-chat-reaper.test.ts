import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ remove: vi.fn(), error: vi.fn() }));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  removeNoFollow: mocks.remove,
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  logger: { child: () => ({ error: mocks.error }) },
}));
import { createPlanChatSnapshot, reapPlanChatSnapshots } from '../src/plan/chat-snapshot.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

it('treats a missing snapshot directory on a fresh volume as a no-op', async () => {
  root = await mkdtemp(join(tmpdir(), 'snapshot-reap-'));
  await expect(reapPlanChatSnapshots(root)).resolves.toBeUndefined();
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(mocks.error).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

it('logs a failed entry and still removes the next snapshot', async () => {
  root = await mkdtemp(join(tmpdir(), 'snapshot-reap-'));
  await createPlanChatSnapshot(root, {} as never);
  await createPlanChatSnapshot(root, {} as never);
  const error = new Error('EIO');
  const fs = await vi.importActual<typeof import('@haive/shared/fs-safe')>('@haive/shared/fs-safe');
  mocks.remove.mockRejectedValueOnce(error).mockImplementation(fs.removeNoFollow);
  await expect(reapPlanChatSnapshots(root)).resolves.toBeUndefined();
  expect(mocks.remove).toHaveBeenCalledTimes(2);
  expect(await readdir(join(root, 'plan-chat-snapshots'))).toHaveLength(1);
  expect(mocks.error).toHaveBeenCalledWith(
    expect.objectContaining({ err: error }),
    expect.stringContaining('snapshot'),
  );
});

it('keeps the actual worker boot await non-fatal even if listing rejects', async () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('await reapPlanChatSnapshots(');
  const end = source.indexOf('// Reap CLI auth volumes', start);
  expect(start).toBeGreaterThan(source.indexOf("await reapAllCliSandboxes('worker boot')"));
  const statement = source.slice(start, end);
  const logger = { error: vi.fn() };
  const err = new Error('unreadable volume');
  const execute = new Function(
    'reapPlanChatSnapshots',
    'logger',
    `return (async () => { ${statement} })()`,
  );
  await expect(execute(vi.fn().mockRejectedValue(err), logger)).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith({ err }, expect.stringContaining('snapshot'));
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { run, listing, stat } = vi.hoisted(() => ({
  run: vi.fn(),
  listing: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: run }) };
});
vi.mock('@haive/shared/fs-safe', async () => ({
  ...(await vi.importActual<typeof import('@haive/shared/fs-safe')>('@haive/shared/fs-safe')),
  readdirNoFollow: listing,
  lstatNoFollow: stat,
}));

import { restoreLatestSnapshot } from './ddev-runner.js';

const handle = { container: 'runner', projectDir: '/repos/user/project' };
const config = (yaml: string) => '# Complete processed project configuration:\n' + yaml;
beforeEach(() => {
  vi.clearAllMocks();
  listing.mockResolvedValue([{ name: 'haive-import-task-postgres_17.zst' }]);
  stat.mockResolvedValue({ kind: 'file', stats: { mtimeMs: 1 } });
});

describe('database restoration after no-DB access replacement and later cold recovery', () => {
  it('does not inspect or restore old backups for an explicitly database-free replacement', async () => {
    await restoreLatestSnapshot(handle, 'task', null);
    expect(run).not.toHaveBeenCalled();
    expect(listing).not.toHaveBeenCalled();
  });

  it('ignores retained snapshots on later cold boots when the merged config omits db', async () => {
    run.mockResolvedValue({ stdout: config('omit_containers: [db]\n'), stderr: '' });
    await restoreLatestSnapshot(handle, 'task');
    expect(run).toHaveBeenCalledTimes(1);
    expect(listing).not.toHaveBeenCalled();
  });

  it('restores a retained snapshot for a configured database', async () => {
    run.mockImplementation(async (_bin: string, args: string[]) => ({
      stdout: args.at(-1)?.includes('configyaml') ? config('omit_containers: []\n') : '',
      stderr: '',
    }));
    await restoreLatestSnapshot(handle, 'task');
    expect(listing).toHaveBeenCalled();
    expect(run).toHaveBeenLastCalledWith(
      'docker',
      expect.arrayContaining([expect.stringContaining('ddev snapshot restore haive-import-task')]),
      expect.anything(),
    );
  });

  it('does not let unreadable configuration waive restoring the exact access snapshot', async () => {
    run.mockImplementation(async (_bin: string, args: string[]) => {
      if (args.at(-1)?.includes('configyaml'))
        throw Object.assign(new Error('failed'), { code: 1 });
      return { stdout: '', stderr: '' };
    });
    await restoreLatestSnapshot(handle, 'task', 'haive-access-task-1');
    expect(listing).not.toHaveBeenCalled();
    expect(run).toHaveBeenLastCalledWith(
      'docker',
      expect.arrayContaining([
        expect.stringContaining('ddev snapshot restore haive-access-task-1'),
      ]),
      expect.anything(),
    );
  });
});

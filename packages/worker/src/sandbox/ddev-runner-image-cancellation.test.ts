import { beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: run });
  return { ...actual, execFile };
});

import { ensureDdevRunnerImage, readDdevPublishedPorts } from './ddev-runner.js';
import { DdevBootAbortedError, withDdevBootCancellation } from './ddev-boot-cancellation.js';

beforeEach(() => {
  run.mockReset();
});

describe('DDEV port-label inspection', () => {
  it('distinguishes unpublished ports from a failed inspection during reconciliation', async () => {
    run.mockResolvedValue({ stdout: '<no value>,<no value>\n', stderr: '' });
    await expect(readDdevPublishedPorts('runner', { strict: true })).resolves.toBeNull();
    run.mockRejectedValue(new Error('docker inspect timed out'));
    await expect(readDdevPublishedPorts('runner', { strict: true })).rejects.toThrow(
      'Cannot inspect DDEV published ports',
    );
    await expect(readDdevPublishedPorts('runner')).resolves.toBeNull();
  });

  it('reads valid ports and rejects partial or malformed labels in strict mode', async () => {
    run.mockResolvedValue({ stdout: '56001,56002\n', stderr: '' });
    await expect(readDdevPublishedPorts('runner', { strict: true })).resolves.toEqual({
      https: 56001,
      http: 56002,
    });
    for (const stdout of ['56001,<no value>', 'broken,56002', '56001,99999']) {
      run.mockResolvedValue({ stdout, stderr: '' });
      await expect(readDdevPublishedPorts('runner', { strict: true })).rejects.toThrow(
        'Cannot inspect DDEV published ports',
      );
    }
  });
});

describe('DDEV runner image cancellation', () => {
  it('aborts the image build before a container exists instead of waiting for its timeout', async () => {
    const stop = new AbortController();
    let building!: () => void;
    const started = new Promise<void>((resolve) => {
      building = resolve;
    });
    run.mockImplementation(
      async (_command: string, args: string[], opts: { signal?: AbortSignal }) => {
        if (args[0] === 'image') throw new Error('image absent');
        if (args[0] !== 'build') throw new Error(`unexpected docker command ${args[0]}`);
        return new Promise((_, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('build aborted')), {
            once: true,
          });
          building();
        });
      },
    );
    const remove = vi.fn(async () => {});
    const boot = withDdevBootCancellation(stop.signal, remove, async (scope) => {
      await ensureDdevRunnerImage(scope.signal);
      scope.created('should-never-be-created');
    });
    const error = boot.catch((err: unknown) => err);
    await started;
    stop.abort();
    expect(await error).toBeInstanceOf(DdevBootAbortedError);
    expect(run).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['build']),
      expect.objectContaining({ signal: stop.signal }),
    );
    expect(remove).not.toHaveBeenCalled();
  });
});

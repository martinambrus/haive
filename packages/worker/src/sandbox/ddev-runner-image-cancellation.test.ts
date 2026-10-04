import { describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: run });
  return { ...actual, execFile };
});

import { ensureDdevRunnerImage } from './ddev-runner.js';
import { DdevBootAbortedError, withDdevBootCancellation } from './ddev-boot-cancellation.js';

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

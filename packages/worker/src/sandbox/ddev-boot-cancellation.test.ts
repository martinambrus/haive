import { describe, expect, it, vi } from 'vitest';
import {
  DdevBootAbortedError,
  DdevBoots,
  withDdevBootCancellation,
} from './ddev-boot-cancellation.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('DDEV cold-boot cancellation', () => {
  it('removes the created runner during startup and holds Retry until teardown completes', async () => {
    const stop = new AbortController();
    const created = deferred();
    const command = deferred();
    const teardown = deferred();
    const remove = vi.fn(async () => {
      command.reject(new Error('docker exec closed because its runner was removed'));
      await teardown.promise;
    });
    const boots = new DdevBoots<string>();
    const old = boots.ensure('task', stop.signal, () =>
      withDdevBootCancellation(stop.signal, remove, async (scope) => {
        scope.created('old-container-id');
        created.resolve();
        await command.promise;
        return 'vnc';
      }),
    );
    const oldError = old.catch((err: unknown) => err);
    await created.promise;
    stop.abort();
    expect(remove).toHaveBeenCalledExactlyOnceWith('old-container-id');
    const replacement = vi.fn(async () => 'direct');
    const retry = boots.ensure('task', undefined, replacement);
    await Promise.resolve();
    expect(replacement).not.toHaveBeenCalled();
    teardown.resolve();
    expect(await oldError).toBeInstanceOf(DdevBootAbortedError);
    await expect(retry).resolves.toBe('direct');
    expect(replacement).toHaveBeenCalledOnce();
    // An old signal fired again cannot delete the replacement.
    stop.abort();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('cleans up when Stop lands while docker run is creating the container', async () => {
    const stop = new AbortController();
    const creating = deferred();
    const remove = vi.fn(async () => {});
    const boot = withDdevBootCancellation(stop.signal, remove, async (scope) => {
      await creating.promise;
      scope.created('late-container-id');
      scope.throwIfAborted();
    });
    const error = boot.catch((err: unknown) => err);
    stop.abort();
    expect(remove).not.toHaveBeenCalled();
    creating.resolve();
    expect(await error).toBeInstanceOf(DdevBootAbortedError);
    expect(remove).toHaveBeenCalledExactlyOnceWith('late-container-id');
  });

  it('stops before any runner is created when already aborted', async () => {
    const stop = new AbortController();
    stop.abort();
    const run = vi.fn(async () => 'handle');
    const remove = vi.fn(async () => {});
    await expect(withDdevBootCancellation(stop.signal, remove, run)).rejects.toBeInstanceOf(
      DdevBootAbortedError,
    );
    expect(run).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('preserves a pre-existing runtime and its database on Stop', async () => {
    const stop = new AbortController();
    const remove = vi.fn(async () => {});
    await expect(
      withDdevBootCancellation(stop.signal, remove, async () => {
        stop.abort();
        return 'existing-runtime';
      }),
    ).rejects.toBeInstanceOf(DdevBootAbortedError);
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not keep an abort listener on a completed boot', async () => {
    const stop = new AbortController();
    const remove = vi.fn(async () => {});
    await expect(
      withDdevBootCancellation(stop.signal, remove, async (scope) => {
        scope.created('ready-container');
        return 'ready';
      }),
    ).resolves.toBe('ready');
    stop.abort();
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not rerun a boot when cleanup failed', async () => {
    const stop = new AbortController();
    const boom = new Error('daemon refused to remove the runner');
    const boots = new DdevBoots<string>();
    const old = boots.ensure('task', stop.signal, () =>
      withDdevBootCancellation(
        stop.signal,
        async () => {
          throw boom;
        },
        async (scope) => {
          scope.created('old-container');
          stop.abort();
          scope.throwIfAborted();
          return 'old';
        },
      ),
    );
    const retryBoot = vi.fn(async () => 'new');
    const retry = boots.ensure('task', undefined, retryBoot);
    await expect(old).rejects.toBe(boom);
    await expect(retry).rejects.toBe(boom);
    expect(retryBoot).not.toHaveBeenCalled();
  });

  it('coalesces successful boots without restarting the runner', async () => {
    const finish = deferred<string>();
    const boots = new DdevBoots<string>();
    const first = boots.ensure('task', undefined, () => finish.promise);
    const other = vi.fn(async () => 'duplicate');
    const second = boots.ensure('task', undefined, other);
    finish.resolve('ready');
    await expect(first).resolves.toBe('ready');
    await expect(second).resolves.toBe('ready');
    expect(other).not.toHaveBeenCalled();
  });
});

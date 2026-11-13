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
  it('makes a caller for another subpath wait out the boot and then boot its own', async () => {
    const boots = new DdevBoots<string>();
    const first = deferred<string>();
    const a = boots.ensure('task', undefined, () => first.promise, 'ws/a');
    const own = vi.fn(async () => 'b');
    const b = boots.ensure('task', undefined, own, 'ws/b');
    await Promise.resolve();
    expect(own).not.toHaveBeenCalled();
    first.resolve('a');
    await expect(a).resolves.toBe('a');
    await expect(b).resolves.toBe('b');
    expect(own).toHaveBeenCalledOnce();
  });

  it('hands a caller for another subpath the boot failure instead of booting over it', async () => {
    const boots = new DdevBoots<string>();
    const first = deferred<string>();
    const a = boots.ensure('task', undefined, () => first.promise, 'ws/a');
    const aError = a.catch((err: unknown) => err);
    const own = vi.fn(async () => 'b');
    const b = boots.ensure('task', undefined, own, 'ws/b');
    const failure = new Error('removing the incomplete runner failed');
    first.reject(failure);
    expect(await aError).toBe(failure);
    await expect(b).rejects.toBe(failure);
    expect(own).not.toHaveBeenCalled();
  });

  it('boots its own for a caller for another subpath once that boot was stopped', async () => {
    const boots = new DdevBoots<string>();
    const first = deferred<string>();
    const a = boots.ensure('task', undefined, () => first.promise, 'ws/a');
    const aError = a.catch((err: unknown) => err);
    const own = vi.fn(async () => 'b');
    const b = boots.ensure('task', undefined, own, 'ws/b');
    first.reject(new DdevBootAbortedError());
    expect(await aError).toBeInstanceOf(DdevBootAbortedError);
    await expect(b).resolves.toBe('b');
  });

  it('lets a caller waiting for another subpath stop on its own signal without stopping the boot', async () => {
    const boots = new DdevBoots<string>();
    const first = deferred<string>();
    const bootSignal: AbortSignal[] = [];
    const a = boots.ensure(
      'task',
      undefined,
      (signal) => {
        bootSignal.push(signal);
        return first.promise;
      },
      'ws/a',
    );
    const stop = new AbortController();
    const own = vi.fn(async () => 'b');
    const b = boots.ensure('task', stop.signal, own, 'ws/b');
    const bError = b.catch((err: unknown) => err);
    await Promise.resolve();
    stop.abort();
    expect(await bError).toBeInstanceOf(DdevBootAbortedError);
    expect(bootSignal[0]!.aborted).toBe(false);
    first.resolve('a');
    await expect(a).resolves.toBe('a');
    expect(own).not.toHaveBeenCalled();
  });

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
    const old = boots.ensure('task', stop.signal, (signal) =>
      withDdevBootCancellation(signal, remove, async (scope) => {
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

  it('lets a coalesced step stop a cold boot initiated by a signal-less runtime job', async () => {
    const stop = new AbortController();
    const created = deferred();
    const command = deferred();
    const teardown = deferred();
    const remove = vi.fn(async () => {
      command.reject(new Error('runner removed'));
      await teardown.promise;
    });
    const boots = new DdevBoots<string>();
    const runtime = boots.ensure('task', undefined, (signal) =>
      withDdevBootCancellation(signal, remove, async (scope) => {
        scope.created('runtime-owned-runner');
        created.resolve();
        await command.promise;
        return 'vnc';
      }),
    );
    const runtimeError = runtime.catch((err: unknown) => err);
    await created.promise;
    const duplicate = vi.fn(async () => 'duplicate');
    const step = boots.ensure('task', stop.signal, duplicate);
    const stepError = step.catch((err: unknown) => err);
    stop.abort();
    expect(remove).toHaveBeenCalledExactlyOnceWith('runtime-owned-runner');
    const replacement = vi.fn(async () => 'direct');
    const retry = boots.ensure('task', undefined, replacement);
    expect(replacement).not.toHaveBeenCalled();
    teardown.resolve();
    expect(await runtimeError).toBeInstanceOf(DdevBootAbortedError);
    expect(await stepError).toBeInstanceOf(DdevBootAbortedError);
    await expect(retry).resolves.toBe('direct');
    expect(replacement).toHaveBeenCalledOnce();
    expect(duplicate).not.toHaveBeenCalled();
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

  it('removes a runner after restore failure before Retry can reuse its empty database', async () => {
    const failure = new Error('access snapshot restore failed');
    const restore = deferred();
    const teardown = deferred();
    const removing = deferred();
    const remove = vi.fn(async () => {
      removing.resolve();
      await teardown.promise;
    });
    const boots = new DdevBoots<string>();
    const old = boots.ensure('task', undefined, () =>
      withDdevBootCancellation(undefined, remove, async (scope) => {
        scope.created('empty-db-runner');
        await restore.promise;
        throw failure;
      }),
    );
    const error = old.catch((err: unknown) => err);
    restore.resolve();
    await removing.promise;
    expect(remove).toHaveBeenCalledExactlyOnceWith('empty-db-runner');
    const replacement = vi.fn(async () => 'restored-db-runner');
    const waiting = boots.ensure('task', undefined, replacement);
    const waitingError = waiting.catch((err: unknown) => err);
    expect(replacement).not.toHaveBeenCalled();
    teardown.resolve();
    expect(await error).toBe(failure);
    expect(await waitingError).toBe(failure);
    await expect(boots.ensure('task', undefined, replacement)).resolves.toBe('restored-db-runner');
    expect(replacement).toHaveBeenCalledOnce();
  });

  it('preserves a pre-existing runtime when bring-up fails', async () => {
    const failure = new Error('live database snapshot failed');
    const remove = vi.fn(async () => {});
    await expect(
      withDdevBootCancellation(undefined, remove, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(remove).not.toHaveBeenCalled();
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

describe('exclusive DDEV lifecycle operations', () => {
  it('waits for an existing boot and holds later ensures until rebuild finishes', async () => {
    const boots = new DdevBoots<string>();
    let endBoot!: (value: string) => void;
    let endRebuild!: (value: string) => void;
    let rebuildStarted!: () => void;
    const rebuilding = new Promise<void>((resolve) => {
      rebuildStarted = resolve;
    });
    const original = boots.ensure(
      'task',
      undefined,
      () =>
        new Promise<string>((resolve) => {
          endBoot = resolve;
        }),
      'workspace',
    );
    await Promise.resolve();
    const rebuild = vi.fn(() => {
      rebuildStarted();
      return new Promise<string>((resolve) => {
        endRebuild = resolve;
      });
    });
    const exclusive = boots.exclusive('task', rebuild);
    expect(rebuild).not.toHaveBeenCalled();
    endBoot('old');
    await original;
    await rebuilding;
    const fresh = vi.fn(async () => 'new');
    const later = boots.ensure('task', undefined, fresh, 'workspace');
    expect(fresh).not.toHaveBeenCalled();
    endRebuild('removed');
    await expect(exclusive).resolves.toBe('removed');
    await expect(later).resolves.toBe('new');
  });
  it('allows an explicit rebuild after the warm boot it waited for fails', async () => {
    const boots = new DdevBoots<string>();
    let fail!: (error: Error) => void;
    const original = boots.ensure(
      'task',
      undefined,
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
      'workspace',
    );
    const observed = expect(original).rejects.toThrow('warm start failed');
    await Promise.resolve();
    const rebuild = boots.exclusive('task', async () => 'removed');
    fail(new Error('warm start failed'));
    await observed;
    await expect(rebuild).resolves.toBe('removed');
  });
});

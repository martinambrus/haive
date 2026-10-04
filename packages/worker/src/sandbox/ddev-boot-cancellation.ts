export class DdevBootAbortedError extends Error {
  constructor() {
    super('DDEV startup was stopped');
    this.name = 'DdevBootAbortedError';
  }
}

export interface DdevBootScope {
  throwIfAborted(): void;
  /** The immutable ID returned by docker run, never the reusable task container name. */
  created(containerId: string): void;
}

/** A caller at a newer epoch waits out the old boot's teardown and then gets its own boot.
 * Successful concurrent ensures still share one runner, as the runtime/VNC paths require. */
export class DdevBoots<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  async ensure(
    taskId: string,
    signal: AbortSignal | undefined,
    boot: () => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new DdevBootAbortedError();
    const existing = this.inFlight.get(taskId);
    if (existing) {
      try {
        const result = await existing;
        if (signal?.aborted) throw new DdevBootAbortedError();
        return result;
      } catch (err) {
        if (!(err instanceof DdevBootAbortedError) || signal?.aborted) throw err;
        return this.ensure(taskId, signal, boot);
      }
    }
    const running = boot();
    this.inFlight.set(taskId, running);
    try {
      return await running;
    } finally {
      this.inFlight.delete(taskId);
    }
  }
}

/** An interrupted cold boot owns its new runner until bring-up (including wiring) ends.
 * Remove it on abort to terminate nested builds too: killing the docker exec client alone
 * leaves its process running inside the container. A pre-existing runtime is not owned here,
 * since Stop must preserve its imported database. Failed bring-up also removes its new
 * runner so Retry cannot reuse a serving runtime whose database restore failed.
 * Await teardown before releasing the boot. */
export async function withDdevBootCancellation<T>(
  signal: AbortSignal | undefined,
  remove: (containerId: string) => Promise<void>,
  run: (scope: DdevBootScope) => Promise<T>,
): Promise<T> {
  let containerId: string | null = null;
  let teardown: Promise<void> | null = null;
  const removeOwnedRunner = (): void => {
    if (!containerId || teardown) return;
    teardown = remove(containerId);
    // The operation unwinds when removal closes docker exec. Observe this promise now,
    // then await it below, so a teardown failure cannot become an unhandled rejection.
    void teardown.catch(() => {});
  };
  const scope: DdevBootScope = {
    throwIfAborted() {
      if (signal?.aborted) throw new DdevBootAbortedError();
    },
    created(id) {
      containerId = id;
      if (signal?.aborted) removeOwnedRunner();
    },
  };
  signal?.addEventListener('abort', removeOwnedRunner, { once: true });
  try {
    scope.throwIfAborted();
    const result = await run(scope);
    scope.throwIfAborted();
    return result;
  } catch (err) {
    removeOwnedRunner();
    if (teardown) await teardown;
    if (signal?.aborted) throw new DdevBootAbortedError();
    throw err;
  } finally {
    signal?.removeEventListener('abort', removeOwnedRunner);
  }
}

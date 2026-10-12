import type * as RagModule from '@haive/shared/rag';

export interface FakeLockHandle {
  lost: boolean;
  released: number;
  release(): Promise<void>;
}

export interface FakeLockOptions {
  waitMs?: number;
  signal?: AbortSignal;
  onWait?: () => void;
}

/** An in-memory stand-in for the Redis lock: one holder per repository, the others wait. */
export function createFakeRagLock(actual: typeof RagModule) {
  const state = {
    held: new Set<string>(),
    tried: [] as Array<{ repositoryId: string; options: FakeLockOptions | undefined }>,
    handles: [] as FakeLockHandle[],
    timeoutNow: false,
    redisDown: false,
    loseOnTake: false,
  };
  const take = (repositoryId: string): FakeLockHandle => {
    state.held.add(repositoryId);
    const handle: FakeLockHandle = {
      lost: state.loseOnTake,
      released: 0,
      release: async () => {
        handle.released += 1;
        if (handle.released === 1) state.held.delete(repositoryId);
      },
    };
    state.handles.push(handle);
    return handle;
  };
  return {
    state,
    reset() {
      state.held.clear();
      state.tried.length = 0;
      state.handles.length = 0;
      state.timeoutNow = false;
      state.redisDown = false;
      state.loseOnTake = false;
    },
    acquireRagSyncLock: async (
      _redis: unknown,
      repositoryId: string,
      options?: FakeLockOptions,
    ): Promise<FakeLockHandle> => {
      state.tried.push({ repositoryId, options });
      while (state.held.has(repositoryId)) {
        if (options?.signal?.aborted) throw new actual.RagSyncLockAbortedError();
        if (state.timeoutNow) throw new actual.RagSyncLockTimeoutError(options?.waitMs ?? 0);
        options?.onWait?.();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return take(repositoryId);
    },
    tryAcquireRagSyncLock: async (
      _redis: unknown,
      repositoryId: string,
    ): Promise<FakeLockHandle | null> => {
      state.tried.push({ repositoryId, options: undefined });
      if (state.redisDown) throw new Error('connect ECONNREFUSED');
      return state.held.has(repositoryId) ? null : take(repositoryId);
    },
  };
}

import { afterEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type Docker from 'dockerode';
import type { Redis } from 'ioredis';
import { cleanupAuthAfterTerminalSummary } from '../src/queues/cli-exec/handlers.js';
import { reapAllSessionsForTask } from '../src/sandbox/terminal-session-reaper.js';
import { unloadTaskOllamaCliModels } from '../src/sandbox/ollama-provision.js';
import {
  cleanupTaskAuthVolumes,
  findTaskAuthVolumes,
  clearTaskAuthPreparationState,
  syncRefreshedAuthToUserVolumes,
} from '../src/sandbox/task-auth-volume.js';

vi.mock('../src/sandbox/task-auth-volume.js', async (original) => ({
  ...(await original<object>()),
  findTaskAuthVolumes: vi.fn(async () => []),
  cleanupTaskAuthVolumes: vi.fn(async () => ({ removed: [], failed: [] })),
  clearTaskAuthPreparationState: vi.fn(),
  syncRefreshedAuthToUserVolumes: vi.fn(async () => ({ retainTaskCopy: false })),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const TASK = '00000000-0000-4000-8000-000000000001';
function taskDb() {
  const fake = createFakeDb({ tasks: schema.tasks }, { rowLocks: true });
  fake.insert(schema.tasks, { id: TASK, status: 'failed', orchestrationEpoch: 1 });
  const revive = () => {
    fake.patch(schema.tasks, TASK, { status: 'running', orchestrationEpoch: 2 });
  };
  return { fake, db: fake.db as unknown as Database, revive };
}

it('summary cleanup preserves preparations and auth volumes when Retry wins during sync', async () => {
  const { db, revive } = taskDb();
  vi.mocked(syncRefreshedAuthToUserVolumes).mockImplementationOnce(async () => {
    revive();
    return { retainTaskCopy: false };
  });
  await cleanupAuthAfterTerminalSummary(db, TASK);
  expect(cleanupTaskAuthVolumes).not.toHaveBeenCalled();
  expect(clearTaskAuthPreparationState).not.toHaveBeenCalled();
});

it('terminal cleanup preserves a shell when Retry wins while reading its registry entry', async () => {
  const { db, revive } = taskDb();
  const remove = vi.fn(async () => undefined);
  const del = vi.fn();
  const redis = {
    scan: async () => ['0', ['session']],
    hgetall: async () => {
      revive();
      return { containerName: 'revived-shell' };
    },
    del,
  } as unknown as Redis;
  const docker = { getContainer: () => ({ remove }) } as unknown as Docker;
  await reapAllSessionsForTask(redis, docker, TASK, db);
  expect(remove).not.toHaveBeenCalled();
  expect(del).not.toHaveBeenCalled();
});

function withModels(db: Database, onModels: () => void = () => {}) {
  const decorate = (handle: Database): Database => {
    const select = handle.select.bind(handle);
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === 'transaction')
          return (fn: (tx: Database) => Promise<unknown>) =>
            target.transaction((tx) => fn(decorate(tx as unknown as Database)));
        if (prop !== 'select') return Reflect.get(target, prop);
        return (fields: { model?: unknown }) => ({
          from: (table: unknown) => {
            if (table === schema.tasks) return select(fields as never).from(schema.tasks);
            if (fields.model)
              return {
                innerJoin: () => ({
                  where: async () => {
                    onModels();
                    return [{ model: 'qwen:4b', envVars: null }];
                  },
                }),
              };
            return {
              innerJoin: () => ({
                innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
              }),
            };
          },
        });
      },
    });
  };
  return decorate(db);
}

it('CLI model cleanup keeps the model when Retry wins after the model lookup', async () => {
  const { db, revive } = taskDb();
  const fetch = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  await unloadTaskOllamaCliModels(withModels(db, revive), TASK);
  expect(fetch).not.toHaveBeenCalled();
});

it('summary cleanup holds the task row and forwards a signal aborted after settlement', async () => {
  const { db, fake } = taskDb();
  let locked = false;
  let abortedDuringCleanup: boolean | undefined;
  vi.mocked(cleanupTaskAuthVolumes).mockImplementationOnce(
    async (_taskId, _provider, _volumes, signal) => {
      abortedDuringCleanup = signal?.aborted;
      locked = fake.rowLocked(schema.tasks, TASK);
      return { removed: ['volume'], failed: [] };
    },
  );
  await cleanupAuthAfterTerminalSummary(db, TASK);
  expect(locked).toBe(true);
  expect(cleanupTaskAuthVolumes).toHaveBeenCalledOnce();
  expect(cleanupTaskAuthVolumes).toHaveBeenCalledWith(TASK, undefined, [], expect.any(AbortSignal));
  expect(abortedDuringCleanup).toBe(false);
  expect(vi.mocked(cleanupTaskAuthVolumes).mock.calls[0]?.[3]?.aborted).toBe(true);
  expect(clearTaskAuthPreparationState).toHaveBeenCalledOnce();
  expect(fake.rowLocked(schema.tasks, TASK)).toBe(false);
});

it('terminal cleanup removes ended-task shells while holding the task row', async () => {
  const { db, fake } = taskDb();
  const held: boolean[] = [];
  const remove = vi.fn(async () => {
    held.push(fake.rowLocked(schema.tasks, TASK));
  });
  const del = vi.fn(async () => {
    held.push(fake.rowLocked(schema.tasks, TASK));
  });
  const redis = {
    scan: async () => ['0', ['session']],
    hgetall: async () => ({ containerName: 'shell' }),
    del,
  } as unknown as Redis;
  const docker = { getContainer: () => ({ remove }) } as unknown as Docker;
  expect(await reapAllSessionsForTask(redis, docker, TASK, db)).toBe(1);
  expect(held).toEqual([true, true]);
  expect(remove).toHaveBeenCalledOnce();
  expect(del).toHaveBeenCalledOnce();
});

it('CLI model cleanup unloads an unused ended-task model while holding the task row', async () => {
  const { db, fake } = taskDb();
  let locked = false;
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    locked = fake.rowLocked(schema.tasks, TASK);
    return { ok: true };
  });
  vi.stubGlobal('fetch', fetch);
  await unloadTaskOllamaCliModels(withModels(db), TASK);
  expect(locked).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]![1]!.signal?.aborted).toBe(true);
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
    model: 'qwen:4b',
    keep_alive: 0,
  });
});

it('summary probes volumes outside the row lock and rechecks before removal', async () => {
  const { db, fake, revive } = taskDb();
  vi.mocked(findTaskAuthVolumes).mockImplementationOnce(async () => {
    expect(fake.rowLocked(schema.tasks, TASK)).toBe(false);
    revive();
    return ['volume'];
  });
  await cleanupAuthAfterTerminalSummary(db, TASK);
  expect(findTaskAuthVolumes).toHaveBeenCalledOnce();
  expect(cleanupTaskAuthVolumes).not.toHaveBeenCalled();
});

it.each(['summary', 'terminal', 'ollama'] as const)(
  '%s installs its production settlement bound before the locking select',
  async (site) => {
    const { recordSettlementBounds } = await import('./helpers/settlement-bound.js');
    const { db: base } = taskDb();
    const { db, sections } = recordSettlementBounds(site === 'ollama' ? withModels(base) : base);
    if (site === 'summary') await cleanupAuthAfterTerminalSummary(db, TASK);
    if (site === 'terminal') {
      const redis = {
        scan: async () => ['0', ['session']],
        hgetall: async () => ({ containerName: 'shell' }),
        del: async () => 1,
      } as unknown as Redis;
      const docker = {
        getContainer: () => ({ remove: async () => undefined }),
      } as unknown as Docker;
      await reapAllSessionsForTask(redis, docker, TASK, db);
    }
    if (site === 'ollama') {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true })),
      );
      await unloadTaskOllamaCliModels(db, TASK);
    }
    expect(sections).toHaveLength(1);
    expect(sections[0]?.slice(0, 3)).toEqual([
      "SET LOCAL transaction_timeout = '60000ms'",
      'select',
      'for no key update',
    ]);
  },
);

it('summary retains auth volumes and preparations when credential reads need retry', async () => {
  const { db } = taskDb();
  vi.mocked(syncRefreshedAuthToUserVolumes).mockResolvedValueOnce({ retainTaskCopy: true });
  await cleanupAuthAfterTerminalSummary(db, TASK);
  expect(cleanupTaskAuthVolumes).not.toHaveBeenCalled();
  expect(clearTaskAuthPreparationState).not.toHaveBeenCalled();
});

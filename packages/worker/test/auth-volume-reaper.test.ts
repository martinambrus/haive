import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  cliAuthApiKeyVolumeName,
  cliAuthIdSlug,
  cliAuthProviderVolumeName,
  cliAuthTaskVolumeName,
  cliAuthVolumeName,
  ideExtensionsVolumeName,
} from '@haive/shared';
import {
  reapOrphanedAuthVolumes,
  selectOrphanAuthVolumes,
} from '../src/sandbox/auth-volume-reaper.js';
import {
  clearTaskAuthPreparationState,
  syncRefreshedAuthToUserVolumes,
} from '../src/sandbox/task-auth-volume.js';

vi.mock('../src/sandbox/task-auth-volume.js', () => ({
  syncRefreshedAuthToUserVolumes: vi.fn(async () => ({ retainTaskCopy: false })),
  clearTaskAuthPreparationState: vi.fn(),
}));
afterEach(() => {
  vi.mocked(syncRefreshedAuthToUserVolumes)
    .mockReset()
    .mockResolvedValue({ retainTaskCopy: false });
  vi.mocked(clearTaskAuthPreparationState).mockReset();
});

const USER = 'aaaaaaaa-1111-4111-8111-111111111111';
const PROVIDER = 'bbbbbbbb-2222-4222-8222-222222222222';
const LIVE_TASK = 'cccccccc-3333-4333-8333-333333333333';
const DONE_TASK = 'dddddddd-4444-4444-8444-444444444444';
const GONE_USER = 'eeeeeeee-5555-4555-8555-555555555555';
const GONE_PROVIDER = 'ffffffff-6666-4666-8666-666666666666';

const live = (tasks: string[], providers: string[], users: string[]) => ({
  tasks: new Set(tasks.map(cliAuthIdSlug)),
  providers: new Set(providers.map(cliAuthIdSlug)),
  users: new Set(users.map(cliAuthIdSlug)),
});

describe('selectOrphanAuthVolumes', () => {
  it('takes a dead task copy, and a provider or user volume whose row is gone', () => {
    const reaped = [
      cliAuthVolumeName(GONE_USER, 'codex', 0),
      cliAuthApiKeyVolumeName(GONE_USER, 'zai', 1),
      cliAuthProviderVolumeName(GONE_PROVIDER, 'gemini', 1),
      cliAuthTaskVolumeName(DONE_TASK, 'ollama', 0),
    ];
    const kept = [
      cliAuthVolumeName(USER, 'claude-code', 0),
      cliAuthApiKeyVolumeName(USER, 'zai', 0),
      cliAuthProviderVolumeName(PROVIDER, 'gemini', 0),
      cliAuthTaskVolumeName(LIVE_TASK, 'claude-code', 0),
      'some_unrelated_volume',
      ideExtensionsVolumeName(GONE_USER),
    ];
    const orphans = selectOrphanAuthVolumes(
      [...kept, ...reaped],
      live([LIVE_TASK], [PROVIDER], [USER]),
    );
    expect(orphans.sort()).toEqual([...reaped].sort());
  });

  it('is empty when every owner is live', () => {
    const orphans = selectOrphanAuthVolumes(
      [cliAuthTaskVolumeName(LIVE_TASK, 'codex', 0), cliAuthVolumeName(USER, 'codex', 0)],
      live([LIVE_TASK], [], [USER]),
    );
    expect(orphans).toEqual([]);
  });
});

describe('reapOrphanedAuthVolumes', () => {
  function fixture(status = 'completed') {
    const fake = createFakeDb(
      {
        tasks: schema.tasks,
        cliInvocations: schema.cliInvocations,
        cliProviders: schema.cliProviders,
        users: schema.users,
      },
      { rowLocks: true },
    );
    fake.insert(schema.users, { id: USER });
    fake.insert(schema.cliProviders, { id: PROVIDER, userId: USER, name: 'gemini' });
    fake.insert(schema.tasks, { id: LIVE_TASK, userId: USER, status: 'running' });
    fake.insert(schema.tasks, { id: DONE_TASK, userId: USER, status, orchestrationEpoch: 1 });
    return fake;
  }
  const db = () => fixture().db as unknown as Database;

  it.each(['completed', 'failed', 'cancelled'])(
    'syncs a %s task once before fenced removal of all its volumes',
    async (status) => {
      const fake = fixture(status);
      const database = fake.db as unknown as Database;
      const names = [
        cliAuthTaskVolumeName(DONE_TASK, 'gemini', 0),
        cliAuthTaskVolumeName(DONE_TASK, 'gemini', 1),
      ];
      const events: string[] = [];
      vi.mocked(syncRefreshedAuthToUserVolumes).mockImplementationOnce(async (db, task) => {
        expect(db).toBe(database);
        expect(task).toBe(DONE_TASK);
        expect(fake.rowLocked(schema.tasks, DONE_TASK)).toBe(false);
        events.push('sync');
        return { retainTaskCopy: false };
      });
      const count = await reapOrphanedAuthVolumes(database, {
        listAuthVolumes: async () => names,
        removeStoppedContainersUsingVolume: async () => {
          expect(fake.rowLocked(schema.tasks, DONE_TASK)).toBe(true);
          events.push('stopped');
        },
        removeVolume: async () => {
          expect(fake.rowLocked(schema.tasks, DONE_TASK)).toBe(true);
          events.push('remove');
        },
      });
      expect(count).toBe(2);
      expect(events).toEqual(['sync', 'stopped', 'remove', 'stopped', 'remove']);
      expect(syncRefreshedAuthToUserVolumes).toHaveBeenCalledOnce();
      expect(clearTaskAuthPreparationState).toHaveBeenCalledWith(DONE_TASK);
      expect(fake.rowLocked(schema.tasks, DONE_TASK)).toBe(false);
    },
  );

  it('keeps a terminal task with a live invocation without syncing or removing', async () => {
    const fake = fixture('failed');
    fake.insert(schema.cliInvocations, {
      id: '12345678-1234-4123-8123-123456789012',
      taskId: DONE_TASK,
      startedAt: new Date(),
      endedAt: null,
      supersededAt: null,
    });
    const remove = vi.fn();
    expect(
      await reapOrphanedAuthVolumes(fake.db as unknown as Database, {
        listAuthVolumes: async () => [cliAuthTaskVolumeName(DONE_TASK, 'codex', 0)],
        removeVolume: remove,
      }),
    ).toBe(0);
    expect(syncRefreshedAuthToUserVolumes).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(['queued', 'ended', 'superseded'])(
    'does not mistake a %s invocation for a live writer',
    async (state) => {
      const fake = fixture('failed');
      fake.insert(schema.cliInvocations, {
        id: '12345678-1234-4123-8123-123456789012',
        taskId: DONE_TASK,
        startedAt: state === 'queued' ? null : new Date(),
        endedAt: state === 'ended' ? new Date() : null,
        supersededAt: state === 'superseded' ? new Date() : null,
      });
      const remove = vi.fn();
      expect(
        await reapOrphanedAuthVolumes(fake.db as unknown as Database, {
          listAuthVolumes: async () => [cliAuthTaskVolumeName(DONE_TASK, 'codex', 0)],
          removeVolume: remove,
        }),
      ).toBe(1);
      expect(syncRefreshedAuthToUserVolumes).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
    },
  );
  it('retains copies if an invocation becomes live during sync', async () => {
    const fake = fixture('failed');
    vi.mocked(syncRefreshedAuthToUserVolumes).mockImplementationOnce(async () => {
      fake.insert(schema.cliInvocations, {
        id: '12345678-1234-4123-8123-123456789012',
        taskId: DONE_TASK,
        startedAt: new Date(),
        endedAt: null,
        supersededAt: null,
      });
      return { retainTaskCopy: false };
    });
    const remove = vi.fn();
    expect(
      await reapOrphanedAuthVolumes(fake.db as unknown as Database, {
        listAuthVolumes: async () => [cliAuthTaskVolumeName(DONE_TASK, 'codex', 0)],
        removeVolume: remove,
      }),
    ).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps auth volumes and preparations when Retry wins during sync', async () => {
    const fake = fixture('failed');
    vi.mocked(syncRefreshedAuthToUserVolumes).mockImplementationOnce(async () => {
      fake.patch(schema.tasks, DONE_TASK, { status: 'running', orchestrationEpoch: 2 });
      return { retainTaskCopy: false };
    });
    const stopped = vi.fn();
    const remove = vi.fn();
    const count = await reapOrphanedAuthVolumes(fake.db as unknown as Database, {
      listAuthVolumes: async () => [cliAuthTaskVolumeName(DONE_TASK, 'codex', 0)],
      removeStoppedContainersUsingVolume: stopped,
      removeVolume: remove,
    });
    expect(count).toBe(0);
    expect(stopped).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(clearTaskAuthPreparationState).not.toHaveBeenCalled();
  });

  it('keeps volumes on a sync lookup error and continues with another orphan', async () => {
    vi.mocked(syncRefreshedAuthToUserVolumes).mockRejectedValueOnce(
      new Error('ledger unavailable'),
    );
    const remove = vi.fn();
    const gone = cliAuthVolumeName(GONE_USER, 'codex', 0);
    expect(
      await reapOrphanedAuthVolumes(db(), {
        listAuthVolumes: async () => [cliAuthTaskVolumeName(DONE_TASK, 'codex', 0), gone],
        removeVolume: remove,
      }),
    ).toBe(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith(gone);
  });

  it('keeps an ambiguous task slug without syncing either task', async () => {
    const fake = fixture('failed');
    fake.insert(schema.tasks, { id: 'dddddddd-4444-4444-8444-555555555555', status: 'failed' });
    const remove = vi.fn();
    expect(
      await reapOrphanedAuthVolumes(fake.db as unknown as Database, {
        listAuthVolumes: async () => [cliAuthTaskVolumeName(DONE_TASK, 'codex', 0)],
        removeVolume: remove,
      }),
    ).toBe(0);
    expect(syncRefreshedAuthToUserVolumes).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('starts no volume removal after the settlement transaction ends during helper cleanup', async () => {
    const fake = fixture('failed');
    const expire = Promise.withResolvers<never>();
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    let callback: Promise<unknown> = Promise.resolve();
    const database = {
      ...fake.db,
      transaction: (section: Parameters<Database['transaction']>[0]) => {
        const pending = (fake.db as unknown as Database).transaction(section);
        callback = pending.catch(() => undefined);
        return Promise.race([pending, expire.promise]);
      },
    } as unknown as Database;
    const remove = vi.fn();
    const reaping = reapOrphanedAuthVolumes(database, {
      listAuthVolumes: async () => [cliAuthTaskVolumeName(DONE_TASK, 'codex', 0)],
      removeStoppedContainersUsingVolume: async (_name, signal) => {
        started.resolve(signal!);
        await release.promise;
      },
      removeVolume: remove,
    });
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    expire.reject(new Error('transaction ended'));
    expect(await reaping).toBe(0);
    expect(signal.aborted).toBe(true);
    release.resolve();
    await callback;
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes only volumes nothing needs, after their stopped containers', async () => {
    const goneOwners = [
      cliAuthVolumeName(GONE_USER, 'claude-code', 0),
      cliAuthProviderVolumeName(GONE_PROVIDER, 'gemini', 0),
    ];
    const doneTask = cliAuthTaskVolumeName(DONE_TASK, 'codex', 0);
    const present = [
      cliAuthVolumeName(USER, 'claude-code', 0),
      cliAuthProviderVolumeName(PROVIDER, 'gemini', 0),
      cliAuthTaskVolumeName(LIVE_TASK, 'codex', 0),
      ...goneOwners,
      doneTask,
    ];
    const removed: string[] = [];
    const stopped: string[] = [];
    const forced: string[] = [];
    const count = await reapOrphanedAuthVolumes(db(), {
      listAuthVolumes: async () => present,
      removeStoppedContainersUsingVolume: async (name) => {
        stopped.push(name);
      },
      removeContainersUsingVolume: async (name) => {
        forced.push(name);
      },
      removeVolume: async (name) => {
        removed.push(name);
      },
    });

    expect(count).toBe(3);
    // A running container of a task copy is spared; a gone owner's login session is not.
    expect(stopped).toEqual([doneTask]);
    expect(forced.sort()).toEqual([...goneOwners].sort());
    expect(removed.sort()).toEqual([...goneOwners, doneTask].sort());
  });

  it('is a no-op when nothing is listed', async () => {
    const count = await reapOrphanedAuthVolumes(db(), {
      listAuthVolumes: async () => [],
      removeVolume: async () => {
        throw new Error('should not be called');
      },
    });
    expect(count).toBe(0);
  });

  it('counts only volumes that were actually removed and continues after a failure', async () => {
    const removed: string[] = [];
    const count = await reapOrphanedAuthVolumes(db(), {
      listAuthVolumes: async () => [
        'haive_cli_auth_task_dead00000001_codex_0',
        'haive_cli_auth_task_dead00000002_codex_0',
      ],
      removeStoppedContainersUsingVolume: async () => undefined,
      removeVolume: async (name) => {
        if (name.includes('00000001')) throw new Error('still in use');
        removed.push(name);
      },
    });

    expect(count).toBe(1);
    expect(removed).toEqual(['haive_cli_auth_task_dead00000002_codex_0']);
  });
});

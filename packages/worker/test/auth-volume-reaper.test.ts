import { describe, expect, it } from 'vitest';
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
  function db(): Database {
    const fake = createFakeDb({
      tasks: schema.tasks,
      cliProviders: schema.cliProviders,
      users: schema.users,
    });
    fake.insert(schema.users, { id: USER });
    fake.insert(schema.cliProviders, { id: PROVIDER, userId: USER, name: 'gemini' });
    fake.insert(schema.tasks, { id: LIVE_TASK, userId: USER, status: 'running' });
    fake.insert(schema.tasks, { id: DONE_TASK, userId: USER, status: 'completed' });
    return fake.db as unknown as Database;
  }

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
    const cleaned: string[] = [];
    const count = await reapOrphanedAuthVolumes(db(), {
      listAuthVolumes: async () => present,
      removeStoppedContainersUsingVolume: async (name) => {
        cleaned.push(name);
      },
      removeVolume: async (name) => {
        removed.push(name);
      },
    });

    const reaped = [...goneOwners, doneTask];
    expect(count).toBe(3);
    expect(cleaned.sort()).toEqual([...reaped].sort());
    expect(removed.sort()).toEqual([...reaped].sort());
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

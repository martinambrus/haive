import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { cliAuthTaskVolumeName, resolveCliAuthUserVolumeName } from '@haive/shared';
import type { SQL } from 'drizzle-orm';
import { reapOrphanedAuthVolumes } from '../src/sandbox/auth-volume-reaper.js';
import {
  syncProviderAuthBack,
  syncRefreshedAuthToUserVolumes,
} from '../src/sandbox/task-auth-volume.js';
import type { DockerRunner, DockerRunOpts } from '../src/sandbox/docker-runner.js';

const lock = vi.hoisted(() => ({ acquire: vi.fn(), afterAcquire: () => {} }));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: lock.acquire,
}));
const roots: string[] = [];
beforeEach(() => {
  lock.afterAcquire = () => {};
  lock.acquire.mockReset().mockImplementation(async () => {
    lock.afterAcquire();
    return Object.assign(async () => {}, { assertHeld: async () => {} });
  });
});
afterEach(() => {
  vi.useRealTimers();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'haive-auth-lifecycle-'));
  roots.push(root);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/chown'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const fake = createFakeDb(
    {
      tasks: schema.tasks,
      users: schema.users,
      cliProviders: schema.cliProviders,
      cliInvocations: schema.cliInvocations,
    },
    { rowLocks: true },
  );
  const taskId = randomUUID();
  const userId = randomUUID();
  const provider = {
    id: randomUUID(),
    userId,
    name: 'codex' as const,
    authMode: 'subscription' as const,
    isolateAuth: false,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
  fake.insert(schema.tasks, {
    id: taskId,
    userId,
    status: 'failed',
    orchestrationEpoch: 1,
    createdAt: new Date('2026-01-02T00:00:00Z'),
  });
  fake.insert(schema.users, { id: userId });
  fake.insert(schema.cliProviders, provider);
  fake.insert(schema.cliInvocations, { id: randomUUID(), taskId, cliProviderId: provider.id });
  const db = {
    ...fake.db,
    selectDistinct: (fields: { providerId: typeof schema.cliInvocations.cliProviderId }) => ({
      from: (table: typeof schema.cliInvocations) => ({
        where: async (where: SQL) => {
          const rows = await (fake.db as unknown as Database)
            .select(fields)
            .from(table)
            .where(where);
          return [...new Map(rows.map((row) => [row.providerId, row])).values()];
        },
      }),
    }),
  } as unknown as Database;
  const volumeOf = (p = provider) =>
    resolveCliAuthUserVolumeName({ ...p, providerId: p.id, providerName: p.name }, 0);
  const userVol = volumeOf();
  const taskVol = cliAuthTaskVolumeName(taskId, 'codex', 0);
  const dirs = new Map<string, string>();
  const labels = new Map<string, string>();
  function addVolume(name: string, token: string, seconds: number) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    dirs.set(name, dir);
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: token } }));
    utimesSync(join(dir, 'auth.json'), seconds, seconds);
  }
  const prior = randomBytes(32).toString('hex');
  const rotated = randomBytes(32).toString('hex');
  addVolume(userVol, prior, 100);
  addVolume(taskVol, rotated, 200);
  labels.set(
    taskVol,
    JSON.stringify({ userVolume: userVol, authMode: provider.authMode, isolateAuth: false }),
  );
  const events: string[] = [];
  const runner = {
    volumeExists: async (name: string) => dirs.has(name),
    volumeLabel: async (name: string) => labels.get(name) ?? null,
    run: async (opts: DockerRunOpts) => {
      let script = opts.cmd[2]!;
      for (const mount of opts.mounts ?? []) {
        const dir = dirs.get(mount.source);
        if (!dir) throw new Error('fixture volume absent');
        script = script.replaceAll(mount.target, dir);
      }
      if (opts.mounts?.length === 2) events.push('copy');
      const result = spawnSync(opts.cmd[0]!, ['-c', script], {
        encoding: 'utf8',
        env: { PATH: `${root}/bin:/usr/bin:/bin` },
      });
      return {
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: 0,
        timedOut: false,
      };
    },
  } as unknown as DockerRunner;
  const reap = () =>
    reapOrphanedAuthVolumes(db, {
      runner,
      listAuthVolumes: async () => [taskVol],
      removeVolume: async (name) => {
        expect(fake.rowLocked(schema.tasks, taskId)).toBe(true);
        events.push('remove');
        dirs.delete(name);
      },
    });
  const unchanged = () =>
    expect(readFileSync(join(dirs.get(userVol)!, 'auth.json'), 'utf8').includes(prior)).toBe(true);
  return {
    root,
    fake,
    db,
    taskId,
    provider,
    runner,
    labels,
    dirs,
    events,
    taskVol,
    userVol,
    volumeOf,
    addVolume,
    prior,
    rotated,
    reap,
    unchanged,
  };
}

it('boot reaper carries a rotated token through the real ledger sync before fenced removal', async () => {
  const f = fixture();
  expect(await f.reap()).toBe(1);
  expect(f.events).toEqual(['copy', 'remove']);
  expect(readFileSync(join(f.dirs.get(f.userVol)!, 'auth.json'), 'utf8').includes(f.rotated)).toBe(
    true,
  );
});
it.each(['authMode', 'isolateAuth'] as const)(
  'refuses a %s switch after the copy was prepared',
  async (field) => {
    const f = fixture();
    const changed = { ...f.provider, [field]: field === 'authMode' ? 'api_key' : true };
    f.fake.patch(schema.cliProviders, f.provider.id, changed);
    const target = resolveCliAuthUserVolumeName(
      {
        ...changed,
        authMode: changed.authMode as 'api_key',
        providerId: changed.id,
        providerName: changed.name,
        isolateAuth: changed.isolateAuth as boolean,
      },
      0,
    );
    f.addVolume(target, f.prior, 100);
    await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
    expect(f.events).toEqual([]);
    expect(readFileSync(join(f.dirs.get(target)!, 'auth.json'), 'utf8').includes(f.prior)).toBe(
      true,
    );
  },
);
it('re-reads the row after acquiring the original scope lock', async () => {
  const f = fixture();
  lock.afterAcquire = () => f.fake.patch(schema.cliProviders, f.provider.id, { isolateAuth: true });
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
  f.unchanged();
});
it('refuses two ledger rows of one CLI with different user volumes', async () => {
  const f = fixture();
  const sibling = { ...f.provider, id: randomUUID(), isolateAuth: true };
  f.fake.insert(schema.cliProviders, sibling);
  f.fake.insert(schema.cliInvocations, {
    id: randomUUID(),
    taskId: f.taskId,
    cliProviderId: sibling.id,
  });
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
  f.unchanged();
});
it('boot skips an unrecorded legacy source without writing any user credential', async () => {
  const f = fixture();
  f.labels.clear();
  expect(await f.reap()).toBe(1);
  expect(f.events).toEqual(['remove']);
  f.unchanged();
});
it('task-end and summary sync carry back an unlabeled copy with an unchanged provider row', async () => {
  const f = fixture();
  f.labels.clear();
  expect(await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner)).toEqual({
    retainTaskCopy: false,
  });
  expect(f.events).toEqual(['copy']);
  expect(readFileSync(join(f.dirs.get(f.userVol)!, 'auth.json'), 'utf8').includes(f.rotated)).toBe(
    true,
  );
});
it.each(['authMode', 'isolateAuth', 'unrelated'] as const)(
  'skips an unlabeled copy after a provider %s update since task creation',
  async (field) => {
    const f = fixture();
    f.labels.clear();
    f.fake.patch(schema.cliProviders, f.provider.id, {
      ...(field === 'authMode' ? { authMode: 'api_key' } : {}),
      ...(field === 'isolateAuth' ? { isolateAuth: true } : {}),
      updatedAt: new Date('2026-01-03T00:00:00Z'),
    });
    await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
    expect(f.events).toEqual([]);
    f.unchanged();
  },
);
it('checks unlabeled row age after acquiring the auth lock', async () => {
  const f = fixture();
  f.labels.clear();
  lock.afterAcquire = () =>
    f.fake.patch(schema.cliProviders, f.provider.id, {
      updatedAt: new Date('2026-01-03T00:00:00Z'),
    });
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
  f.unchanged();
});
it('requires every same-scope ledger row to predate task creation for an unlabeled copy', async () => {
  const f = fixture();
  f.labels.clear();
  const sibling = {
    ...f.provider,
    id: randomUUID(),
    updatedAt: new Date('2026-01-03T00:00:00Z'),
  };
  f.fake.insert(schema.cliProviders, sibling);
  f.fake.insert(schema.cliInvocations, {
    id: randomUUID(),
    taskId: f.taskId,
    cliProviderId: sibling.id,
  });
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
  f.unchanged();
});
it('keeps the multi-row scope refusal for an unlabeled copy', async () => {
  const f = fixture();
  f.labels.clear();
  const sibling = { ...f.provider, id: randomUUID(), isolateAuth: true };
  f.fake.insert(schema.cliProviders, sibling);
  f.fake.insert(schema.cliInvocations, {
    id: randomUUID(),
    taskId: f.taskId,
    cliProviderId: sibling.id,
  });
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
  f.unchanged();
});
it('mid-task harvest still refuses an unlabeled copy even with an unchanged row', async () => {
  const f = fixture();
  f.labels.clear();
  expect(await syncProviderAuthBack(f.taskId, f.provider, f.db, f.runner, 0)).toBe(false);
  expect(f.events).toEqual([]);
  f.unchanged();
});
it('labeled copies still sync after unrelated row updates', async () => {
  const f = fixture();
  f.fake.patch(schema.cliProviders, f.provider.id, {
    updatedAt: new Date('2026-01-03T00:00:00Z'),
  });
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual(['copy']);
});
it('boot keeps a busy copy and syncs it on the next pass', async () => {
  const f = fixture();
  vi.useFakeTimers();
  const acquire = lock.acquire.getMockImplementation()!;
  lock.acquire.mockResolvedValue(null);
  const pending = f.reap();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await pending).toBe(0);
  lock.acquire.mockImplementation(acquire);
  expect(f.events).toEqual([]);
  expect(f.dirs.has(f.taskVol)).toBe(true);
  expect(await f.reap()).toBe(1);
  expect(f.events).toEqual(['copy', 'remove']);
});
it('sweeps only old credential temps on the next locked pass, even without a new token', async () => {
  const f = fixture();
  const dir = f.dirs.get(f.userVol)!;
  for (const name of [
    'auth.json.haive-tmp-old',
    'auth.json.haive-tmp-new',
    'other.haive-tmp-old',
  ]) {
    writeFileSync(join(dir, name), randomBytes(32));
  }
  utimesSync(join(dir, 'auth.json.haive-tmp-old'), 1, 1);
  utimesSync(join(dir, 'other.haive-tmp-old'), 1, 1);
  utimesSync(join(dir, 'auth.json'), 300, 300);
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(readdirSync(dir).sort()).toEqual([
    'auth.json',
    'auth.json.haive-tmp-new',
    'other.haive-tmp-old',
  ]);
  expect(f.events).toEqual([]);
});
it('starts boot auth reaping after the task and CLI queues', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const call = source.indexOf('reapOrphanedAuthVolumes(getDb())');
  expect(call).toBeGreaterThan(source.indexOf('const cliExecWorker = await startCliExecWorker()'));
  expect(source.slice(call - 10, call)).not.toContain('await');
});

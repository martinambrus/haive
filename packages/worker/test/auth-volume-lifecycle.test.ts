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
import { harvestInTaskCredentials } from '../src/usage-window/credential-harvest.js';
import { reapOrphanedAuthVolumes } from '../src/sandbox/auth-volume-reaper.js';
import {
  syncProviderAuthBack,
  syncRefreshedAuthToUserVolumes,
} from '../src/sandbox/task-auth-volume.js';
import type { DockerRunner, DockerRunOpts } from '../src/sandbox/docker-runner.js';

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  logger: { child: () => logs },
}));
const lock = vi.hoisted(() => ({ acquire: vi.fn(), afterAcquire: () => {} }));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: lock.acquire,
}));
const roots: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
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
      auditEvents: schema.auditEvents,
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
    createdAt: new Date('2026-01-01T00:00:00Z'),
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
it('a labeled copy names its source among different ledger scopes', async () => {
  const f = fixture();
  const sibling = { ...f.provider, id: randomUUID(), isolateAuth: true };
  f.fake.insert(schema.cliProviders, sibling);
  f.fake.insert(schema.cliInvocations, {
    id: randomUUID(),
    taskId: f.taskId,
    cliProviderId: sibling.id,
  });
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual(['copy']);
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
function authEvent(f: ReturnType<typeof fixture>, fields: unknown, targetId = f.provider.id) {
  f.fake.insert(schema.auditEvents, {
    id: randomUUID(),
    actorUserId: f.provider.userId,
    targetType: 'cli_provider',
    targetId,
    action: 'cli_provider.update',
    metadata: { fields },
    createdAt: new Date('2026-01-03T00:00:00Z'),
  });
}
it.each(['authMode', 'isolateAuth'] as const)(
  'refuses an unlabeled copy after a %s change with the new target present',
  async (field) => {
    const f = fixture();
    f.labels.clear();
    const changed = { ...f.provider, [field]: field === 'authMode' ? 'api_key' : true };
    f.fake.patch(schema.cliProviders, f.provider.id, changed);
    authEvent(f, [field]);
    const target = resolveCliAuthUserVolumeName(
      {
        ...changed,
        providerId: changed.id,
        providerName: changed.name,
        authMode: changed.authMode as 'api_key',
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
it.each([
  ['settings save', { label: 'edited', rulesContent: 'edited', enabled: false }],
  ['manual rebuild', { sandboxImageEnqueueId: randomUUID(), sandboxImageBuildStatus: 'building' }],
  ['probe result', { authStatus: 'ok', authLastCheckedAt: new Date() }],
  ['image build write', { sandboxImageTag: 'fixture', sandboxImageBuildStatus: 'ready' }],
  ['boot reconcile', { sandboxImageTag: null, sandboxImageBuildStatus: 'idle' }],
  [
    'learned model limit',
    { modelLimits: { model: 'fixture', learnedAt: '2026-01-03T00:00:00Z', maxOutputTokens: 100 } },
  ],
  ['generation-only login', { authGeneration: randomUUID() }],
  ['ollama provisioning fields', { modelProvisionStatus: 'ready' }],
])('an unrelated %s does not block an unlabeled carry', async (_writer, updates) => {
  const f = fixture();
  f.labels.clear();
  f.fake.patch(schema.cliProviders, f.provider.id, {
    ...updates,
    updatedAt: new Date('2026-01-03T00:00:00Z'),
  });
  authEvent(f, ['rulesContent', 'cliVersion']);
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual(['copy']);
});
it('reads auth change evidence after acquiring the lock, including a switch away and back', async () => {
  const f = fixture();
  f.labels.clear();
  lock.afterAcquire = () => authEvent(f, ['isolateAuth']);
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
  f.unchanged();
});
it('checks auth events for every same-scope ledger row', async () => {
  const f = fixture();
  f.labels.clear();
  const sibling = { ...f.provider, id: randomUUID() };
  f.fake.insert(schema.cliProviders, sibling);
  f.fake.insert(schema.cliInvocations, {
    id: randomUUID(),
    taskId: f.taskId,
    cliProviderId: sibling.id,
  });
  authEvent(f, ['authMode'], sibling.id);
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
  f.unchanged();
});
it.each([null, randomUUID()])(
  'refuses an unlabeled copy with a deleted ledger provider (%s)',
  async (id) => {
    const f = fixture();
    f.labels.clear();
    f.fake.insert(schema.cliInvocations, { id: randomUUID(), taskId: f.taskId, cliProviderId: id });
    await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
    expect(f.events).toEqual([]);
    f.unchanged();
  },
);
it.each([null, new Date('2026-01-04T00:00:00Z')])(
  'refuses an unlabeled copy whose provider creation has no safe baseline (%s)',
  async (createdAt) => {
    const f = fixture();
    f.labels.clear();
    f.fake.patch(schema.cliProviders, f.provider.id, { createdAt });
    await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
    expect(f.events).toEqual([]);
  },
);
it('refuses an unlabeled copy when the task timestamp is missing', async () => {
  const f = fixture();
  f.labels.clear();
  f.fake.patch(schema.tasks, f.taskId, { createdAt: null });
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
});
it('a sign-out through a sibling still blocks an unlabeled copy after volume recreation', async () => {
  const f = fixture();
  f.labels.clear();
  const sibling = { ...f.provider, id: randomUUID() };
  f.fake.insert(schema.cliProviders, sibling);
  f.fake.insert(schema.auditEvents, {
    id: randomUUID(),
    actorUserId: f.provider.userId,
    targetType: 'cli_provider',
    targetId: sibling.id,
    action: 'cli_provider.sign_out',
    metadata: { setIds: [sibling.id, f.provider.id], setSize: 2 },
    createdAt: new Date('2026-01-03T00:00:00Z'),
  });
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
  f.unchanged();
});
it('does not treat audit text mentioning an auth field as a structured field change', async () => {
  const f = fixture();
  f.labels.clear();
  authEvent(f, ['rulesContent']);
  f.fake.insert(schema.auditEvents, {
    id: randomUUID(),
    actorUserId: f.provider.userId,
    targetType: 'cli_provider',
    targetId: f.provider.id,
    action: 'cli_provider.secret.set',
    metadata: { source: 'authMode isolateAuth' },
    createdAt: new Date('2026-01-03T00:00:00Z'),
  });
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual(['copy']);
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
it('mid-task sync carries an unchanged unlabeled copy under the transition predicate', async () => {
  const f = fixture();
  f.labels.clear();
  expect(await syncProviderAuthBack(f.taskId, f.provider, f.db, f.runner, 0, undefined, true)).toBe(
    true,
  );
  expect(f.events).toEqual(['copy']);
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
it('sweeps only old credential temps inside the copy helper', async () => {
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
  const run = vi.spyOn(f.runner, 'run');
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(readdirSync(dir).sort()).toEqual([
    'auth.json',
    'auth.json.haive-tmp-new',
    'other.haive-tmp-old',
  ]);
  expect(f.events).toEqual(['copy']);
  expect(run).toHaveBeenCalledTimes(5);
});
it('starts boot auth reaping after the task and CLI queues', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const call = source.indexOf('reapOrphanedAuthVolumes(getDb())');
  expect(call).toBeGreaterThan(source.indexOf('const cliExecWorker = await startCliExecWorker()'));
  expect(source.slice(call - 10, call)).not.toContain('await');
});

it('a failed temp sweep logs and still carries the rotated credential', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'bin/find'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual(['copy']);
  expect(logs.warn).toHaveBeenCalledWith(
    expect.any(Object),
    'auth sync-back temp sweep failed; credential carry continued',
  );
});
it('an unchanged credential uses only the four read helpers', async () => {
  const f = fixture();
  utimesSync(join(f.dirs.get(f.userVol)!, 'auth.json'), 300, 300);
  const run = vi.spyOn(f.runner, 'run');
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
  expect(run).toHaveBeenCalledTimes(4);
});
it.each([
  ['task read', 'cat', true],
  ['user read', 'cat', false],
  ['task stat', 'stat', true],
  ['user stat', 'stat', false],
] as const)(
  'a failed %s helper retains the copy for the next boot',
  async (_name, command, task) => {
    const f = fixture();
    const run = f.runner.run.bind(f.runner);
    vi.spyOn(f.runner, 'run').mockImplementation(async (opts) => {
      if (
        opts.cmd[2]?.startsWith(command) &&
        opts.mounts?.[0]?.source === (task ? f.taskVol : f.userVol)
      )
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 0, timedOut: false };
      return run(opts);
    });
    expect(await f.reap()).toBe(0);
    expect(f.events).toEqual([]);
    expect(f.dirs.has(f.taskVol)).toBe(true);
    f.unchanged();
  },
);
it('a missing credential file is absence rather than a failed helper', async () => {
  const f = fixture();
  rmSync(join(f.dirs.get(f.taskVol)!, 'auth.json'));
  expect(await f.reap()).toBe(1);
  expect(f.events).toEqual(['remove']);
});
it.each([1, undefined])(
  'compares structural source fields for a known label version (%s)',
  async (version) => {
    const f = fixture();
    f.labels.set(
      f.taskVol,
      JSON.stringify({
        isolateAuth: false,
        extra: 'ignored',
        authMode: 'subscription',
        userVolume: f.userVol,
        ...(version ? { version } : {}),
      }),
    );
    await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
    expect(f.events).toEqual(['copy']);
  },
);
it.each([2, '1', null])('refuses an unknown label version (%s)', async (version) => {
  const f = fixture();
  f.labels.set(
    f.taskVol,
    JSON.stringify({
      version,
      userVolume: f.userVol,
      authMode: 'subscription',
      isolateAuth: false,
    }),
  );
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
  f.unchanged();
});

async function harvest(f: ReturnType<typeof fixture>, providers = [f.provider]) {
  f.fake.patch(schema.tasks, f.taskId, { status: 'waiting_user' });
  const chain = (rows: unknown[]) => {
    const query = { from: () => query, innerJoin: () => query, where: async () => rows };
    return query;
  };
  const db = {
    ...f.db,
    selectDistinct: vi
      .fn()
      .mockImplementation(f.db.selectDistinct.bind(f.db))
      .mockReturnValueOnce(chain(providers.map((p) => ({ taskId: f.taskId, ...p }))))
      .mockReturnValueOnce(chain([])),
  } as unknown as Database;
  await harvestInTaskCredentials(db, f.runner);
}
it('harvest carries an unchanged unlabeled copy through the real sync path', async () => {
  const f = fixture();
  f.labels.clear();
  await harvest(f);
  expect(f.events).toEqual(['copy']);
});
it('harvest lets a source label disambiguate mixed ledger scopes', async () => {
  const f = fixture();
  const sibling = { ...f.provider, id: randomUUID(), isolateAuth: true };
  f.fake.insert(schema.cliProviders, sibling);
  f.fake.insert(schema.cliInvocations, {
    id: randomUUID(),
    taskId: f.taskId,
    cliProviderId: sibling.id,
  });
  await harvest(f, [f.provider, sibling as typeof f.provider]);
  expect(f.events).toEqual(['copy']);
});
it('warns once per unlabeled copy across repeated harvest ticks and ledger rows', async () => {
  const f = fixture();
  f.labels.clear();
  const sibling = { ...f.provider, id: randomUUID() };
  f.fake.insert(schema.cliProviders, sibling);
  f.fake.insert(schema.cliInvocations, {
    id: randomUUID(),
    taskId: f.taskId,
    cliProviderId: sibling.id,
  });
  authEvent(f, ['authMode']);
  await harvest(f);
  await harvest(f);
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
  expect(logs.warn.mock.calls.filter((call) => String(call[1]).includes('unlabeled'))).toHaveLength(
    1,
  );
});
it('an unknown source label version is logged as a refusal', async () => {
  const f = fixture();
  f.labels.set(
    f.taskVol,
    JSON.stringify({
      version: 99,
      userVolume: f.userVol,
      authMode: 'subscription',
      isolateAuth: false,
    }),
  );
  await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner);
  expect(f.events).toEqual([]);
  expect(logs.warn).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'unsupported_source_version' }),
    'auth sync-back refused',
  );
});
it('a timed-out read never supplies a credential even with successful exit and output', async () => {
  const f = fixture();
  const run = f.runner.run.bind(f.runner);
  vi.spyOn(f.runner, 'run').mockImplementation(async (opts) => {
    const result = await run(opts);
    return opts.cmd[2]?.startsWith('cat') ? { ...result, timedOut: true } : result;
  });
  expect(await f.reap()).toBe(0);
  expect(f.dirs.has(f.taskVol)).toBe(true);
  expect(f.events).toEqual([]);
});

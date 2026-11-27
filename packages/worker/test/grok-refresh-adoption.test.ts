import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { cliAuthTaskVolumeName, resolveCliAuthUserVolumeName } from '@haive/shared';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
import {
  ensureTaskAuthVolumes,
  syncRefreshedAuthToUserVolumes,
  type ProviderAuthCtx,
} from '../src/sandbox/task-auth-volume.js';
import { refreshExpiringCliCredentials } from '../src/usage-window/credential-refresh.js';
import type { DockerRunner, DockerRunOpts } from '../src/sandbox/docker-runner.js';

const locks = vi.hoisted(() => ({ acquire: vi.fn() }));
const listing = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: locks.acquire,
}));
vi.mock('../src/sandbox/auth-volume-reaper.js', () => ({ listTaskAuthVolumes: listing.list }));
vi.mock('../src/sandbox/sandbox-core-image.js', () => ({ ensureSandboxCoreImage: async () => {} }));

const roots: string[] = [];
const held = new Set<string>();
beforeEach(() => {
  held.clear();
  locks.acquire.mockReset().mockImplementation(async (_db, scope: string) => {
    if (held.has(scope)) return null;
    held.add(scope);
    return Object.assign(
      async () => {
        held.delete(scope);
      },
      {
        assertHeld: async () => {
          if (!held.has(scope)) throw new Error('lock lost');
        },
      },
    );
  });
  listing.list.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'grok-adoption-'));
  roots.push(root);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/chown'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(
    join(root, 'bin/stat'),
    '#!/bin/sh\nif [ "$2" = "%u" ]; then echo 1000; else exec /usr/bin/stat "$@"; fi\n',
    { mode: 0o755 },
  );
  const taskId = randomUUID();
  const provider = {
    id: randomUUID(),
    userId: randomUUID(),
    name: 'grok' as const,
    authMode: 'subscription' as const,
    isolateAuth: false,
  };
  const ctx: ProviderAuthCtx = {
    ...provider,
    providerId: provider.id,
    providerName: provider.name,
  };
  const userVol = resolveCliAuthUserVolumeName(ctx, 0);
  const taskVol = cliAuthTaskVolumeName(taskId, 'grok', 0);
  const dirs = new Map<string, string>();
  const labels = new Map<string, string>();
  const raw = (refreshToken = randomBytes(24).toString('hex')) =>
    JSON.stringify({
      'issuer::client': {
        key: randomBytes(24).toString('hex'),
        refresh_token: refreshToken,
        oidc_client_id: 'client',
        expires_at: '2020-01-01T00:00:00Z',
      },
    });
  const initial = raw();
  for (const vol of [userVol, taskVol]) {
    const dir = join(root, vol);
    mkdirSync(dir);
    dirs.set(vol, dir);
    writeFileSync(join(dir, 'auth.json'), initial);
  }
  writeFileSync(join(dirs.get(taskVol)!, '.haive-ready'), '');
  writeFileSync(
    join(dirs.get(taskVol)!, '.haive-source'),
    createHash('md5').update(initial).digest('hex'),
  );
  labels.set(
    taskVol,
    JSON.stringify({
      version: 1,
      userVolume: userVol,
      authMode: 'subscription',
      isolateAuth: false,
    }),
  );
  const task = { id: taskId, status: 'failed' };
  const db = {
    selectDistinct: () => ({ from: () => ({ where: async () => [{ providerId: provider.id }] }) }),
    query: {
      tasks: { findMany: vi.fn(async () => [task]) },
      cliInvocations: { findFirst: vi.fn(async () => undefined) },
      cliProviders: {
        findMany: vi.fn(async () => [provider]),
        findFirst: vi.fn(async () => provider),
      },
    },
  } as unknown as Database;
  const removed: string[] = [];
  let failCredentialWrite = false;
  let failFenceWrite = false;
  let refuseRemove = false;
  const runner = {
    volumeExists: async (name: string) => dirs.has(name),
    volumeLabel: async (name: string) => labels.get(name) ?? null,
    volumeCreate: async (name: string, values: Record<string, string>) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      dirs.set(name, dir);
      labels.set(name, values['haive.auth-source']!);
      return { ok: true, stderr: '' };
    },
    volumeRemove: async (name: string) => {
      if (refuseRemove) return { ok: false, stderr: 'in use' };
      removed.push(name);
      rmSync(dirs.get(name)!, { recursive: true, force: true });
      dirs.delete(name);
      return { ok: true, stderr: '' };
    },
    run: async (opts: DockerRunOpts) => {
      let script = opts.cmd[2]!;
      if (failFenceWrite && script.includes('haive-grok-refresh.haive-tmp'))
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 0, timedOut: false };
      if (failCredentialWrite && script.includes("mv '/vol/auth.json.haive-tmp'"))
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 0, timedOut: false };
      for (const mount of opts.mounts ?? []) {
        const dir = dirs.get(mount.source);
        if (!dir) throw new Error('missing fixture volume');
        script = script.replaceAll(mount.target, dir);
      }
      const result = spawnSync(opts.cmd[0]!, ['-c', script], {
        encoding: 'utf8',
        timeout: 500,
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
  listing.list.mockResolvedValue([taskVol]);
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      access_token: randomBytes(24).toString('hex'),
      refresh_token: randomBytes(24).toString('hex'),
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  const credential = (vol: string) => readFileSync(join(dirs.get(vol)!, 'auth.json'), 'utf8');
  const adopt = () => ensureTaskAuthVolumes(ctx, taskId, runner, db);
  return {
    db,
    task,
    ctx,
    taskId,
    userVol,
    taskVol,
    root,
    dirs,
    labels,
    removed,
    runner,
    raw,
    initial,
    credential,
    adopt,
    fetchMock,
    failWrite: () => {
      failCredentialWrite = true;
    },
    failFence: () => {
      failFenceWrite = true;
    },
    refuseRemove: () => {
      refuseRemove = true;
    },
  };
}

it('adoption during rotation waits, then gets the fresh credential; another scope can proceed', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const rotating = barrier();
  const finish = barrier();
  f.fetchMock.mockImplementationOnce(async () => {
    rotating.resolve();
    await finish.promise;
    return {
      ok: true,
      json: async () => ({
        access_token: randomBytes(24).toString('hex'),
        refresh_token: randomBytes(24).toString('hex'),
      }),
    };
  });
  const refresh = refreshExpiringCliCredentials(f.db, f.runner);
  await rotating.promise;
  f.task.status = 'running';
  let adopted = false;
  const adoption = f.adopt().then(() => {
    adopted = true;
  });
  const otherCtx = { ...f.ctx, userId: randomUUID() };
  const otherDb = {
    query: {
      cliProviders: {
        findFirst: async () => ({ ...otherCtx, id: otherCtx.providerId, name: 'grok' }),
      },
    },
  } as unknown as Database;
  try {
    await ensureTaskAuthVolumes(otherCtx, randomUUID(), f.runner, otherDb);
    expect(adopted).toBe(false);
  } finally {
    finish.resolve();
    await refresh;
    await vi.advanceTimersByTimeAsync(500);
    await adoption;
  }
  expect(f.credential(f.taskVol) === f.credential(f.userVol)).toBe(true);
  expect(f.credential(f.taskVol) === f.initial).toBe(false);
});

it('Retry after a completed rotation recopies an unchanged snapshot', async () => {
  const f = fixture();
  await refreshExpiringCliCredentials(f.db, f.runner);
  await f.adopt();
  expect(f.credential(f.taskVol) === f.credential(f.userVol)).toBe(true);
  expect(f.credential(f.taskVol) === f.initial).toBe(false);
});

it('preserves a newer in-task login when the source also rotated', async () => {
  const f = fixture();
  const newer = f.raw();
  writeFileSync(join(f.dirs.get(f.taskVol)!, 'auth.json'), newer);
  await refreshExpiringCliCredentials(f.db, f.runner);
  await expect(f.adopt()).rejects.toMatchObject({ code: 'grok_login_required' });
  expect(f.credential(f.taskVol) === newer).toBe(true);
  expect(f.removed).toEqual([]);
});

it('keeps using a newer in-task login while its source has not changed', async () => {
  const f = fixture();
  const newer = f.raw();
  writeFileSync(join(f.dirs.get(f.taskVol)!, 'auth.json'), newer);
  await f.adopt();
  expect(f.credential(f.taskVol) === newer).toBe(true);
  expect(f.removed).toEqual([]);
});

it.each(['unlabeled', 'unknown-version', 'missing-marker'])(
  'retains and refuses an unverifiable %s copy after rotation',
  async (kind) => {
    const f = fixture();
    if (kind === 'unlabeled') f.labels.delete(f.taskVol);
    if (kind === 'unknown-version') f.labels.set(f.taskVol, '{"version":2}');
    if (kind === 'missing-marker') rmSync(join(f.dirs.get(f.taskVol)!, '.haive-source'));
    await refreshExpiringCliCredentials(f.db, f.runner);
    await expect(f.adopt()).rejects.toMatchObject({ code: 'grok_login_required' });
    expect(f.credential(f.taskVol) === f.initial).toBe(true);
    expect(f.removed).toEqual([]);
  },
);

it('refuses a stale copy still mounted by another invocation', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await refreshExpiringCliCredentials(f.db, f.runner);
  f.refuseRemove();
  const result = f.adopt().then(
    () => null,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(45_000);
  expect(await result).toMatchObject({ code: 'grok_login_required' });
  expect(f.credential(f.taskVol) === f.initial).toBe(true);
});

it('rechecks live state after taking the auth lock', async () => {
  const f = fixture();
  const acquire = locks.acquire.getMockImplementation()!;
  locks.acquire.mockImplementationOnce(async (...args) => {
    f.task.status = 'running';
    return acquire(...args);
  });
  await refreshExpiringCliCredentials(f.db, f.runner);
  expect(f.fetchMock).not.toHaveBeenCalled();
});

it('lists task copies after taking the auth lock', async () => {
  const f = fixture();
  f.task.status = 'running';
  listing.list.mockImplementation(async () =>
    held.has(cliAuthScope({ ...f.ctx, id: f.ctx.providerId, name: 'grok' })) ? [f.taskVol] : [],
  );
  await refreshExpiringCliCredentials(f.db, f.runner);
  expect(f.fetchMock).not.toHaveBeenCalled();
});

it('refuses admission after a grant consumed the token but persistence failed', async () => {
  const f = fixture();
  f.failWrite();
  await refreshExpiringCliCredentials(f.db, f.runner);
  expect(f.fetchMock).toHaveBeenCalledOnce();
  await expect(f.adopt()).rejects.toMatchObject({ code: 'grok_login_required' });
  expect(f.credential(f.taskVol) === f.initial).toBe(true);
  expect(f.removed).toEqual([]);
});

it('settlement keeps a divergent recovery copy after admission refused it', async () => {
  const f = fixture();
  const newer = f.raw();
  writeFileSync(join(f.dirs.get(f.taskVol)!, 'auth.json'), newer);
  await refreshExpiringCliCredentials(f.db, f.runner);
  await expect(f.adopt()).rejects.toMatchObject({ code: 'grok_login_required' });
  expect(await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner)).toEqual({
    retainTaskCopy: true,
  });
  expect(f.credential(f.taskVol) === newer).toBe(true);
  expect(f.credential(f.userVol) === newer).toBe(false);
});

it('settlement retains refused Grok copies from another or no source, even without a ledger provider', async () => {
  for (const label of [
    JSON.stringify({
      version: 1,
      userVolume: 'different-source',
      authMode: 'subscription',
      isolateAuth: false,
    }),
    'none',
  ]) {
    const f = fixture();
    f.labels.set(f.taskVol, label);
    await expect(f.adopt()).rejects.toMatchObject({ code: 'grok_login_required' });
    expect(await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner)).toEqual({
      retainTaskCopy: true,
    });
    const missingDb = {
      ...f.db,
      selectDistinct: () => ({ from: () => ({ where: async () => [{ providerId: null }] }) }),
    } as unknown as Database;
    expect(await syncRefreshedAuthToUserVolumes(missingDb, f.taskId, f.runner)).toEqual({
      retainTaskCopy: true,
    });
    expect(f.credential(f.taskVol) === f.initial).toBe(true);
  }
});

it('makes no grant if its durable uncertainty fence cannot be written', async () => {
  const f = fixture();
  f.failFence();
  await refreshExpiringCliCredentials(f.db, f.runner);
  expect(f.fetchMock).not.toHaveBeenCalled();
  await f.adopt();
  expect(f.credential(f.taskVol) === f.initial).toBe(true);
});

it('refuses after a lost response and recovers after a later successful rotation', async () => {
  const f = fixture();
  f.fetchMock.mockRejectedValueOnce(new Error('response lost'));
  await refreshExpiringCliCredentials(f.db, f.runner);
  await expect(f.adopt()).rejects.toMatchObject({ code: 'grok_login_required' });
  await refreshExpiringCliCredentials(f.db, f.runner);
  await f.adopt();
  expect(f.credential(f.taskVol) === f.credential(f.userVol)).toBe(true);
  expect(f.credential(f.taskVol) === f.initial).toBe(false);
});

it('a fresh login resolves uncertainty and replaces an unchanged snapshot', async () => {
  const f = fixture();
  f.fetchMock.mockRejectedValueOnce(new Error('response lost'));
  await refreshExpiringCliCredentials(f.db, f.runner);
  const login = f.raw();
  writeFileSync(join(f.dirs.get(f.userVol)!, 'auth.json'), login);
  await f.adopt();
  expect(f.credential(f.taskVol) === login).toBe(true);
});

it('clears uncertainty after a successful grant that keeps the same refresh token', async () => {
  const f = fixture();
  const token: string = JSON.parse(f.initial)['issuer::client'].refresh_token;
  f.fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: randomBytes(24).toString('hex'), refresh_token: token }),
  });
  await refreshExpiringCliCredentials(f.db, f.runner);
  await f.adopt();
  expect(f.credential(f.taskVol) === f.credential(f.userVol)).toBe(true);
  expect(f.credential(f.taskVol) === f.initial).toBe(false);
});

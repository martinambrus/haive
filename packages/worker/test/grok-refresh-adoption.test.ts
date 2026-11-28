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
import { CliLoginRequiredError } from '../src/queues/cli-exec/_shared.js';
import { classifyDagIssueFailure } from '../src/step-engine/dag-failure-class.js';
import { isFreeRedispatch } from '../src/queues/cli-exec/failure-class.js';
import { refreshExpiringCliCredentials } from '../src/usage-window/credential-refresh.js';
import type { DockerRunner, DockerRunOpts } from '../src/sandbox/docker-runner.js';

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  logger: { child: () => logs },
}));
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
  Object.values(logs).forEach((fn) => fn.mockClear());
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
    authGeneration: randomUUID(),
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
      volumeLoginId: 'none',
    }),
  );
  const task = { id: taskId, status: 'failed' };
  let logins: { id: string; createdAt: Date; metadata: { source: string } }[] = [];
  const statusWrite = vi.fn();
  const db = {
    update: () => ({
      set: (values: unknown) => {
        statusWrite(values);
        return { where: async () => {} };
      },
    }),
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => logins }) }) }),
    }),
    selectDistinct: () => ({ from: () => ({ where: async () => [{ providerId: provider.id }] }) }),
    query: {
      tasks: {
        findMany: vi.fn(async () => [task]),
        findFirst: async () => ({ createdAt: new Date(0), userId: provider.userId }),
      },
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
  let probeExit: number | undefined;
  let probeTimeout = false;
  let failFenceClear = false;
  let failArchive = false;
  const runner = {
    volumeList: async (prefix: string) =>
      [...dirs.keys()].filter((name) => name.startsWith(prefix)),
    volumeHasContainers: async () => false,
    volumeExists: async (name: string) => dirs.has(name),
    volumeLabel: async (name: string) => labels.get(name) ?? null,
    volumeCreate: async (name: string, values: Record<string, string>) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      dirs.set(name, dir);
      labels.set(name, values['haive.auth-source'] ?? values['haive.auth-retired']!);
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
      if (script.includes('cp -a /src/. /dst/') && script.includes('diff') && failArchive)
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 0, timedOut: false };
      if (opts.mounts?.some((m) => m.target === '/x') && (probeExit !== undefined || probeTimeout))
        return {
          exitCode: probeExit ?? 0,
          stdout: '',
          stderr: '',
          durationMs: 0,
          timedOut: probeTimeout,
        };
      if (
        failFenceClear &&
        script.includes('haive-grok-refresh.haive-tmp') &&
        script.includes("printf '%s' 'none'")
      )
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 0, timedOut: false };
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
    provider,
    statusWrite,
    freshLogin: () => {
      provider.authGeneration = randomUUID();
      logins = [
        { id: provider.authGeneration, createdAt: new Date(), metadata: { source: 'volume' } },
      ];
      const bytes = raw();
      writeFileSync(join(dirs.get(userVol)!, 'auth.json'), bytes);
      return bytes;
    },
    probeFailure: (exit: number, timeout = false) => {
      probeExit = exit;
      probeTimeout = timeout;
    },
    failArchive: () => {
      failArchive = true;
    },
    failClear: () => {
      failFenceClear = true;
    },
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
  const otherCtx = { ...f.ctx, userId: randomUUID(), authMode: 'api_key' as const };
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
  expect(await result).toMatchObject({ code: 'cli_auth_busy' });
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
      version: 2,
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

it('surfaces a fenced grant as the existing login error, marks health and halts DAG for user action', async () => {
  const f = fixture();
  f.failWrite();
  await refreshExpiringCliCredentials(f.db, f.runner);
  const error = await f.adopt().catch((error) => error);
  expect(error).toBeInstanceOf(CliLoginRequiredError);
  expect(error.hint).toEqual({
    type: 'cli_login_required',
    providerId: f.ctx.providerId,
    providerName: 'grok',
  });
  expect(error.code).toBe('grok_login_required');
  expect(f.statusWrite).toHaveBeenCalledWith(expect.objectContaining({ authStatus: 'unknown' }));
  expect(classifyDagIssueFailure({ exitCode: -1, errorMessage: error.message })).toBe(
    'environment',
  );
});

it.each(['divergent', 'unlabeled', 'unknown-version', 'missing-marker'])(
  'fresh interactive login preserves then replaces a %s copy',
  async (kind) => {
    const f = fixture();
    const kept = f.raw();
    writeFileSync(join(f.dirs.get(f.taskVol)!, 'auth.json'), kept);
    if (kind === 'unlabeled') f.labels.delete(f.taskVol);
    if (kind === 'unknown-version') f.labels.set(f.taskVol, '{"version":2}');
    if (kind === 'missing-marker') rmSync(join(f.dirs.get(f.taskVol)!, '.haive-source'));
    const login = f.freshLogin();
    await f.adopt();
    expect(f.credential(f.taskVol) === login).toBe(true);
    const retired = [...f.labels].filter(([name]) => name.includes('_retired_'));
    expect(retired).toHaveLength(1);
    expect(f.credential(retired[0]![0]) === kept).toBe(true);
  },
);

it.each(['isolateAuth', 'authMode'])(
  'a %s toggle preserves the old copy and admits the new scope',
  async (field) => {
    const f = fixture();
    if (field === 'isolateAuth') {
      f.ctx.isolateAuth = true;
      f.provider.isolateAuth = true;
      const next = resolveCliAuthUserVolumeName(f.ctx, 0);
      const dir = join(f.root, next);
      mkdirSync(dir);
      f.dirs.set(next, dir);
      writeFileSync(join(dir, 'auth.json'), f.raw());
    } else {
      f.ctx.authMode = 'api_key';
      Object.assign(f.provider, { authMode: 'api_key' });
    }
    await f.adopt();
    const retired = [...f.labels].filter(([name]) => name.includes('_retired_'));
    expect(retired).toHaveLength(1);
    expect(f.credential(retired[0]![0]) === f.initial).toBe(true);
  },
);

it('never removes the original if preserving the recovery copy fails', async () => {
  const f = fixture();
  f.labels.delete(f.taskVol);
  f.freshLogin();
  f.failArchive();
  await expect(f.adopt()).rejects.toMatchObject({ code: 'cli_auth_probe_unknown' });
  expect(f.credential(f.taskVol) === f.initial).toBe(true);
  expect(f.removed).not.toContain(f.taskVol);
});

it('recreates a half-built copy using the exact readiness and population scripts', async () => {
  const f = fixture();
  rmSync(join(f.dirs.get(f.taskVol)!, '.haive-ready'));
  rmSync(join(f.dirs.get(f.taskVol)!, '.haive-source'));
  await f.adopt();
  expect(f.removed).toContain(f.taskVol);
  expect(f.credential(f.taskVol) === f.initial).toBe(true);
  expect(readFileSync(join(f.dirs.get(f.taskVol)!, '.haive-ready'), 'utf8')).toBe('');
});

it('busy admission times out with a free, transient retry then succeeds after login releases', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const scope = cliAuthScope({ ...f.ctx, id: f.ctx.providerId, name: 'grok' });
  held.add(scope);
  const result = f.adopt().catch((error) => error);
  await vi.advanceTimersByTimeAsync(30_000);
  const error = await result;
  expect(error.code).toBe('cli_auth_busy');
  expect(classifyDagIssueFailure({ exitCode: -1, errorMessage: error.message })).toBe('transient');
  expect(isFreeRedispatch({ startedAt: new Date(), errorMessage: error.message })).toBe(true);
  expect(f.statusWrite).not.toHaveBeenCalled();
  held.delete(scope);
  await f.adopt();
});

it.each([125, 126, 127, 4, 0])(
  'probe exit %s (0 with timeout) stays unknown/retryable and keeps the copy',
  async (exit) => {
    const f = fixture();
    f.probeFailure(exit, exit === 0);
    const error = await f.adopt().catch((error) => error);
    expect(error.code).toBe('cli_auth_probe_unknown');
    expect(classifyDagIssueFailure({ exitCode: -1, errorMessage: error.message })).toBe(
      'transient',
    );
    expect(f.statusWrite).not.toHaveBeenCalled();
    expect(f.removed).toEqual([]);
    expect(await syncRefreshedAuthToUserVolumes(f.db, f.taskId, f.runner)).toEqual({
      retainTaskCopy: true,
    });
  },
);

it.each([400, 401, 403, 429, 500, 503])(
  'HTTP %s clears only known unspent-grant fences',
  async (status) => {
    const f = fixture();
    f.fetchMock.mockResolvedValueOnce({
      ok: false,
      status,
      text: async () => '{"error":"temporarily_unavailable"}',
    } as never);
    await refreshExpiringCliCredentials(f.db, f.runner);
    if (status < 500) await f.adopt();
    else await expect(f.adopt()).rejects.toMatchObject({ code: 'grok_login_required' });
  },
);

it('a failed same-token fence clear is reported and retried even before the next refresh is due', async () => {
  const f = fixture();
  const token: string = JSON.parse(f.initial)['issuer::client'].refresh_token;
  f.fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: randomBytes(24).toString('hex'), refresh_token: token }),
  });
  f.failClear();
  await refreshExpiringCliCredentials(f.db, f.runner);
  await refreshExpiringCliCredentials(f.db, f.runner);
  expect(f.fetchMock).toHaveBeenCalledTimes(2);
});

it('missing source credentials ask for login through the existing typed error', async () => {
  const f = fixture();
  rmSync(join(f.dirs.get(f.userVol)!, 'auth.json'));
  const error = await f.adopt().catch((error) => error);
  expect(error).toBeInstanceOf(CliLoginRequiredError);
  expect(error.code).toBe('grok_login_required');
  expect(f.statusWrite).toHaveBeenCalledWith(expect.objectContaining({ authStatus: 'unknown' }));
});

it('measures the scope-lock windows with fixture shell IO and a controlled two-minute login', async () => {
  const f = fixture();
  const acquire = locks.acquire.getMockImplementation()!;
  const measurements: { phase: string; logicalMs: number; wallMs: number }[] = [];
  let phase = 'login';
  locks.acquire.mockImplementation(async (...args) => {
    const lock = await acquire(...args);
    if (!lock) return null;
    const logicalStart = Date.now();
    const wallStart = vi.getRealSystemTime();
    return Object.assign(
      async () => {
        measurements.push({
          phase,
          logicalMs: Date.now() - logicalStart,
          wallMs: vi.getRealSystemTime() - wallStart,
        });
        await lock();
      },
      { assertHeld: lock.assertHeld },
    );
  });
  vi.useFakeTimers();
  const login = await locks.acquire(
    f.db,
    cliAuthScope({ ...f.ctx, id: f.ctx.providerId, name: 'grok' }),
  );
  await vi.advanceTimersByTimeAsync(120_000);
  await login();
  vi.useRealTimers();
  phase = 'refresh';
  await refreshExpiringCliCredentials(f.db, f.runner);
  phase = 'admission';
  await f.adopt();
  expect(measurements.map((row) => row.phase)).toEqual(['login', 'refresh', 'admission']);
  expect(measurements[0]?.logicalMs).toBe(120_000);
  process.stdout.write(`AUTH_LOCK_FIXTURE_MEASUREMENTS ${JSON.stringify(measurements)}\n`);
});

it('an unrelated generation write cannot supersede a newer unharvested copy', async () => {
  const f = fixture();
  const newer = f.raw();
  writeFileSync(join(f.dirs.get(f.taskVol)!, 'auth.json'), newer);
  await refreshExpiringCliCredentials(f.db, f.runner);
  f.provider.authGeneration = randomUUID();
  await expect(f.adopt()).rejects.toMatchObject({ code: 'grok_login_required' });
  expect(f.removed).toEqual([]);
});

it('a failed lock connection is retryable without a login hint or copy mutation', async () => {
  const f = fixture();
  locks.acquire.mockRejectedValueOnce(new Error('fixture auth connection failed'));
  await expect(f.adopt()).rejects.toMatchObject({ code: 'cli_auth_probe_unknown' });
  expect(f.statusWrite).not.toHaveBeenCalled();
  expect(f.removed).toEqual([]);
});

it('waits for an admitted writer before preserving its final unharvested credential', async () => {
  const f = fixture();
  f.freshLogin();
  vi.mocked(f.db.query.cliInvocations.findFirst).mockResolvedValueOnce({
    id: randomUUID(),
  } as never);
  await expect(f.adopt()).rejects.toMatchObject({ code: 'cli_auth_busy' });
  expect([...f.labels.keys()].some((name) => name.includes('_retired_'))).toBe(false);
  const finalCredential = f.raw();
  writeFileSync(join(f.dirs.get(f.taskVol)!, 'auth.json'), finalCredential);
  await f.adopt();
  const retired = [...f.labels.keys()].find((name) => name.includes('_retired_'))!;
  expect(f.credential(retired) === finalCredential).toBe(true);
});

it('a still-mounted ended writer prevents retirement and no archive is created', async () => {
  const f = fixture();
  f.freshLogin();
  f.runner.volumeHasContainers = async () => true;
  await expect(f.adopt()).rejects.toMatchObject({ code: 'cli_auth_busy' });
  expect(f.removed).toEqual([]);
  expect([...f.labels.keys()].some((name) => name.includes('_retired_'))).toBe(false);
});

it('coalesced pending admissions are excluded from the retirement writer check', async () => {
  const f = fixture();
  f.freshLogin();
  const ids = [randomUUID(), randomUUID()];
  const { PgDialect } = await import('drizzle-orm/pg-core');
  vi.mocked(f.db.query.cliInvocations.findFirst).mockImplementation((async (
    query: { where?: unknown } | undefined,
  ) => {
    const parameters = new PgDialect().sqlToQuery(query!.where as import('drizzle-orm').SQL).params;
    expect(parameters).toEqual(expect.arrayContaining(ids));
    return undefined;
  }) as never);
  await Promise.all(ids.map((id) => ensureTaskAuthVolumes(f.ctx, f.taskId, f.runner, f.db, id)));
  expect([...f.labels.keys()].filter((name) => name.includes('_retired_'))).toHaveLength(1);
});

it('a stopped helper cannot permanently pin recovery after a fresh login', async () => {
  const f = fixture();
  f.freshLogin();
  let pinned = true;
  f.runner.removeStoppedContainersUsingVolume = async () => {
    pinned = false;
    return { ok: true, removed: ['fixture-helper'], stderr: '' };
  };
  f.runner.volumeHasContainers = async () => pinned;
  await f.adopt();
  expect(pinned).toBe(false);
  expect([...f.labels.keys()].filter((name) => name.includes('_retired_'))).toHaveLength(1);
});

it('caps retirement at one copy of a scope across successive logins', async () => {
  const f = fixture();
  f.freshLogin();
  await f.adopt();
  f.freshLogin();
  await f.adopt();
  expect([...f.dirs.keys()].filter((name) => name.includes('_retired_'))).toHaveLength(1);
});

it('a failed archive leaves no second volume, including on retry', async () => {
  const f = fixture();
  f.freshLogin();
  f.failArchive();
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(f.adopt()).rejects.toMatchObject({ code: 'cli_auth_probe_unknown' });
    expect([...f.dirs.keys()].filter((name) => name.includes('_retired_'))).toHaveLength(0);
    expect(f.credential(f.taskVol) === f.initial).toBe(true);
  }
});

const untracked = () =>
  logs.warn.mock.calls.filter(([fields]) => fields.reason === 'grok_refresh_untracked');
const unreadable: [string, () => string][] = [
  ['unknown shape', () => JSON.stringify({ future: randomBytes(24).toString('hex') })],
  [
    'truncated JSON',
    () => `{"issuer::client": {"refresh_token": "${randomBytes(8).toString('hex')}`,
  ],
];
const fenceFile = (f: { dirs: Map<string, string>; userVol: string }) =>
  join(f.dirs.get(f.userVol)!, '.haive-grok-refresh');

it.each(
  unreadable.flatMap(([name, make]) =>
    [undefined, 'none'].flatMap((fence) =>
      [false, true].map((login) => ({ name, make, fence: fence ?? 'absent', login })),
    ),
  ),
)(
  'an unreadable credential ($name, fence $fence) is admitted with a coded warning, login=$login',
  async ({ make, fence, login }) => {
    const f = fixture();
    const previous = f.credential(f.taskVol);
    if (login) f.freshLogin();
    writeFileSync(join(f.dirs.get(f.userVol)!, 'auth.json'), make());
    if (fence !== 'absent') writeFileSync(fenceFile(f), fence);
    await f.adopt();
    expect(untracked()).toHaveLength(1);
    expect(f.statusWrite).not.toHaveBeenCalled();
    if (login) {
      const retired = [...f.dirs.keys()].filter((name) => name.includes('_retired_'));
      expect(retired).toHaveLength(1);
      expect(f.credential(retired[0]!)).toBe(previous);
      expect(f.credential(f.taskVol)).toBe(f.credential(f.userVol));
    }
  },
);

it.each(
  unreadable.flatMap(([name, make]) =>
    [randomBytes(32).toString('hex'), 'not-a-fingerprint'].flatMap((fence) =>
      [false, true].map((login) => ({ name, make, fence, login })),
    ),
  ),
)(
  'an unreadable credential ($name) with a fence set stays unknown, login=$login',
  async ({ make, fence, login }) => {
    const f = fixture();
    if (login) f.freshLogin();
    writeFileSync(join(f.dirs.get(f.userVol)!, 'auth.json'), make());
    writeFileSync(fenceFile(f), fence);
    await expect(f.adopt()).rejects.toMatchObject({ code: 'cli_auth_probe_unknown' });
    expect(untracked()).toHaveLength(0);
    expect(f.statusWrite).not.toHaveBeenCalled();
    expect(f.removed).toEqual([]);
    expect([...f.dirs.keys()].filter((name) => name.includes('_retired_'))).toHaveLength(0);
  },
);

it('a recognized credential is admitted without the untracked-refresh warning', async () => {
  const f = fixture();
  f.freshLogin();
  await f.adopt();
  expect(untracked()).toHaveLength(0);
  expect([...f.dirs.keys()].filter((name) => name.includes('_retired_'))).toHaveLength(1);
});

it.each([400, 401, 403, 429])(
  'HTTP %s cannot clear uncertainty from a previous grant',
  async (status) => {
    const f = fixture();
    f.fetchMock.mockRejectedValueOnce(new Error('response lost'));
    await refreshExpiringCliCredentials(f.db, f.runner);
    f.fetchMock.mockResolvedValueOnce({
      ok: false,
      status,
      text: async () => '{"error":"temporarily_unavailable"}',
    } as never);
    await refreshExpiringCliCredentials(f.db, f.runner);
    await expect(f.adopt()).rejects.toMatchObject({ code: 'grok_login_required' });
  },
);

import { beforeEach, describe, expect, it, vi } from 'vitest';

const lock = vi.hoisted(() => ({ release: vi.fn(async () => {}), acquire: vi.fn() }));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: lock.acquire,
}));
import { handleSignOutJob } from '../src/queues/cli-exec-queue.js';
import type { Database } from '@haive/database';
import type {
  DockerRunner,
  DockerRunOpts,
  DockerVolumeOpResult,
} from '../src/sandbox/docker-runner.js';

beforeEach(() => {
  lock.acquire.mockReset().mockResolvedValue(lock.release);
  lock.release.mockClear();
});

interface ProviderRowOverrides {
  id?: string;
  userId?: string;
  name?: string;
  isolateAuth?: boolean;
}

function makeProviderRow(overrides: ProviderRowOverrides = {}) {
  return {
    id: overrides.id ?? 'prov-default',
    userId: overrides.userId ?? 'user-1',
    name: overrides.name ?? 'gemini',
    isolateAuth: overrides.isolateAuth ?? false,
    label: 'test',
    executablePath: null,
    wrapperPath: null,
    envVars: null,
    cliArgs: null,
    supportsSubagents: false,
    networkPolicy: { mode: 'full' as const, domains: [], ips: [] },
    authMode: 'subscription' as const,
    cliVersion: null,
    effortLevel: null,
    sandboxDockerfileExtra: null,
    sandboxImageTag: null,
    sandboxImageBuildStatus: 'idle' as const,
    sandboxImageBuildError: null,
    sandboxImageBuiltAt: null,
    enabled: true,
    authStatus: 'ok' as const,
    authLastCheckedAt: null,
    authMessage: null,
    rulesContent: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    wrapperContent: null,
  };
}

interface DbCalls {
  updateSet: Record<string, unknown> | null;
  deleted?: boolean;
}

function makeDb(row: ReturnType<typeof makeProviderRow> | null, calls: DbCalls): Database {
  return {
    query: {
      cliProviders: {
        async findFirst() {
          return row;
        },
      },
    },
    delete() {
      return {
        where: async () => {
          calls.deleted = true;
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          calls.updateSet = values;
          return {
            where() {
              return Promise.resolve();
            },
          };
        },
      };
    },
  } as unknown as Database;
}

interface MockRunner extends DockerRunner {
  existing: Set<string>;
  removed: string[];
  /** Volume names the container sweep was asked about, in call order. */
  swept: string[];
  /** Interleaved log of sweep/remove calls, so a test can assert the ORDER. */
  order: string[];
}

function makeRunner(
  opts: { existing?: string[]; removeFails?: string[]; sweep?: boolean; sweepFails?: boolean } = {},
): MockRunner {
  const existing = new Set<string>(opts.existing ?? []);
  const removed: string[] = [];
  const swept: string[] = [];
  const order: string[] = [];
  const failSet = new Set<string>(opts.removeFails ?? []);
  return {
    existing,
    removed,
    swept,
    order,
    ...(opts.sweep
      ? {
          async removeStoppedContainersUsingVolume(name: string) {
            swept.push(name);
            order.push(`sweep:${name}`);
            return opts.sweepFails
              ? { ok: false, removed: [], stderr: 'docker ps failed' }
              : { ok: true, removed: ['helper-1'], stderr: '' };
          },
        }
      : {}),
    async build() {
      throw new Error('not used');
    },
    async run(_opts: DockerRunOpts) {
      throw new Error('not used');
    },
    async inspect() {
      return { exists: false, imageId: null };
    },
    async remove() {
      return { ok: true, stderr: '' };
    },
    async volumeCreate(): Promise<DockerVolumeOpResult> {
      return { ok: true, stderr: '' };
    },
    async volumeExists(name: string) {
      return existing.has(name);
    },
    async volumeRemove(name: string): Promise<DockerVolumeOpResult> {
      order.push(`remove:${name}`);
      if (failSet.has(name)) return { ok: false, stderr: 'in use' };
      existing.delete(name);
      removed.push(name);
      return { ok: true, stderr: '' };
    },
  };
}

describe('handleSignOutJob', () => {
  it('returns ok=false silently when provider not found', async () => {
    const calls: DbCalls = { updateSet: null };
    const db = makeDb(null, calls);
    const runner = makeRunner();
    const result = await handleSignOutJob(db, { providerId: 'missing', userId: 'user-1' }, runner);
    expect(result).toEqual({ ok: false, removed: [], failed: [] });
    expect(runner.removed).toEqual([]);
    expect(calls.updateSet).toBeNull();
  });

  it('refuses to act on a provider that belongs to a different user', async () => {
    const calls: DbCalls = { updateSet: null };
    const row = makeProviderRow({ userId: 'owner-A' });
    const db = makeDb(row, calls);
    const runner = makeRunner({ existing: ['haive_cli_auth_user1_gemini_1'] });
    const result = await handleSignOutJob(db, { providerId: row.id, userId: 'attacker-B' }, runner);
    expect(result.ok).toBe(false);
    expect(runner.removed).toEqual([]);
  });

  it('shared (non-isolated) provider removes per-user volume namespace', async () => {
    const userId = 'aaaa-bbbb-cccc-ee';
    const userSlug = 'aaaabbbbccccee'.replace(/-/g, '').slice(0, 12);
    const expectedVolName = `haive_cli_auth_${userSlug}_gemini_1`;
    const calls: DbCalls = { updateSet: null };
    const row = makeProviderRow({ userId, isolateAuth: false });
    const db = makeDb(row, calls);
    // gemini has 2 authConfigPaths; only idx=1 exists.
    const runner = makeRunner({ existing: [expectedVolName] });
    const result = await handleSignOutJob(db, { providerId: row.id, userId }, runner);
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([expectedVolName]);
    expect(calls.updateSet?.authStatus).toBe('unknown');
    expect(calls.updateSet?.authMessage).toBeNull();
  });

  it('reaps stopped auth helpers pinning the volume, before removing it', async () => {
    // A per-user auth volume is only ever removed here, so a helper stranded by a
    // worker killed between `docker create` and `docker start` would otherwise pin it
    // forever and make sign-out the one operation that can never succeed.
    const userId = 'aaaa-bbbb-cccc-ee';
    const volName = `haive_cli_auth_${'aaaabbbbccccee'.replace(/-/g, '').slice(0, 12)}_gemini_1`;
    const calls: DbCalls = { updateSet: null };
    const db = makeDb(makeProviderRow({ userId, isolateAuth: false }), calls);
    const runner = makeRunner({ existing: [volName], sweep: true });
    const result = await handleSignOutJob(db, { providerId: 'prov-default', userId }, runner);
    expect(result.ok).toBe(true);
    expect(runner.swept).toEqual([volName]);
    // Order is the whole point: sweeping after the removal fixes nothing.
    expect(runner.order).toEqual([`sweep:${volName}`, `remove:${volName}`]);
  });

  it('never sweeps a volume it is not going to remove', async () => {
    const userId = 'aaaa-bbbb-cccc-ee';
    const calls: DbCalls = { updateSet: null };
    const db = makeDb(makeProviderRow({ userId, isolateAuth: false }), calls);
    const runner = makeRunner({ existing: [], sweep: true });
    await handleSignOutJob(db, { providerId: 'prov-default', userId }, runner);
    expect(runner.swept).toEqual([]);
  });

  it('still removes the volume when the container sweep fails', async () => {
    // The sweep is a best-effort unblock. A docker ps that errors must not turn a
    // sign-out into a no-op — the removal may well succeed anyway.
    const userId = 'aaaa-bbbb-cccc-ee';
    const volName = `haive_cli_auth_${'aaaabbbbccccee'.replace(/-/g, '').slice(0, 12)}_gemini_1`;
    const calls: DbCalls = { updateSet: null };
    const db = makeDb(makeProviderRow({ userId, isolateAuth: false }), calls);
    const runner = makeRunner({ existing: [volName], sweep: true, sweepFails: true });
    const result = await handleSignOutJob(db, { providerId: 'prov-default', userId }, runner);
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([volName]);
  });

  it('isolated provider removes ONLY per-provider volume, not user-shared', async () => {
    const calls: DbCalls = { updateSet: null };
    const providerId = 'pppp-qqqq-rrrr-ssss';
    const providerSlug = 'ppppqqqqrrrr';
    const userId = 'uuuu-uuuu-uuuu';
    const userSlug = 'uuuuuuuuuuuu';
    const isolatedVol = `haive_cli_auth_p_${providerSlug}_gemini_1`;
    const sharedVol = `haive_cli_auth_${userSlug}_gemini_1`;
    const row = makeProviderRow({ id: providerId, userId, isolateAuth: true });
    const db = makeDb(row, calls);
    const runner = makeRunner({ existing: [isolatedVol, sharedVol] });
    const result = await handleSignOutJob(db, { providerId, userId }, runner);
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([isolatedVol]);
    // Crucially: the shared volume must remain so other providers stay signed in.
    expect(runner.existing.has(sharedVol)).toBe(true);
  });

  it('skips volumes that do not exist (idempotent on already-signed-out)', async () => {
    const calls: DbCalls = { updateSet: null };
    const row = makeProviderRow();
    const db = makeDb(row, calls);
    const runner = makeRunner();
    const result = await handleSignOutJob(db, { providerId: row.id, userId: row.userId }, runner);
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
    // authStatus is still reset on the empty-but-successful path so the UI
    // re-syncs even when the underlying volumes were absent.
    expect(calls.updateSet?.authStatus).toBe('unknown');
  });

  it('reports failed volumes and skips authStatus reset when remove fails', async () => {
    const calls: DbCalls = { updateSet: null };
    const userId = 'failuser-1234';
    const userSlug = 'failuser1234';
    const failVol = `haive_cli_auth_${userSlug}_gemini_0`;
    const row = makeProviderRow({ userId });
    const db = makeDb(row, calls);
    const runner = makeRunner({ existing: [failVol], removeFails: [failVol] });
    const result = await handleSignOutJob(db, { providerId: row.id, userId }, runner);
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([{ name: failVol, stderr: 'in use' }]);
    expect(calls.updateSet).toBeNull();
  });
});

// A job snapshots the completed login, never the start of an attempt.
describe('queued sign-out credential generation', () => {
  it.each(['gemini', 'claude-code'])(
    'preserves a newer %s login, volume, secrets and health',
    async (name) => {
      const calls: DbCalls = { updateSet: null };
      const row = { ...makeProviderRow({ name }), authGeneration: 'new-login' };
      const runner = makeRunner({
        existing: [
          name === 'gemini'
            ? 'haive_cli_auth_user1_gemini_0'
            : 'haive_cli_auth_user1_claude-code_0',
        ],
      });
      const before = [...runner.existing];
      const payload = { providerId: row.id, userId: row.userId, authGeneration: 'old-login' };
      const result = await handleSignOutJob(makeDb(row, calls), payload, runner);
      expect([...runner.existing]).toEqual(before);
      expect(calls.deleted).not.toBe(true);
      expect(calls.updateSet).toBeNull();
      expect(result).toMatchObject({ ok: true, superseded: true, removed: [], failed: [] });
    },
  );

  it('still deletes Claude credentials when no newer login completed (including an abandoned attempt)', async () => {
    const calls: DbCalls = { updateSet: null };
    const row = { ...makeProviderRow({ name: 'claude-code' }), authGeneration: 'same-login' };
    const volume = 'haive_cli_auth_user1_claude-code_0';
    const runner = makeRunner({ existing: [volume] });
    const payload = { providerId: row.id, userId: row.userId, authGeneration: 'same-login' };
    const result = await handleSignOutJob(makeDb(row, calls), payload, runner);
    expect(result.ok).toBe(true);
    expect(runner.existing.size).toBe(0);
    expect(calls.deleted).toBe(true);
    expect(calls.updateSet?.authStatus).toBe('unknown');
  });
});

it('delays without touching credentials while a login may have written but not yet stamped success', async () => {
  lock.acquire.mockResolvedValueOnce(null);
  const calls: DbCalls = { updateSet: null };
  const row = { ...makeProviderRow(), authGeneration: 'prior' };
  const runner = makeRunner({ existing: ['haive_cli_auth_user1_gemini_0'] });
  const job = {
    data: {},
    updateData: vi.fn(async () => {}),
    token: 'token',
    moveToDelayed: vi.fn(async () => {}),
  };
  await expect(
    handleSignOutJob(
      makeDb(row, calls),
      { providerId: row.id, userId: row.userId, authGeneration: 'prior' },
      runner,
      job as any,
    ),
  ).rejects.toMatchObject({ name: 'DelayedError' });
  expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
  expect(runner.removed).toEqual([]);
  expect(calls.updateSet).toBeNull();
  row.authGeneration = 'new-login';
  expect(
    await handleSignOutJob(
      makeDb(row, calls),
      { providerId: row.id, userId: row.userId, authGeneration: 'prior' },
      runner,
    ),
  ).toMatchObject({ superseded: true });
  expect(lock.release).toHaveBeenCalledOnce();
});
it('re-reads generation after taking the lock and releases it on a thrown delete', async () => {
  const calls: DbCalls = { updateSet: null };
  const row = { ...makeProviderRow(), authGeneration: 'prior' };
  lock.acquire.mockImplementationOnce(async () => {
    row.authGeneration = 'new-login';
    return lock.release;
  });
  expect(
    await handleSignOutJob(
      makeDb(row, calls),
      { providerId: row.id, userId: row.userId, authGeneration: 'prior' },
      makeRunner(),
    ),
  ).toMatchObject({ superseded: true });
  expect(lock.release).toHaveBeenCalledOnce();
  lock.release.mockClear();
  const claude = makeProviderRow({ name: 'claude-code' });
  const db = makeDb(claude, calls);
  vi.spyOn(db, 'delete').mockImplementation(() => {
    throw new Error('delete refused');
  });
  await expect(
    handleSignOutJob(db, { providerId: claude.id, userId: claude.userId }, makeRunner()),
  ).rejects.toThrow('delete refused');
  expect(lock.release).toHaveBeenCalledOnce();
});

it('retries under the new scope when auth settings changed while the lock was taken', async () => {
  const calls: DbCalls = { updateSet: null };
  const row = { ...makeProviderRow(), authGeneration: 'prior' };
  lock.acquire.mockImplementationOnce(async () => {
    row.isolateAuth = true;
    return lock.release;
  });
  const runner = makeRunner({
    existing: ['haive_cli_auth_user1_gemini_0', 'haive_cli_auth_prov-default_gemini_0'],
  });
  const job = { data: {}, token: 'token', moveToDelayed: vi.fn(async () => {}) };
  await expect(
    handleSignOutJob(
      makeDb(row, calls),
      { providerId: row.id, userId: row.userId, authGeneration: 'prior' },
      runner,
      job as any,
    ),
  ).rejects.toMatchObject({ name: 'DelayedError' });
  expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
  expect(runner.removed).toEqual([]);
  expect(calls.updateSet).toBeNull();
  expect(lock.release).toHaveBeenCalledOnce();
  expect(lock.acquire).toHaveBeenCalledWith(expect.anything(), 'haive_cli_auth_user1_gemini_0');
});

it('keeps deletion behavior for legacy jobs without a generation even after a newer login', async () => {
  const row = { ...makeProviderRow({ name: 'claude-code' }), authGeneration: 'new-login' };
  const calls: DbCalls = { updateSet: null };
  const runner = makeRunner({ existing: ['haive_cli_auth_user1_claude-code_0'] });
  expect(
    (await handleSignOutJob(makeDb(row, calls), { providerId: row.id, userId: row.userId }, runner))
      .ok,
  ).toBe(true);
  expect(runner.existing.size).toBe(0);
  expect(calls.deleted).toBe(true);
  expect(calls.updateSet?.authStatus).toBe('unknown');
});

it('backs off contended sign-out from two seconds to fifteen seconds', async () => {
  vi.useFakeTimers();
  try {
    lock.acquire.mockResolvedValue(null);
    const row = makeProviderRow();
    const calls: DbCalls = { updateSet: null };
    const job = {
      timestamp: Date.now(),
      token: 'token',
      data: {},
      updateData: vi.fn(async (data: unknown) => {
        job.data = data as typeof job.data;
      }),
      moveToDelayed: vi.fn(async () => {}),
    };
    for (const delay of [2000, 4000, 8000, 15000, 15000]) {
      await expect(
        handleSignOutJob(
          makeDb(row, calls),
          { providerId: row.id, userId: row.userId },
          makeRunner(),
          job as any,
        ),
      ).rejects.toMatchObject({ name: 'DelayedError' });
      expect(job.moveToDelayed).toHaveBeenLastCalledWith(Date.now() + delay, 'token');
    }
  } finally {
    vi.useRealTimers();
  }
});
it('fails after thirty minutes of auth contention without removing anything', async () => {
  lock.acquire.mockResolvedValue(null);
  const row = makeProviderRow();
  const calls: DbCalls = { updateSet: null };
  const runner = makeRunner({ existing: ['haive_cli_auth_user1_gemini_0'] });
  const now = Date.now();
  const job = {
    token: 'token',
    data: { authContentionStartedAt: now - 30 * 60_000, authContentionAttempts: 123 },
    updateData: vi.fn(),
    moveToDelayed: vi.fn(),
  };
  await expect(
    handleSignOutJob(
      makeDb(row, calls),
      { providerId: row.id, userId: row.userId },
      runner,
      job as any,
    ),
  ).rejects.toThrow(
    'A CLI sign-in or credential update kept this account busy. Nothing was removed.',
  );
  expect(job.moveToDelayed).not.toHaveBeenCalled();
  expect(runner.removed).toEqual([]);
  expect(calls.updateSet).toBeNull();
});

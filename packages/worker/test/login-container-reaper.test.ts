import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startCliLoginLease, cliLoginLeaseKey } from '@haive/shared/cli-login-lease';
import {
  LEGACY_LOGIN_GRACE_MS,
  sweepLoginContainers,
  startLoginContainerReaper,
} from '../src/sandbox/login-container-reaper.js';

let token: string | null;
let expires: number;
const redis = {
  set: vi.fn(async (_key: string, value: string, _px: string, ttl: number) => {
    token = value;
    expires = Date.now() + ttl;
    return 'OK';
  }),
  eval: vi.fn(async (script: string, _n: number, _key: string, value: string, ttl?: number) => {
    if (token !== value || Date.now() >= expires) return 0;
    if (script.includes('pexpire')) expires = Date.now() + ttl!;
    else token = null;
    return 1;
  }),
  mget: vi.fn(async (...keys: string[]) => keys.map(() => (Date.now() < expires ? token : null))),
};
const remove = vi.fn(async (_id: string) => {});
let candidates: { id: string; createdAt: number; leaseId?: string }[];
const deps = { list: async () => candidates, remove };
const sweep = () => sweepLoginContainers(redis as never, deps, { graceMs: 100 });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  token = null;
  expires = 0;
  candidates = [];
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('pins the upgrade grace beyond startup, login and bounded teardown', () => {
  expect(LEGACY_LOGIN_GRACE_MS).toBe(13 * 60_000);
});
it('never reaps an owner renewing for longer than its TTL', async () => {
  const lease = await startCliLoginLease(redis as never, vi.fn(), { ttlMs: 60, heartbeatMs: 20 });
  candidates = [{ id: 'login', createdAt: 0, leaseId: lease.id }];
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(40);
    await sweep();
  }
  expect(remove).not.toHaveBeenCalled();
  await lease.stop();
});
it('reaps after a dead owner stops renewing and its TTL passes', async () => {
  const lease = await startCliLoginLease(redis as never, vi.fn(), { ttlMs: 60, heartbeatMs: 20 });
  candidates = [{ id: 'login', createdAt: Date.now(), leaseId: lease.id }];
  const diedAt = Date.now();
  vi.clearAllTimers();
  vi.setSystemTime(diedAt + 59);
  await sweep();
  expect(remove).not.toHaveBeenCalled();
  vi.setSystemTime(diedAt + 61);
  await sweep();
  expect(remove).toHaveBeenCalledExactlyOnceWith('login');
});
it('removes nothing in the entire pass when Redis is unreadable', async () => {
  candidates = [
    { id: 'orphan', createdAt: 0, leaseId: 'old' },
    { id: 'legacy', createdAt: 0 },
  ];
  redis.mget.mockRejectedValueOnce(new Error('Redis down'));
  await sweep();
  expect(remove).not.toHaveBeenCalled();
});
it('keeps a pre-existing unleased container inside its creation grace, then reaps it', async () => {
  candidates = [{ id: 'legacy', createdAt: Date.now() }];
  await vi.advanceTimersByTimeAsync(99);
  await sweep();
  expect(remove).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  await sweep();
  expect(remove).toHaveBeenCalledExactlyOnceWith('legacy');
});
it('a reaped scope can immediately start a fresh login', async () => {
  candidates = [{ id: 'old', createdAt: 0, leaseId: 'old-attempt' }];
  await sweep();
  expect(remove).toHaveBeenCalledExactlyOnceWith('old');
  const lease = await startCliLoginLease(redis as never, vi.fn(), { ttlMs: 60, heartbeatMs: 20 });
  candidates = [{ id: 'fresh', createdAt: Date.now(), leaseId: lease.id }];
  await sweep();
  expect(remove).toHaveBeenCalledOnce();
  expect(redis.mget).toHaveBeenLastCalledWith(cliLoginLeaseKey(lease.id));
  await lease.stop();
});
it('runs serial periodic sweeps and stops scheduling on shutdown', async () => {
  const list = vi.fn(async () => []);
  const stop = startLoginContainerReaper(redis as never, { list, remove }, { intervalMs: 20 });
  await vi.advanceTimersByTimeAsync(60);
  expect(list).toHaveBeenCalledTimes(4); // immediate boot pass plus periodic passes
  stop();
  await vi.advanceTimersByTimeAsync(60);
  expect(list).toHaveBeenCalledTimes(4);
});

it('discovers labelled logins for this install and exact legacy ids, including destroyed rows', async () => {
  const { loginContainerReaperDeps } = await import('../src/sandbox/login-container-reaper.js');
  const { CLI_LOGIN_LABEL, CLI_LOGIN_LEASE_LABEL } = await import('@haive/shared/cli-login-lease');
  const { INSTALL_LABEL, installId } = await import('@haive/shared');
  const labelled = {
    Id: 'labelled',
    Created: 1,
    Labels: {
      [CLI_LOGIN_LABEL]: '1',
      [CLI_LOGIN_LEASE_LABEL]: 'attempt',
      [INSTALL_LABEL]: installId(),
    },
  };
  const other = {
    ...labelled,
    Id: 'other',
    Labels: { ...labelled.Labels, [INSTALL_LABEL]: 'other_install' },
  };
  const old = { Id: 'legacy', Created: 2, Labels: {} };
  const ordinary = { Id: 'ordinary', Created: 3, Labels: {} };
  const docker = {
    listContainers: vi.fn(async (opts) =>
      opts.filters ? [labelled, other] : [labelled, other, old, ordinary],
    ),
  };
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ dockerContainerId: 'legacy' }] }) }),
  };
  const found = await loginContainerReaperDeps(db as never, docker as never).list();
  expect(found).toEqual([
    { id: 'labelled', createdAt: 1000, leaseId: 'attempt' },
    { id: 'legacy', createdAt: 2000, leaseId: undefined },
  ]);
  expect(docker.listContainers.mock.calls[0]![0]).toMatchObject({
    all: true,
    filters: { label: [`${CLI_LOGIN_LABEL}=1`, `${INSTALL_LABEL}=${installId()}`] },
  });
});
it('only marks a container destroyed after Docker removal succeeds or reports it gone', async () => {
  const { loginContainerReaperDeps } = await import('../src/sandbox/login-container-reaper.js');
  const destroy = vi.fn(async () => {});
  const rm = vi
    .fn()
    .mockRejectedValueOnce(new Error('Docker unavailable'))
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce({ statusCode: 404 });
  const db = { update: () => ({ set: () => ({ where: destroy }) }) };
  const deps = loginContainerReaperDeps(
    db as never,
    { getContainer: () => ({ remove: rm }) } as never,
  );
  await expect(deps.remove('orphan')).rejects.toThrow('Docker unavailable');
  expect(destroy).not.toHaveBeenCalled();
  await deps.remove('orphan');
  await deps.remove('gone');
  expect(destroy).toHaveBeenCalledTimes(2);
});
it('retries a failed removal on the next pass and continues with other orphans', async () => {
  candidates = [
    { id: 'first', createdAt: 0 },
    { id: 'second', createdAt: 0 },
  ];
  remove.mockRejectedValueOnce(new Error('Docker busy'));
  expect(await sweep()).toBe(1);
  expect(await sweep()).toBe(2);
});
it('does not overlap a slow sweep with the next periodic pass', async () => {
  let finish!: (value: []) => void;
  const list = vi.fn(
    () =>
      new Promise<[]>((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startLoginContainerReaper(redis as never, { list, remove }, { intervalMs: 20 });
  await vi.advanceTimersByTimeAsync(60);
  expect(list).toHaveBeenCalledOnce();
  stop();
  finish([]);
  await vi.advanceTimersByTimeAsync(60);
  expect(list).toHaveBeenCalledOnce();
});

it('labels Docker creation with the API attempt lease before persisting its row', async () => {
  const { createSandboxLoginContainer } = await import('../src/sandbox/login-container.js');
  const { cliAdapterRegistry } = await import('../src/cli-adapters/registry.js');
  const { CLI_LOGIN_LABEL, CLI_LOGIN_LEASE_LABEL } = await import('@haive/shared/cli-login-lease');
  const { INSTALL_LABEL, installId } = await import('@haive/shared');
  vi.spyOn(cliAdapterRegistry, 'has').mockReturnValue(true);
  const createContainer = vi.fn(async () => ({ id: 'new-login', remove: vi.fn() }));
  const db = { insert: () => ({ values: () => ({ returning: async () => [{ id: 'row' }] }) }) };
  await createSandboxLoginContainer(db as never, {
    leaseId: 'api-attempt',
    provider: {
      id: 'provider',
      userId: 'user',
      name: 'codex',
      authMode: 'subscription',
      isolateAuth: false,
      sandboxImageBuildStatus: 'ready',
      sandboxImageTag: 'test-image',
    } as never,
    commandSpec: { command: 'codex', args: ['login'], env: {} },
    docker: { createContainer } as never,
  });
  expect(createContainer).toHaveBeenCalledWith(
    expect.objectContaining({
      Labels: {
        [CLI_LOGIN_LABEL]: '1',
        [CLI_LOGIN_LEASE_LABEL]: 'api-attempt',
        [INSTALL_LABEL]: installId(),
      },
    }),
  );
});

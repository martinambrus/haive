import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { INSTALL_LABEL, installId } from '@haive/shared';
import {
  CHECKOUT_DRAIN_TIMEOUT_MS,
  CHECKOUT_TRANSPORT_TIMEOUT_MS,
  CHECKOUT_DOCKER_TIMEOUT_MS,
  CHECKOUT_SESSION_RETRY_MS,
  interactiveCheckouts,
  registerCheckoutTerminalCloser,
  suspendCheckoutSessions,
  CHECKOUT_SESSION_DEFER_MAX_MS,
  checkoutSessionCanRetry,
  InteractiveCheckoutBarrier,
  CheckoutSessionsBusyError,
  stopCheckoutContainers,
} from '../src/repo/interactive-checkout.js';

const transports = vi.hoisted(() => ({ set: vi.fn(), docker: {} as unknown }));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ set: transports.set }) }));
vi.mock('dockerode', () => ({
  default: vi.fn(function () {
    return transports.docker;
  }),
}));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('replacement lifecycle barrier', () => {
  it('drains a delayed open, refuses late attachment and admits explicit reopening', async () => {
    const barrier = new InteractiveCheckoutBarrier();
    const boot = gate();
    const entered = gate();
    let ready = true;
    const writes: string[] = [];
    const open = barrier.open(
      'repo',
      async () => {
        if (!ready) throw new Error('unavailable');
      },
      async (check) => {
        entered.release();
        await boot.promise;
        await check();
        writes.push('old attachment');
      },
    );
    const rejected = expect(open).rejects.toMatchObject({ code: 'checkout_unavailable' });
    await entered.promise;
    ready = false; // committed cloning, before close/rename
    let stopped = false;
    const suspension = barrier.suspend('repo', async () => {
      stopped = true;
    });
    expect(stopped).toBe(false);
    await expect(
      barrier.open(
        'repo',
        async () => {},
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'checkout_unavailable' });
    boot.release();
    await rejected;
    const release = await suspension;
    expect(stopped).toBe(true);
    expect(writes).toEqual([]);
    await expect(
      barrier.open(
        'repo',
        async () => {},
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'checkout_unavailable' });
    ready = true;
    release();
    await barrier.open(
      'repo',
      async () => {},
      async () => {
        writes.push('new checkout');
      },
    );
    expect(writes).toEqual(['new checkout']);
  });

  it('drains a failed boot and keeps unrelated repositories open', async () => {
    const barrier = new InteractiveCheckoutBarrier();
    const boot = gate();
    const entered = gate();
    const open = barrier.open(
      'repo',
      async () => {},
      async () => {
        entered.release();
        await boot.promise;
        throw new Error('failed boot');
      },
    );
    const rejected = expect(open).rejects.toThrow('failed boot');
    await entered.promise;
    const stop = vi.fn();
    const suspension = barrier.suspend('repo', stop);
    await barrier.open(
      'other',
      async () => {},
      async () => {},
    );
    boot.release();
    await rejected;
    (await suspension)();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('releases a failed suspension so a deferred rebuild can retry', async () => {
    const barrier = new InteractiveCheckoutBarrier();
    await expect(
      barrier.suspend('repo', async () => {
        throw new Error('unknown');
      }),
    ).rejects.toThrow('unknown');
    (await barrier.suspend('repo', async () => {}))();
  });
});

function fixture() {
  const fake = createFakeDb({ tasks: schema.tasks });
  fake.insert(schema.tasks, {
    id: '00000000-0000-4000-8000-000000000001',
    repositoryId: '00000000-0000-4000-8000-000000000002',
    status: 'failed',
  });
  const containers = [
    {
      Id: 'repo-shell',
      Labels: {
        [INSTALL_LABEL]: installId(),
        'haive.role': 'terminal-shell',
        'haive.repository.id': '00000000-0000-4000-8000-000000000002',
      },
    },
    {
      Id: 'warm-shell',
      Labels: {
        [INSTALL_LABEL]: installId(),
        'haive.role': 'terminal-shell',
        'haive.task.id': '00000000-0000-4000-8000-000000000001',
      },
    },
    {
      Id: 'editor',
      Labels: {
        [INSTALL_LABEL]: installId(),
        'haive.ide': '1',
        'haive.repo.id': '00000000-0000-4000-8000-000000000002',
      },
    },
    {
      Id: 'runtime',
      Labels: {
        [INSTALL_LABEL]: installId(),
        'haive.ddev': '1',
        'haive.task.id': '00000000-0000-4000-8000-000000000001',
      },
    },
    {
      Id: 'other',
      Labels: { [INSTALL_LABEL]: installId(), 'haive.ide': '1', 'haive.repo.id': 'other' },
    },
  ];
  const live = new Set(containers.map((c) => c.Id));
  const stop = vi.fn(async (_id: string, _opts?: unknown) => {});
  const remove = vi.fn(async (id: string, _opts?: unknown) => {
    live.delete(id);
  });
  const docker = {
    listContainers: vi.fn(async () => containers.filter((c) => live.has(c.Id))),
    getContainer: (id: string) => ({
      inspect: async (): Promise<{
        HostConfig: { Mounts: { VolumeOptions: { Subpath: string } }[] };
        Mounts: never[];
      }> => ({ HostConfig: { Mounts: [] }, Mounts: [] }),
      stop: (opts: unknown) => stop(id, opts),
      remove: (opts: unknown) => remove(id, opts),
    }),
  };
  return { db: fake.db as unknown as Database, docker, stop, remove, containers, live };
}

describe('strict stop before rename', () => {
  it('stops attached and detached shells, Editor and failed-task root runtime; removes anonymous volumes, preserves named volumes and unrelated repositories', async () => {
    const h = fixture();
    await stopCheckoutContainers(h.db, '00000000-0000-4000-8000-000000000002', h.docker as never);
    expect(h.live).toEqual(new Set(['other']));
    expect(h.stop.mock.calls.map(([id]) => id)).toEqual([
      'repo-shell',
      'warm-shell',
      'editor',
      'runtime',
    ]);
    for (const [, options] of h.remove.mock.calls)
      expect(options).toEqual({ force: false, v: true });
    expect(h.docker.listContainers).toHaveBeenCalledWith({ all: true });
  });

  it.each(['listing', 'stop', 'remove', 'verification'] as const)(
    'defers on unknown/failed Docker %s, before rename',
    async (failure) => {
      const h = fixture();
      const error = Object.assign(new Error('arbitrary wording'), { statusCode: 503 });
      if (failure === 'listing') h.docker.listContainers.mockRejectedValue(error);
      if (failure === 'stop') h.stop.mockRejectedValue(error);
      if (failure === 'remove') h.remove.mockRejectedValue(error);
      if (failure === 'verification') h.remove.mockImplementation(async () => {});
      const rename = vi.fn();
      await expect(
        stopCheckoutContainers(
          h.db,
          '00000000-0000-4000-8000-000000000002',
          h.docker as never,
        ).then(rename),
      ).rejects.toBeInstanceOf(CheckoutSessionsBusyError);
      expect(rename).not.toHaveBeenCalled();
    },
  );

  it('does not remove a matching container carrying a foreign install label', async () => {
    const h = fixture();
    h.containers[0]!.Labels[INSTALL_LABEL] = 'foreign';
    await expect(
      stopCheckoutContainers(h.db, '00000000-0000-4000-8000-000000000002', h.docker as never),
    ).rejects.toBeInstanceOf(CheckoutSessionsBusyError);
    expect(h.remove).not.toHaveBeenCalled();
  });
});

it('finds a legacy detached shell by its mount after its task row is gone', async () => {
  const h = fixture();
  const old = h.containers[1]!;
  old.Labels['haive.task.id'] = 'deleted-task';
  const getContainer = h.docker.getContainer;
  h.docker.getContainer = (id: string) => ({
    ...getContainer(id),
    inspect: async () => ({
      HostConfig: {
        Mounts: [{ VolumeOptions: { Subpath: 'user/00000000-0000-4000-8000-000000000002' } }],
      },
      Mounts: [],
    }),
  });
  await stopCheckoutContainers(h.db, '00000000-0000-4000-8000-000000000002', h.docker as never);
  expect(h.live).toEqual(new Set(['other']));
});

it('bounds a hung open drain without stopping or moving, then permits a retry after it settles', async () => {
  vi.useFakeTimers();
  try {
    const barrier = new InteractiveCheckoutBarrier();
    const entered = gate();
    const boot = gate();
    const open = barrier.open(
      'repo',
      async () => {},
      async () => {
        entered.release();
        await boot.promise;
      },
    );
    await entered.promise;
    const stop = vi.fn();
    const pending = barrier.suspend('repo', stop, 10);
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'drain_timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(stop).not.toHaveBeenCalled();
    boot.release();
    await open;
    (await barrier.suspend('repo', stop, 10))();
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('pins production drain and total defer bounds and refuses exactly at the deadline', () => {
  expect(CHECKOUT_DRAIN_TIMEOUT_MS).toBe(30_000);
  expect(CHECKOUT_SESSION_DEFER_MAX_MS).toBe(30 * 60_000);
  expect(
    checkoutSessionCanRetry('docker_unknown', 100, 100 + CHECKOUT_SESSION_DEFER_MAX_MS - 1),
  ).toBe(true);
  expect(checkoutSessionCanRetry('docker_unknown', 100, 100 + CHECKOUT_SESSION_DEFER_MAX_MS)).toBe(
    false,
  );
  expect(checkoutSessionCanRetry('foreign_container', 100, 101)).toBe(false);
});

describe('suspension phase deadlines', () => {
  const repositoryId = '00000000-0000-4000-8000-000000000002';
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each(['epoch', 'closer'] as const)(
    'bounds a stalled %s, releases admission and fences its late continuation',
    async (phase) => {
      vi.useFakeTimers();
      const h = fixture();
      transports.docker = h.docker;
      const delayed = gate();
      transports.set.mockImplementation(async () => {
        if (phase === 'epoch') await delayed.promise;
        return 'OK';
      });
      const close = vi.fn(async () => {
        if (phase === 'closer') await delayed.promise;
      });
      const unregister = registerCheckoutTerminalCloser(close);
      const nextClose = vi.fn(async () => {});
      const unregisterNext = registerCheckoutTerminalCloser(nextClose);
      const pending = suspendCheckoutSessions(h.db, repositoryId, { transportTimeoutMs: 10 });
      let failure: unknown;
      const settled = vi.fn();
      const observed = pending.then(
        (release) => {
          release();
          settled();
        },
        (error: unknown) => {
          failure = error;
          settled();
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(9);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toHaveBeenCalledOnce();
        expect(failure).toMatchObject({ reason: 'session_transport_unknown' });
        expect(
          checkoutSessionCanRetry((failure as CheckoutSessionsBusyError).reason, Date.now()),
        ).toBe(true);
        expect(h.docker.listContainers).not.toHaveBeenCalled();
        // A thrown stop callback must release the process-local admission fence.
        await interactiveCheckouts.open(
          repositoryId,
          async () => {},
          async () => {},
        );
        unregister();
        unregisterNext();
        transports.set.mockResolvedValue('OK');
        const release = await suspendCheckoutSessions(h.db, repositoryId, {
          transportTimeoutMs: 10,
        });
        release();
        h.docker.listContainers.mockClear();
        delayed.release();
        await observed;
        await vi.advanceTimersByTimeAsync(0);
        expect(nextClose).not.toHaveBeenCalled();
        expect(h.docker.listContainers).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        unregister();
        unregisterNext();
        delayed.release();
        await observed;
      }
    },
  );

  it.each(['listing', 'stop', 'remove', 'verification'] as const)(
    'bounds stalled Docker %s and prevents late calls from advancing an expired attempt',
    async (phase) => {
      vi.useFakeTimers();
      const h = fixture();
      transports.docker = h.docker;
      transports.set.mockResolvedValue('OK');
      const delayed = gate();
      if (phase === 'listing')
        h.docker.listContainers.mockImplementationOnce(async () => {
          await delayed.promise;
          return h.containers;
        });
      if (phase === 'stop') h.stop.mockImplementationOnce(async () => delayed.promise);
      if (phase === 'remove') h.remove.mockImplementationOnce(async () => delayed.promise);
      if (phase === 'verification')
        h.docker.listContainers
          .mockImplementationOnce(async () => h.containers)
          .mockImplementationOnce(async () => {
            await delayed.promise;
            return [];
          });
      const pending = suspendCheckoutSessions(h.db, repositoryId, { dockerTimeoutMs: 20 });
      let failure: unknown;
      const settled = vi.fn();
      const observed = pending.then(
        (release) => {
          release();
          settled();
        },
        (error: unknown) => {
          failure = error;
          settled();
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(19);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toHaveBeenCalledOnce();
        expect(failure).toMatchObject({ reason: 'docker_unknown' });
        expect(
          checkoutSessionCanRetry((failure as CheckoutSessionsBusyError).reason, Date.now()),
        ).toBe(true);
        // Retry succeeds while the earlier Docker request is still outstanding.
        (await suspendCheckoutSessions(h.db, repositoryId, { dockerTimeoutMs: 20 }))();
        const calls = [
          h.stop.mock.calls.length,
          h.remove.mock.calls.length,
          h.docker.listContainers.mock.calls.length,
        ];
        delayed.release();
        await observed;
        await vi.advanceTimersByTimeAsync(0);
        expect([
          h.stop.mock.calls.length,
          h.remove.mock.calls.length,
          h.docker.listContainers.mock.calls.length,
        ]).toEqual(calls);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        delayed.release();
        await observed;
      }
    },
  );

  it('preserves epoch, closer and stop ordering and clears successful phase timers', async () => {
    vi.useFakeTimers();
    const h = fixture();
    transports.docker = h.docker;
    const events: string[] = [];
    transports.set.mockImplementation(async () => {
      events.push('epoch');
      return 'OK';
    });
    const unregister = registerCheckoutTerminalCloser(async () => {
      events.push('closer');
      expect(h.stop).not.toHaveBeenCalled();
    });
    try {
      const release = await suspendCheckoutSessions(h.db, repositoryId);
      expect(events).toEqual(['epoch', 'closer']);
      expect(transports.set).toHaveBeenCalledWith(
        `repo-interactive-epoch:${repositoryId}`,
        expect.any(String),
      );
      expect(h.live).toEqual(new Set(['other']));
      expect(vi.getTimerCount()).toBe(0);
      await expect(
        interactiveCheckouts.open(
          repositoryId,
          async () => {},
          async () => {},
        ),
      ).rejects.toMatchObject({ code: 'checkout_unavailable' });
      release();
      await interactiveCheckouts.open(
        repositoryId,
        async () => {},
        async () => {},
      );
    } finally {
      unregister();
    }
  });

  it('observes an abandoned transport rejection without restarting closure', async () => {
    vi.useFakeTimers();
    const h = fixture();
    transports.docker = h.docker;
    let reject!: (error: Error) => void;
    transports.set.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const pending = suspendCheckoutSessions(h.db, repositoryId, { transportTimeoutMs: 10 });
    let failure: unknown;
    const observed = pending.catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(failure).toMatchObject({ reason: 'session_transport_unknown' });
    reject(new Error('late Redis rejection'));
    await observed;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pins production transport/Docker deadlines and the queue retry cadence', () => {
    expect(CHECKOUT_TRANSPORT_TIMEOUT_MS).toBe(10_000);
    expect(CHECKOUT_DOCKER_TIMEOUT_MS).toBe(5 * 60_000);
    expect(CHECKOUT_SESSION_RETRY_MS).toBe(30_000);
    for (const reason of ['session_transport_unknown', 'docker_unknown']) {
      expect(checkoutSessionCanRetry(reason, 100, 100 + CHECKOUT_SESSION_DEFER_MAX_MS - 1)).toBe(
        true,
      );
      expect(checkoutSessionCanRetry(reason, 100, 100 + CHECKOUT_SESSION_DEFER_MAX_MS)).toBe(false);
    }
  });
});

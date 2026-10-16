import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_REPLY_CHANNEL_PREFIX, TERMINAL_REQUEST_CHANNEL } from '@haive/shared';

const h = vi.hoisted(() => {
  const log = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return { log };
});

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  logger: h.log,
}));
vi.mock('../src/queues/cli-exec-queue.js', () => ({
  resolveRepoMount: vi.fn(),
  resolveTaskRepoMount: vi.fn(),
  resolveTaskSandboxWorkdir: vi.fn(),
}));
vi.mock('../src/queues/cli-exec/gitfile-mask.js', () => ({
  repoGitDataBoundary: vi.fn(),
}));
vi.mock('../src/terminal/terminal-container.js', () => ({
  ensureShellContainer: vi.fn(),
  seedShellTrust: vi.fn(),
}));

import { TerminalSessionManager } from '../src/terminal/terminal-session-manager.js';

const STOP_WAIT_MS = 5_000;

const track = (promise: Promise<unknown>) => {
  const state = { settled: false };
  const settle = () => {
    state.settled = true;
  };
  void promise.then(settle, settle);
  return state;
};

async function startedManager(unsubscribe: (...channels: string[]) => Promise<unknown>) {
  const subscriber = {
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(unsubscribe),
    on: vi.fn(),
  };
  const publish = vi.fn(async (_channel: string, _message: string) => 1);
  const mgr = new TerminalSessionManager({
    db: {} as never,
    redis: { publish } as never,
    subscriberRedis: subscriber as never,
    docker: {} as never,
  });
  await mgr.start();
  const sessions = (mgr as unknown as { sessions: Map<string, unknown> }).sessions;
  const addSession = (id: string): PassThrough => {
    const ptyStream = new PassThrough();
    sessions.set(id, {
      sessionId: id,
      containerName: `haive-shell-${id}`,
      ptyStream,
      inChannel: `in:${id}`,
      ctlChannel: `ctl:${id}`,
    });
    return ptyStream;
  };
  return { mgr, subscriber, publish, addSession };
}

describe('terminal manager stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns at its deadline when a session teardown never ends, naming the sessions it left', async () => {
    const { mgr, addSession } = await startedManager(() => new Promise(() => {}));
    addSession('s1');
    addSession('s2');

    const stopped = track(mgr.stop());
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS - 1);
    expect(stopped.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(stopped.settled).toBe(true);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessions: ['s2'], waitMs: STOP_WAIT_MS }),
      expect.any(String),
    );
  });

  it('returns at its deadline when the request channel unsubscribe never ends', async () => {
    const { mgr } = await startedManager(() => new Promise(() => {}));

    const stopped = track(mgr.stop());
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS);
    expect(stopped.settled).toBe(true);
  });

  it('tears every session down and returns at once when Redis answers', async () => {
    const { mgr, subscriber, addSession } = await startedManager(async () => 1);
    const s1 = addSession('s1');
    const s2 = addSession('s2');

    await mgr.stop();

    expect(s1.destroyed).toBe(true);
    expect(s2.destroyed).toBe(true);
    expect(subscriber.unsubscribe.mock.calls).toEqual([
      ['in:s1', 'ctl:s1'],
      ['in:s2', 'ctl:s2'],
      [TERMINAL_REQUEST_CHANNEL],
    ]);
    expect(h.log.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers an open request that lands after stop began, and opens nothing', async () => {
    const { mgr, subscriber, publish } = await startedManager(() => new Promise(() => {}));
    const openSession = vi
      .spyOn(mgr as unknown as { openSession: () => Promise<unknown> }, 'openSession')
      .mockResolvedValue({
        ok: true,
        sessionId: 's9',
        containerName: 'haive-shell-s9',
        shell: 'bash',
      });
    const onMessage = subscriber.on.mock.calls[0]![1] as (channel: string, raw: string) => void;

    void mgr.stop();
    onMessage(
      TERMINAL_REQUEST_CHANNEL,
      JSON.stringify({
        op: 'open',
        correlationId: 'c1',
        userId: 'u1',
        cliProviderId: 'p1',
        taskId: 't1',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(openSession).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, message] = publish.mock.calls[0]!;
    expect(channel).toBe(`${TERMINAL_REPLY_CHANNEL_PREFIX}c1`);
    expect(JSON.parse(message)).toEqual({ ok: false, error: expect.any(String) });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { runDeviceSignIn, type DevicePoll, type DeviceStart } from './device-sign-in';
import type { IntegrationConnection } from './integrations';

const connection: IntegrationConnection = {
  id: 'conn-1',
  providerId: 'github',
  accountLabel: 'octocat',
  authMethod: 'device',
  grantedScopes: ['repo'],
  status: 'connected',
  lastError: null,
  repoCredentialId: 'cred-1',
  expiresAt: null,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:00:00.000Z',
};

const begun = (over: Partial<DeviceStart> = {}): DeviceStart => ({
  handle: 'handle-1',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://github.com/login/device',
  expiresIn: 900,
  interval: 5,
  ...over,
});

/** Time moves only when the loop waits, so a deadline is reached by waiting, not by sleeping. */
function harness(
  over: {
    start?: DeviceStart;
    polls?: DevicePoll[];
    live?: () => boolean;
    onWait?: (ms: number) => void;
  } = {},
) {
  let clock = 0;
  const waits: number[] = [];
  const queue = [...(over.polls ?? [])];
  const poll = vi.fn(async (_handle: string) => {
    const next = queue.shift();
    if (!next) throw new Error('polled more often than the test allowed');
    return next;
  });
  const onWaiting = vi.fn();
  const run = () =>
    runDeviceSignIn({
      start: async () => over.start ?? begun(),
      poll,
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
        over.onWait?.(ms);
      },
      now: () => clock,
      live: over.live ?? (() => true),
      onWaiting,
    });
  return { run, poll, waits, onWaiting };
}

describe('runDeviceSignIn', () => {
  it('shows the code once it has one, then reports the connection a poll returns', async () => {
    const t = harness({ polls: [{ status: 'ok', connection }] });

    expect(await t.run()).toEqual({ kind: 'connected', connection });
    expect(t.onWaiting).toHaveBeenCalledTimes(1);
    expect(t.onWaiting).toHaveBeenCalledWith({
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
    });
    expect(t.poll).toHaveBeenCalledWith('handle-1');
  });

  it('waits the interval the server gave, and the slower one it reports after a pending poll', async () => {
    const t = harness({
      polls: [
        { status: 'pending', interval: 5 },
        { status: 'pending', interval: 10 },
        { status: 'ok', connection },
      ],
    });

    await t.run();

    expect(t.waits).toEqual([5000, 5000, 10000]);
  });

  it('never polls faster than once a second, whatever interval it is told', async () => {
    const t = harness({
      start: begun({ interval: 0 }),
      polls: [{ status: 'ok', connection }],
    });

    await t.run();

    expect(t.waits).toEqual([1000]);
  });

  it('ends as expired once the code has outlived its time, without polling past it', async () => {
    const polls: DevicePoll[] = Array.from({ length: 5 }, () => ({
      status: 'pending',
      interval: 5,
    }));
    const t = harness({ start: begun({ expiresIn: 20 }), polls });

    expect(await t.run()).toEqual({ kind: 'expired' });
    expect(t.poll).toHaveBeenCalledTimes(4);
  });

  it('stops without polling when it is cancelled while waiting for the next poll', async () => {
    let live = true;
    const t = harness({
      live: () => live,
      onWait: () => {
        live = false;
      },
      polls: [{ status: 'ok', connection }],
    });

    expect(await t.run()).toEqual({ kind: 'cancelled' });
    expect(t.poll).not.toHaveBeenCalled();
  });

  it('shows no code when it is cancelled before the provider answered', async () => {
    const t = harness({ live: () => false, polls: [] });

    expect(await t.run()).toEqual({ kind: 'cancelled' });
    expect(t.onWaiting).not.toHaveBeenCalled();
    expect(t.poll).not.toHaveBeenCalled();
  });

  it('reports a connection a poll made even if it was cancelled meanwhile, since it exists', async () => {
    let live = true;
    const t = harness({ live: () => live });
    t.poll.mockImplementation(async () => {
      live = false;
      return { status: 'ok', connection };
    });

    expect(await t.run()).toEqual({ kind: 'connected', connection });
  });

  it('passes a failure of the provider or the api on, ending the sign-in', async () => {
    const t = harness();
    t.poll.mockRejectedValue(new Error('access_denied'));

    await expect(t.run()).rejects.toThrow('access_denied');
    expect(t.poll).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ tryLock: vi.fn() }));
vi.mock('@haive/database', async (original) => ({
  ...(await original<any>()),
  tryCliAuthLock: h.tryLock,
}));
import { CLI_AUTH_JOIN_WAIT_MS, withCliAuthLocks } from '../src/lib/cli-auth-write.js';

const provider = {
  id: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  name: 'claude-code',
  authMode: 'subscription',
  isolateAuth: false,
} as any;
const stubLock = () =>
  Object.assign(
    vi.fn(async () => {}),
    { assertHeld: vi.fn(async () => {}) },
  );
const lockWith = (options?: { waitMs?: number }, write = vi.fn(async () => 'written')) => ({
  write,
  result: withCliAuthLocks({} as any, [provider], write, options),
});
const busy = { status: 409, code: 'cli_auth_busy' };

describe('withCliAuthLocks wait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.tryLock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tries once and is refused as busy without a wait limit', async () => {
    h.tryLock.mockResolvedValue(null);
    const { write, result } = lockWith();
    const settled = expect(result).rejects.toMatchObject(busy);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(h.tryLock).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps trying while the lock is busy and is refused as busy after the limit', async () => {
    h.tryLock.mockResolvedValue(null);
    const { write, result } = lockWith({ waitMs: 2000 });
    const settled = expect(result).rejects.toMatchObject(busy);
    await vi.advanceTimersByTimeAsync(2000);
    await settled;
    expect(h.tryLock.mock.calls.length).toBeGreaterThan(1);
    const tries = h.tryLock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.tryLock).toHaveBeenCalledTimes(tries);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes once and releases when the lock frees up in time', async () => {
    const lock = stubLock();
    h.tryLock.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(lock);
    const { write, result } = lockWith({ waitMs: 2000 });
    const settled = expect(result).resolves.toBe('written');
    await vi.advanceTimersByTimeAsync(2000);
    await settled;
    expect(write).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('waits ten seconds in production', () => {
    expect(CLI_AUTH_JOIN_WAIT_MS).toBe(10_000);
  });
});

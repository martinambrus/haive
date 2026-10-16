import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ conns: {} as { redis?: unknown; bull?: unknown } }));

vi.mock('@haive/shared', () => ({
  createRedisConnection: () => h.conns.redis,
  createBullRedisConnection: () => h.conns.bull,
}));

const QUIT_WAIT_MS = 1_000;

const hangs = () => new Promise(() => {});
const answers = async () => 'OK';
const fakeConnection = (quit: () => Promise<unknown>) => ({
  quit: vi.fn(quit),
  disconnect: vi.fn(),
});

async function initWith(
  redis: ReturnType<typeof fakeConnection>,
  bull: ReturnType<typeof fakeConnection>,
) {
  h.conns = { redis, bull };
  vi.resetModules();
  const mod = await import('../src/redis.js');
  mod.initRedis('redis://unused:6379');
  vi.useFakeTimers();
  return mod;
}

const track = (promise: Promise<unknown>) => {
  const state = { settled: false };
  const settle = () => {
    state.settled = true;
  };
  void promise.then(settle, settle);
  return state;
};

describe('closeRedis', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('disconnects both connections at its deadline when quit never answers', async () => {
    const redis = fakeConnection(hangs);
    const bull = fakeConnection(hangs);
    const { closeRedis } = await initWith(redis, bull);

    const closed = track(closeRedis());
    await vi.advanceTimersByTimeAsync(QUIT_WAIT_MS - 1);
    expect(closed.settled).toBe(false);
    expect(redis.disconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(closed.settled).toBe(true);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    expect(bull.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects only the connection whose quit never answers', async () => {
    const redis = fakeConnection(answers);
    const bull = fakeConnection(hangs);
    const { closeRedis } = await initWith(redis, bull);

    const closed = track(closeRedis());
    await vi.advanceTimersByTimeAsync(QUIT_WAIT_MS);
    expect(closed.settled).toBe(true);
    expect(redis.disconnect).not.toHaveBeenCalled();
    expect(bull.disconnect).toHaveBeenCalledTimes(1);
  });

  it('returns at once without a disconnect when both connections quit', async () => {
    const redis = fakeConnection(answers);
    const bull = fakeConnection(answers);
    const { closeRedis, getRedis } = await initWith(redis, bull);

    await closeRedis();

    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(bull.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).not.toHaveBeenCalled();
    expect(bull.disconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => getRedis()).toThrow();
  });
});

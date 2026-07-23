import { describe, it, expect, beforeEach, vi } from 'vitest';

// A controllable fake for getRedis(): records every command issued, whether top-level
// (publishCliExit) or through a multi() pipeline (publishCliChunk/SteerConsumed), so the
// tests can assert that an EXPIRE accompanies each write.
const h = vi.hoisted(() => {
  type Call = { cmd: string; args: unknown[] };
  let calls: Call[] = [];
  const push = (cmd: string, args: unknown[]) => calls.push({ cmd, args });
  const makeChain = () => {
    const chain = {
      xadd: (...args: unknown[]) => (push('xadd', args), chain),
      expire: (...args: unknown[]) => (push('expire', args), chain),
      exec: async () => [],
    };
    return chain;
  };
  const redis = {
    multi: () => makeChain(),
    xadd: async (...args: unknown[]) => (push('xadd', args), '1-0'),
    expire: async (...args: unknown[]) => (push('expire', args), 1),
  };
  return { redis, reset: () => (calls = []), calls: () => calls };
});

vi.mock('../redis.js', () => ({ getRedis: () => h.redis }));

import {
  publishCliChunk,
  publishCliSteerConsumed,
  publishCliExit,
  streamKey,
  STREAM_TTL_SECONDS,
  CLI_STREAM_LIVE_TTL_SECONDS,
} from './cli-stream-publisher.js';

const expireCalls = () => h.calls().filter((c) => c.cmd === 'expire');
const xaddCalls = () => h.calls().filter((c) => c.cmd === 'xadd');

beforeEach(() => h.reset());

describe('cli-stream-publisher TTL on write', () => {
  it('live TTL exceeds the 2h max invocation timeout (silent-run safety)', () => {
    // Sizing invariant: a fully output-silent 2h ollama run (OLLAMA_CLI_TIMEOUT_MS floor)
    // must never have its live stream expire mid-run.
    expect(CLI_STREAM_LIVE_TTL_SECONDS).toBeGreaterThan(2 * 60 * 60);
    expect(STREAM_TTL_SECONDS).toBeLessThan(CLI_STREAM_LIVE_TTL_SECONDS);
  });

  it('publishCliChunk refreshes the live TTL alongside the append', async () => {
    await publishCliChunk('inv1', 'stdout', 'hello');
    expect(xaddCalls()).toHaveLength(1);
    expect(expireCalls()).toEqual([
      { cmd: 'expire', args: [streamKey('inv1'), CLI_STREAM_LIVE_TTL_SECONDS] },
    ]);
  });

  it('publishCliSteerConsumed refreshes the live TTL alongside the append', async () => {
    await publishCliSteerConsumed('inv1', 'steer-9');
    expect(xaddCalls()).toHaveLength(1);
    expect(expireCalls()).toEqual([
      { cmd: 'expire', args: [streamKey('inv1'), CLI_STREAM_LIVE_TTL_SECONDS] },
    ]);
  });

  it('publishCliExit shortens the TTL to the short post-exit window', async () => {
    await publishCliExit('inv1', 0);
    expect(expireCalls()).toEqual([
      { cmd: 'expire', args: [streamKey('inv1'), STREAM_TTL_SECONDS] },
    ]);
  });

  it('writes nothing when there is no invocation id or no payload', async () => {
    await publishCliChunk(null, 'stdout', 'x');
    await publishCliChunk('inv1', 'stdout', '');
    await publishCliSteerConsumed('inv1', '');
    expect(h.calls()).toHaveLength(0);
  });
});

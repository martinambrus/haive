import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fake: true,
  created: [] as Array<{
    url: string;
    subscribe: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    emit: (channel: string, message: string) => void;
  }>,
}));

vi.mock('@haive/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...original,
    createRedisConnection: (url: string) => {
      if (!h.fake) return original.createRedisConnection(url);
      let listener: ((channel: string, message: string) => void) | null = null;
      const sub = {
        url,
        subscribe: vi.fn(async () => 1),
        quit: vi.fn(async () => 'OK'),
        on: (event: string, fn: (channel: string, message: string) => void) => {
          if (event === 'message') listener = fn;
          return sub;
        },
        emit: (channel: string, message: string) => listener?.(channel, message),
      };
      h.created.push(sub);
      return sub;
    },
  };
});

import { createRedisConnection } from '@haive/shared';
import { startModuleActivationWatch } from '../src/modules/activation-watch.js';

const savedUrl = process.env.REDIS_URL;
beforeEach(() => {
  h.fake = true;
  h.created.length = 0;
  process.env.REDIS_URL = 'redis://fake:6379';
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedUrl;
});

describe('startModuleActivationWatch (fake subscriber)', () => {
  it('W1: subscribes to the channel, calls back per message, and quits on stop', () => {
    const seen: string[] = [];
    const stop = startModuleActivationWatch((id) => seen.push(id));
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.subscribe).toHaveBeenCalledWith('haive:module-activated');
    h.created[0]!.emit('haive:module-activated', 'alpha');
    h.created[0]!.emit('haive:module-activated', 'beta');
    expect(seen).toEqual(['alpha', 'beta']);
    expect(h.created[0]!.quit).not.toHaveBeenCalled();
    stop();
    expect(h.created[0]!.quit).toHaveBeenCalledTimes(1);
  });

  it('W1: creates nothing when REDIS_URL is unset', () => {
    delete process.env.REDIS_URL;
    const stop = startModuleActivationWatch(() => {});
    expect(h.created).toHaveLength(0);
    expect(() => stop()).not.toThrow();
  });
});

const realUrl = process.env.MODULE_ACTIVATION_WATCH_TEST_REDIS_URL;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!realUrl)('startModuleActivationWatch (real Redis)', () => {
  it('W2: delivers a published id within 1 s and nothing after stop', async () => {
    h.fake = false;
    process.env.REDIS_URL = realUrl;
    const publisher = createRedisConnection(realUrl!);
    const seen: string[] = [];
    const stop = startModuleActivationWatch((id) => seen.push(id));
    try {
      const deadline = Date.now() + 1000;
      while (seen.length === 0 && Date.now() < deadline) {
        await publisher.publish('haive:module-activated', 'alpha');
        await sleep(50);
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen)).toEqual(new Set(['alpha']));
      stop();
      await sleep(100);
      const before = seen.length;
      await publisher.publish('haive:module-activated', 'beta');
      await sleep(300);
      expect(seen).toHaveLength(before);
    } finally {
      stop();
      await publisher.quit().catch(() => {});
    }
  });
});

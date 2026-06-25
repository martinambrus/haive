import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:child_process so the docker calls are inspectable without a daemon.
// browserCdpUrlForRunner uses promisify(execFile); the mock's execFile calls back
// with a {stdout} object so the promisified form resolves to it (the real binary's
// promisify.custom is lost under the mock, so we pass the object as the value).
const shared = vi.hoisted(() => ({
  impl: null as null | ((cmd: string, args: string[]) => { stdout: string; stderr?: string }),
  calls: [] as string[][],
}));

vi.mock('node:child_process', () => ({
  execFile: (...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as (err: Error | null, out?: unknown) => void;
    const args = allArgs[1] as string[];
    shared.calls.push(args);
    try {
      const out = shared.impl
        ? shared.impl(allArgs[0] as string, args)
        : { stdout: '', stderr: '' };
      cb(null, { stderr: '', ...out });
    } catch (err) {
      cb(err as Error);
    }
  },
}));

const { browserCdpUrlForRunner } = await import('../src/sandbox/runner-browser-cdp.js');

const NAME = 'haive-ddev-469363cf';
const origNet = process.env.SANDBOX_NETWORK;

beforeEach(() => {
  shared.impl = null;
  shared.calls.length = 0;
  process.env.SANDBOX_NETWORK = 'haive-sandbox';
});

afterEach(() => {
  if (origNet === undefined) delete process.env.SANDBOX_NETWORK;
  else process.env.SANDBOX_NETWORK = origNet;
});

describe('browserCdpUrlForRunner', () => {
  it('returns null when SANDBOX_NETWORK is unset (no docker calls)', async () => {
    delete process.env.SANDBOX_NETWORK;
    expect(await browserCdpUrlForRunner(NAME)).toBeNull();
    expect(shared.calls.length).toBe(0);
  });

  it('returns the IP url (not the DNS name) when inspect + liveness curl succeed', async () => {
    shared.impl = (_cmd, args) =>
      args[0] === 'inspect' ? { stdout: '172.21.0.4\n' } : { stdout: '' };
    const url = await browserCdpUrlForRunner(NAME);
    expect(url).toBe('http://172.21.0.4:9223');
    // The liveness curl must hit the SAME ip, never <name>:9223 (the original bug).
    const curl = shared.calls.find((a) => a[0] === 'exec');
    expect(curl?.join(' ')).toContain('http://172.21.0.4:9223/json/version');
    expect(curl?.join(' ')).not.toContain(`${NAME}:9223`);
  });

  it('returns null when the container is not on the network (empty IP)', async () => {
    shared.impl = (_cmd, args) => (args[0] === 'inspect' ? { stdout: '\n' } : { stdout: '' });
    expect(await browserCdpUrlForRunner(NAME)).toBeNull();
    // No liveness curl once the IP is unresolved.
    expect(shared.calls.some((a) => a[0] === 'exec')).toBe(false);
  });

  it('returns null when the liveness curl fails (headless fallback)', async () => {
    shared.impl = (_cmd, args) => {
      if (args[0] === 'inspect') return { stdout: '172.21.0.4\n' };
      throw new Error('curl: exit 7');
    };
    expect(await browserCdpUrlForRunner(NAME)).toBeNull();
  });
});

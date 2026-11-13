import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ exec: vi.fn(), down: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.exec }) };
});

vi.mock('./runtime-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtime-admission.js')>()),
  markBrowserDesktopDown: h.down,
}));

beforeEach(() => {
  vi.resetModules();
  h.exec.mockReset();
  h.down.mockReset().mockResolvedValue(undefined);
});

const mutations = () =>
  h.exec.mock.calls.map(([, args]) => args as string[]).filter((args) => args[0] !== 'inspect');

describe('DDEV registry cache liveness', () => {
  it.each([
    [
      'daemon failure',
      Object.assign(new Error('daemon down'), {
        code: 1,
        stderr: 'Cannot connect to the Docker daemon',
      }),
    ],
    ['spawn failure', Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })],
    ['timeout', Object.assign(new Error('inspect timed out'), { killed: true, signal: 'SIGTERM' })],
    ['unexpected successful output', null],
  ])('does not remove or recreate on %s, and retries the next ensure', async (_label, error) => {
    const { ensureDdevRegistryCache } = await import('./ddev-runner.js');
    if (error) h.exec.mockRejectedValueOnce(error);
    else h.exec.mockResolvedValueOnce({ stdout: 'unexpected', stderr: '' });
    h.exec.mockResolvedValue({ stdout: '', stderr: '' });

    await ensureDdevRegistryCache();
    expect(mutations()).toEqual([]);

    h.exec.mockClear().mockResolvedValue({ stdout: 'true\n', stderr: '' });
    await ensureDdevRegistryCache();
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(mutations()).toEqual([]);
  });

  it('creates a genuinely absent mirror', async () => {
    const { ensureDdevRegistryCache } = await import('./ddev-runner.js');
    h.exec.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'inspect')
        throw Object.assign(new Error('missing'), {
          code: 1,
          stderr: `Error response from daemon: No such container: ${args.at(-1)}\n`,
        });
      return { stdout: '', stderr: '' };
    });
    await ensureDdevRegistryCache();
    expect(mutations().some((args) => args[0] === 'run')).toBe(true);
  });

  it('adopts a live mirror without removing or recreating it', async () => {
    const { ensureDdevRegistryCache } = await import('./ddev-runner.js');
    h.exec.mockResolvedValue({ stdout: 'true\n', stderr: '' });
    await ensureDdevRegistryCache();
    expect(mutations()).toEqual([]);
  });
});

describe.each(['app', 'ddev'] as const)('%s browser desktop accounting', (kind) => {
  const stop = async () => {
    const runner =
      kind === 'app' ? await import('./app-runner.js') : await import('./ddev-runner.js');
    return runner.stopBrowserDesktop('fixture-task');
  };

  it('retains the surcharge on an unknown liveness read', async () => {
    h.exec.mockRejectedValue(new Error('inspect unavailable'));
    await stop().catch(() => {});
    expect(h.down).not.toHaveBeenCalled();
    expect(mutations()).toEqual([]);
  });

  it('retains the surcharge when stopping a live desktop fails', async () => {
    h.exec
      .mockResolvedValueOnce({ stdout: 'true', stderr: '' })
      .mockRejectedValue(new Error('exec failed'));
    await stop();
    expect(h.down).not.toHaveBeenCalled();
  });

  it.each(['true', 'false'])(
    'clears the surcharge after a confirmed %s running state',
    async (running) => {
      h.exec.mockResolvedValueOnce({ stdout: running, stderr: '' }).mockImplementation(async () => {
        expect(h.down).not.toHaveBeenCalled();
        return { stdout: '', stderr: '' };
      });
      await stop();
      expect(h.down).toHaveBeenCalledTimes(1);
      expect(mutations()).toHaveLength(running === 'true' ? 1 : 0);
    },
  );
});

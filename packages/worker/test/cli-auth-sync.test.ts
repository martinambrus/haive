import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
import { syncProviderAuthBack } from '../src/sandbox/task-auth-volume.js';
import type { DockerRunner, DockerRunOpts } from '../src/sandbox/docker-runner.js';

const h = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn(async () => {}) }));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: h.acquire,
}));
const provider = {
  id: 'provider',
  userId: 'user',
  name: 'codex' as const,
  authMode: 'subscription' as const,
  isolateAuth: false,
};
beforeEach(() => {
  h.acquire.mockReset().mockResolvedValue(h.release);
  h.release.mockClear();
});
describe('task auth sync shares the sign-out critical section', () => {
  it('yields to login/sign-out without even reading a credential', async () => {
    h.acquire.mockResolvedValue(null);
    const runner = { volumeExists: vi.fn(), run: vi.fn() };
    expect(
      await syncProviderAuthBack(
        'task',
        provider,
        runner as unknown as DockerRunner,
        {} as Database,
      ),
    ).toBe(false);
    expect(runner.volumeExists).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(h.acquire).toHaveBeenCalledWith(expect.anything(), cliAuthScope(provider));
  });
  it('does not recreate a volume that sign-out removed', async () => {
    const runner = { volumeExists: vi.fn(async () => false), run: vi.fn() };
    expect(
      await syncProviderAuthBack(
        'task',
        provider,
        runner as unknown as DockerRunner,
        {} as Database,
      ),
    ).toBe(false);
    expect(runner.run).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });
  it('carries a rotated credential back under the lock without marking it as a new login', async () => {
    const update = vi.fn();
    const runner = {
      volumeExists: vi.fn(async () => true),
      run: vi.fn(async (opts: DockerRunOpts) => {
        const task = opts.mounts?.[0]?.source.includes('_task_') === true;
        const script = opts.cmd[2] as string;
        return {
          exitCode: 0,
          stdout: script.startsWith('stat')
            ? task
              ? '200'
              : '100'
            : JSON.stringify({ tokens: { access_token: task ? 'rotated' : 'prior' } }),
          stderr: '',
        };
      }),
    };
    expect(
      await syncProviderAuthBack(
        'task',
        provider,
        runner as unknown as DockerRunner,
        { update } as unknown as Database,
      ),
    ).toBe(true);
    expect(runner.run.mock.calls.at(-1)?.[0].mounts).toHaveLength(2);
    expect(h.release).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ exec: vi.fn(), live: vi.fn() }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: m.exec }) };
});
vi.mock('../orchestrator/pause.js', () => ({ hasLiveCliInvocation: m.live }));

import { appRunnerName, ddevRunnerName } from '@haive/shared';
import { appRunnerExec } from './app-runner.js';
import { runnerExec } from './ddev-runner.js';
import { runnerSettled } from './runtime-runner-reaper.js';

const TASK = 'aaaaaaaa-0000-4000-8000-000000000001';

beforeEach(() => {
  m.exec.mockReset();
  m.live.mockReset().mockResolvedValue(false);
});

// A migration, a lint slot or a Playwright run is an exec into the runner with no CLI run live.
describe('a runner with an exec in flight', () => {
  it.each([
    ['app runner', () => appRunnerExec({ container: appRunnerName(TASK), projectDir: '/p' }, 'x')],
    ['DDEV runner', () => runnerExec({ container: ddevRunnerName(TASK), projectDir: '/p' }, 'x')],
  ])('is not settled while the %s exec runs, and is once it ends', async (_n, run) => {
    let finish!: () => void;
    m.exec.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ stdout: '', stderr: '' }))),
    );
    const pending = run();
    await vi.waitFor(() => expect(m.exec).toHaveBeenCalled());
    expect(await runnerSettled({} as never, TASK)).toBe(false);
    finish();
    await pending;
    expect(await runnerSettled({} as never, TASK)).toBe(true);
  });

  it('is not settled while a CLI run is live, as before', async () => {
    m.live.mockResolvedValue(true);
    expect(await runnerSettled({} as never, TASK)).toBe(false);
  });
});

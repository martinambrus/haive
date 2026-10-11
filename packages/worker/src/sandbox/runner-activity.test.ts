import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  exec: vi.fn(),
  live: vi.fn(),
  containers: new Map<string, string[] | Error>(),
  execs: new Map<string, { Running: boolean; OpenStdout: boolean }>(),
}));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: m.exec }) };
});
vi.mock('../orchestrator/pause.js', () => ({ hasLiveCliInvocation: m.live }));
vi.mock('dockerode', () => ({
  default: class {
    getContainer = (name: string) => ({
      inspect: async () => {
        const c = m.containers.get(name);
        if (c instanceof Error) throw c;
        if (!c) throw Object.assign(new Error('no such container'), { statusCode: 404 });
        return { ExecIDs: c };
      },
    });
    getExec = (id: string) => ({ inspect: async () => m.execs.get(id) });
  },
}));

import { appRunnerName, ddevRunnerName } from '@haive/shared';
import { appRunnerExec } from './app-runner.js';
import { runnerExec } from './ddev-runner.js';
import { runnerExecLive, whileRunnerBusy, withRunnersFenced } from './runner-activity.js';
import { runnerSettled } from './runtime-runner-reaper.js';

const TASK = 'aaaaaaaa-0000-4000-8000-000000000001';

beforeEach(() => {
  m.exec.mockReset();
  m.live.mockReset().mockResolvedValue(false);
  m.containers.clear();
  m.execs.clear();
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

  it('is not settled when a CLI run starts while Docker is being asked', async () => {
    m.live.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await runnerSettled({} as never, TASK)).toBe(false);
  });

  it('is not settled while a CLI run is live, as before', async () => {
    m.live.mockResolvedValue(true);
    expect(await runnerSettled({} as never, TASK)).toBe(false);
  });
});

// A worker reload empties this process's count, while an exec it started runs on in the runner.
describe('an exec Docker still runs in the runner', () => {
  it('keeps the runner unsettled with nothing in flight in this process', async () => {
    m.containers.set(ddevRunnerName(TASK), ['e1']);
    m.execs.set('e1', { Running: true, OpenStdout: true });
    expect(await runnerSettled({} as never, TASK)).toBe(false);
  });

  it('does not count a detached forwarder or a finished exec', async () => {
    m.containers.set(ddevRunnerName(TASK), ['fwd', 'done']);
    m.execs.set('fwd', { Running: true, OpenStdout: false });
    m.execs.set('done', { Running: false, OpenStdout: true });
    expect(await runnerExecLive(TASK)).toBe(false);
    expect(await runnerSettled({} as never, TASK)).toBe(true);
  });

  it('counts as busy when Docker does not answer in time', async () => {
    const { default: Docker } = await import('dockerode');
    const hung = new Docker();
    hung.getContainer = (() => ({ inspect: () => new Promise(() => {}) })) as never;
    expect(await runnerExecLive(TASK, hung, 20)).toBe(true);
  });

  it('counts as busy when Docker cannot say, and not when the runner is gone', async () => {
    expect(await runnerExecLive(TASK)).toBe(false);
    m.containers.set(appRunnerName(TASK), new Error('daemon unreachable'));
    expect(await runnerExecLive(TASK)).toBe(true);
  });
});

// The reaper decides, then removes; an exec starting in between must not land under the removal.
describe('a reap decision in progress', () => {
  it('holds an exec that arrives, and sees it before removing', async () => {
    let decided!: () => void;
    const decision = new Promise<void>((r) => (decided = r));
    const ran = vi.fn(async () => 'ran');
    let exec!: Promise<string>;
    const verdict = withRunnersFenced(TASK, async (idle) => {
      exec = whileRunnerBusy(ddevRunnerName(TASK), ran);
      await decision;
      return idle();
    });
    await new Promise((r) => setImmediate(r));
    expect(ran).not.toHaveBeenCalled();
    decided();
    expect(await verdict).toBe(false);
    expect(await exec).toBe('ran');
  });

  it('holds an exec until every overlapping decision on the runner has ended', async () => {
    let endFirst!: () => void;
    let endSecond!: () => void;
    const first = withRunnersFenced(TASK, () => new Promise<void>((r) => (endFirst = r)));
    const second = withRunnersFenced(TASK, () => new Promise<void>((r) => (endSecond = r)));
    endSecond();
    await second;
    const ran = vi.fn(async () => 'ran');
    const exec = whileRunnerBusy(ddevRunnerName(TASK), ran);
    await new Promise((r) => setImmediate(r));
    expect(ran).not.toHaveBeenCalled();
    endFirst();
    await first;
    expect(await exec).toBe('ran');
  });

  it('reads idle when no exec arrived', async () => {
    expect(await withRunnersFenced(TASK, async (idle) => idle())).toBe(true);
  });
});

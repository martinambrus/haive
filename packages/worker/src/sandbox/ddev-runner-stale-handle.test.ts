import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ run: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: mock.run });
  return { ...actual, execFile, spawn: mock.spawn };
});

import { ddevExec, runnerExec } from './ddev-runner.js';

const NOTE = 'this runner was created for another workspace, not mine';
const handle = { container: 'runner', projectDir: '/repos/mine' };

function runnerLabel(label: string): void {
  mock.run.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === 'inspect') return { stdout: `${label}\n`, stderr: '' };
    throw Object.assign(new Error('exec failed'), { code: 3, stdout: 'out', stderr: 'err' });
  });
}

function streamExit(code: number): void {
  mock.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: null,
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('streamed line\n'));
      child.emit('close', code);
    });
    return child;
  });
}

beforeEach(() => {
  mock.run.mockReset();
  mock.spawn.mockReset();
});

describe('stale runner handle note on a failed exec', () => {
  it('is appended to a streaming ddev exec that exits non-zero', async () => {
    runnerLabel('another-subpath');
    streamExit(2);
    const lines: string[] = [];
    const res = await ddevExec(handle, 'describe', { onLine: (l) => lines.push(l) });
    expect(res.exitCode).toBe(2);
    expect(res.output).toContain('streamed line');
    expect(res.output).toContain(NOTE);
    expect(lines).toEqual(['streamed line']);
  });

  it('is left off a streaming exec that exits zero, with no inspect', async () => {
    runnerLabel('another-subpath');
    streamExit(0);
    const res = await ddevExec(handle, 'describe', { onLine: () => {} });
    expect(res).toEqual({ exitCode: 0, output: 'streamed line\n' });
    expect(mock.run).not.toHaveBeenCalled();
  });

  it('is left off a streaming failure when the handle matches the runner', async () => {
    runnerLabel('mine');
    streamExit(2);
    const res = await ddevExec(handle, 'describe', { onLine: () => {} });
    expect(res.output).not.toContain('[haive]');
  });

  it('is appended to a failed runnerExec', async () => {
    runnerLabel('another-subpath');
    const res = await runnerExec(handle, 'true');
    expect(res.exitCode).toBe(3);
    expect(res.output).toContain('outerr');
    expect(res.output).toContain(NOTE);
  });

  it('is left off a failed runnerExec when the handle matches the runner', async () => {
    runnerLabel('mine');
    const res = await runnerExec(handle, 'true');
    expect(res).toEqual({ exitCode: 3, output: 'outerr' });
  });
});

import * as processes from 'node:child_process';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as gitExec from './git-exec.js';
import { logger } from '@haive/shared';
import {
  checkGitRefTransactions,
  GitRefTransactionError,
  withGitRefTransaction,
} from './git-ref-transaction.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const exec = promisify(execFile);
const dirs: string[] = [];
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd })).stdout.trim();
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ref-transaction-'));
  dirs.push(dir);
  await git(dir, 'init', '-b', 'main');
  await git(
    dir,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@test.local',
    'commit',
    '--allow-empty',
    '-m',
    'base',
  );
  const before = await git(dir, 'rev-parse', 'HEAD');
  await git(
    dir,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@test.local',
    'commit',
    '--allow-empty',
    '-m',
    'next',
  );
  const after = await git(dir, 'rev-parse', 'HEAD');
  return {
    dir,
    before,
    after,
    run: (move: () => Promise<boolean>) =>
      withGitRefTransaction(dir, 'refs/heads/main', before, after, move),
    lock: path.join(dir, '.git', 'refs', 'heads', 'main.lock'),
  };
}

describe('git ref transactions', () => {
  it('bounds cleanup and reports a child that never exits after SIGKILL', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.mocked(processes.spawn).mockReturnValueOnce(
      child as unknown as ReturnType<typeof processes.spawn>,
    );
    let failure: unknown;
    let finished = false;
    const result = withGitRefTransaction(
      '.',
      'refs/heads/main',
      'a'.repeat(40),
      'b'.repeat(40),
      async () => true,
    )
      .catch((err: unknown) => {
        failure = err;
      })
      .finally(() => {
        finished = true;
      });
    await vi.runAllTimersAsync();
    // Assert before awaiting so the old, unbounded wait fails without hanging the test.
    expect(finished).toBe(true);
    await result;
    expect(failure).toBeInstanceOf(GitRefTransactionError);
    expect((failure as Error).message).toMatch(/cleanup did not finish/i);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('checks support with an empty transaction without moving refs', async () => {
    const f = await fixture();
    await checkGitRefTransactions(f.dir);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    await expect(access(f.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps a slow callback outside the protocol deadline and releases the real ref lock', async () => {
    const f = await fixture();
    vi.spyOn(gitExec, 'gitDefaultTimeoutMs').mockReturnValue(100);
    const result = await f.run(async () => {
      await access(f.lock);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return false;
    });
    await expect(access(f.lock)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result).toBe(false);
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
    await git(f.dir, 'update-ref', 'refs/heads/main', f.before, f.after);
  });

  it('closes stdin to abort a real prepared transaction when its prepare ack times out', async () => {
    const f = await fixture();
    vi.spyOn(gitExec, 'gitDefaultTimeoutMs').mockReturnValue(100);
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(processes.spawn).mockImplementationOnce(
      (...args: Parameters<typeof processes.spawn>) => {
        const child = actual.spawn(...args);
        const output = child.stdout!;
        const visible = new PassThrough();
        Object.defineProperty(child, 'stdout', { value: visible });
        output.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('start: ok')) visible.write('start: ok\n');
        });
        output.on('end', () => visible.end());
        return child;
      },
    );
    await expect(f.run(async () => true)).rejects.toThrow(/timed out/);
    await expect(access(f.lock)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
  });

  it('aborts on EOF without committing a prepared real transaction', async () => {
    const f = await fixture();
    const child = processes.spawn('git', ['update-ref', '--stdin'], { cwd: f.dir });
    const exited = new Promise((resolve) => child.once('close', resolve));
    child.stdin.write(`start\nupdate refs/heads/main ${f.before} ${f.after}\nprepare\n`);
    await new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('prepare: ok')) resolve();
      });
    });
    await access(f.lock);
    child.stdin.end();
    expect(await exited).toBe(0);
    await expect(access(f.lock)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(f.dir, 'rev-parse', 'main')).toBe(f.after);
  });

  it('rejects spawn failures without running the callback', async () => {
    const move = vi.fn(async () => true);
    await expect(
      withGitRefTransaction(
        '/no-such-ref-transaction-directory',
        'refs/heads/main',
        'a'.repeat(40),
        'b'.repeat(40),
        move,
      ),
    ).rejects.toMatchObject({ cause: { code: 'ENOENT' } });
    expect(move).not.toHaveBeenCalled();
  });

  it('rejects an ack mismatch and requests abort before closing stdin', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    });
    let input = '';
    child.stdin.on('data', (chunk: Buffer) => {
      input += chunk.toString();
      if (input === 'start\n') child.stdout.write('unexpected ack\n');
      if (input.includes('abort\n')) child.stdout.write('abort: ok\n');
    });
    child.stdin.on('finish', () => {
      child.stdout.end();
      child.emit('close', 0);
    });
    vi.mocked(processes.spawn).mockReturnValueOnce(
      child as unknown as ReturnType<typeof processes.spawn>,
    );
    const move = vi.fn(async () => true);
    await expect(
      withGitRefTransaction('.', 'refs/heads/main', 'a'.repeat(40), 'b'.repeat(40), move),
    ).rejects.toThrow(/Git ref transaction failed/);
    expect(input).toContain('abort\n');
    expect(child.kill).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it.each(['SIGTERM', 'SIGKILL'] as const)(
    'escalates a child ignoring EOF only as far as %s',
    async (exitSignal) => {
      vi.useFakeTimers();
      const calls: string[] = [];
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill: vi.fn((signal: string) => {
          calls.push(signal);
          if (signal === exitSignal) {
            child.stdout.end();
            child.emit('close', null);
          }
          return true;
        }),
      });
      child.stdin.on('data', (chunk: Buffer) => calls.push(chunk.toString().trim()));
      child.stdin.on('finish', () => calls.push('EOF'));
      vi.mocked(processes.spawn).mockReturnValueOnce(
        child as unknown as ReturnType<typeof processes.spawn>,
      );
      const rejected = expect(
        withGitRefTransaction(
          '.',
          'refs/heads/main',
          'a'.repeat(40),
          'b'.repeat(40),
          async () => true,
        ),
      ).rejects.toThrow(/timed out/);
      await vi.runAllTimersAsync();
      await rejected;
      expect(calls).toEqual([
        'start',
        'abort',
        'EOF',
        'SIGTERM',
        ...(exitSignal === 'SIGKILL' ? ['SIGKILL'] : []),
      ]);
    },
  );
});

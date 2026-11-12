import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hardenGitArgs } from '@haive/shared/git-args';

const seen = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  children: [] as ChildProcess[],
}));

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  const { promisify: promisifyReal } = await import('node:util');
  const real = promisifyReal(actual.execFile);
  const wrapped = ((...a: Parameters<typeof actual.execFile>) =>
    actual.execFile(...a)) as typeof actual.execFile;
  Object.defineProperty(wrapped, promisifyReal.custom, {
    value: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      seen.options.push(opts);
      return real(cmd, args, opts);
    },
  });
  return {
    ...actual,
    execFile: wrapped,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      seen.children.push(child);
      return child;
    },
  };
});

import { gitDefaultTimeoutMs, gitExec, gitRun, gitTimeoutLimits } from '../src/repo/git-exec.js';

const MIN = 60_000;
const LONG = 30 * MIN;
const SHORT = 10 * MIN;

describe('a real exit at the timeout boundary', () => {
  async function fakeGit(script: string, check: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), 'git-timeout-boundary-'));
    try {
      await writeFile(path.join(dir, 'git'), `#!${process.execPath}\n${script}\n`);
      await chmod(path.join(dir, 'git'), 0o755);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await check(dir);
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it.each([7, 0])('preserves exit %i when git handles the timeout SIGTERM', async (code) => {
    await fakeGit(
      `process.on('SIGTERM', () => process.exit(${code}));
console.log('ready');
setInterval(() => {}, 1000);`,
      async (dir) => {
        const run = gitRun(dir, ['fetch'], { PATH: dir }, { timeout: 5000 });
        await once(seen.children.at(-1)!.stdout!, 'data');
        vi.advanceTimersByTime(5000);
        const result = await run;
        expect(result.code).toBe(code);
        expect(result.stderr).not.toContain('timed out');
      },
    );
  });

  it('does not kill an exited leader while a pipe holder delays close', async () => {
    await fakeGit(
      `require('node:child_process').spawn(process.execPath,
  ['-e', 'setTimeout(() => {}, 500)'], { stdio: 'inherit' });
process.exit(7);`,
      async (dir) => {
        const run = gitRun(dir, ['fetch'], { PATH: dir }, { timeout: 5000 });
        const child = seen.children.at(-1)!;
        const kill = vi.spyOn(child, 'kill');
        await once(child, 'exit');
        vi.advanceTimersByTime(5000);
        const result = await run;
        expect(result.code).toBe(7);
        expect(result.stderr).not.toContain('timed out');
        expect(kill).not.toHaveBeenCalled();
      },
    );
  });

  it('returns 124 and the timeout line when the timer kills git', async () => {
    await fakeGit(
      `console.log('ready');
setInterval(() => {}, 1000);`,
      async (dir) => {
        const run = gitRun(dir, ['fetch'], { PATH: dir }, { timeout: 5000 });
        await once(seen.children.at(-1)!.stdout!, 'data');
        vi.advanceTimersByTime(5000);
        const result = await run;
        expect(result.code).toBe(124);
        expect(result.stderr).toContain('git fetch timed out after 5 s');
      },
    );
  });
});

describe('gitDefaultTimeoutMs', () => {
  it('gives the long subcommands 30 minutes and everything else 10', () => {
    for (const sub of [
      'clone',
      'fetch',
      'pull',
      'push',
      'ls-remote',
      'gc',
      'repack',
      'prune',
      'fsck',
      'merge',
      'rebase',
      'cherry-pick',
      'submodule',
      'lfs',
    ]) {
      expect(gitDefaultTimeoutMs([sub, 'x']), sub).toBe(LONG);
    }
    for (const sub of ['status', 'diff', 'log', 'commit', 'add', 'rev-parse', 'worktree']) {
      expect(gitDefaultTimeoutMs([sub]), sub).toBe(SHORT);
    }
  });

  it('skips git options and their values to find the subcommand', () => {
    expect(gitDefaultTimeoutMs(['-c', 'a=b', '-C', '/tmp/x', 'fetch', 'origin'])).toBe(LONG);
    expect(gitDefaultTimeoutMs(['-c', 'fetch', 'status'])).toBe(SHORT);
    expect(gitDefaultTimeoutMs(['--git-dir', 'push', '--work-tree', 'push', 'log'])).toBe(SHORT);
    expect(gitDefaultTimeoutMs(['--no-optional-locks', 'merge', '--abort'])).toBe(LONG);
  });

  it('reads the argv after hardenGitArgs has put its own options first', () => {
    expect(gitDefaultTimeoutMs(hardenGitArgs(['-C', '/tmp/x', 'push', 'origin']))).toBe(LONG);
    expect(gitDefaultTimeoutMs(hardenGitArgs(['status', '--porcelain']))).toBe(SHORT);
  });

  it('falls back to the short bound when no subcommand is present', () => {
    expect(gitDefaultTimeoutMs(['--version'])).toBe(SHORT);
    expect(gitDefaultTimeoutMs([])).toBe(SHORT);
  });
});

describe('the timeout options passed through gitExec', () => {
  it('is the default for the subcommand, an explicit value wins, and 0 stays unlimited', async () => {
    seen.options.length = 0;
    await gitExec(['--version']);
    await gitExec(['--version'], { timeout: 0 });
    await gitExec(['--version'], { timeout: 777 });
    expect(seen.options.map((o) => o.timeout)).toEqual([SHORT, 0, 777]);
  });
});

describe('a git that hangs', () => {
  let server: Server;
  let dir: string;
  let url: string;
  let helper: string;
  const saved = { ...gitTimeoutLimits };

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/r.git`;
    dir = await mkdtemp(path.join(tmpdir(), 'git-exec-timeout-'));
    helper = path.join(dir, 'helper.sh');
    await writeFile(helper, '#!/bin/sh\nexec sleep 20 >/dev/null 2>&1\n');
    await chmod(helper, 0o755);
    gitTimeoutLimits.long = 100;
    gitTimeoutLimits.short = 100;
  });

  afterAll(async () => {
    Object.assign(gitTimeoutLimits, saved);
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    await rm(dir, { recursive: true, force: true });
  });

  const argv = () => ['-c', `credential.helper=!${helper}`, 'ls-remote', url];

  // These deadlines expire real git/credential-helper processes; 100 ms is enough to prove
  // termination. The timer ordering and production defaults are covered above without waiting.
  it('returns code 124 and the timeout line when a real git is killed (gitRun)', async () => {
    const result = await gitRun(dir, argv());
    expect(result.code).toBe(124);
    expect(result.stderr.trimEnd().split('\n').at(-1)).toBe('git ls-remote timed out after 0 s');
  });

  it('throws an error that says the same (gitExec)', async () => {
    seen.options.length = 0;
    await expect(gitExec(argv(), { cwd: dir })).rejects.toThrow(
      /git ls-remote timed out after 0 s/,
    );
    expect(seen.options.at(-1)!.timeout).toBe(100);
  });

  it('keeps the caller timeout instead of the default', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    try {
      const result = await gitRun(dir, argv(), undefined, { timeout: 50 });
      expect(timeout).toHaveBeenCalledWith(expect.any(Function), 50);
      expect(result.code).toBe(124);
      expect(result.stderr.trimEnd().split('\n').at(-1)).toBe('git ls-remote timed out after 0 s');
    } finally {
      timeout.mockRestore();
    }
  });

  it('keeps zero unlimited even when the default would kill the run', async () => {
    const bin = path.join(dir, 'git');
    await writeFile(bin, '#!/bin/sh\nsleep 0.2\nprintf finished\n');
    await chmod(bin, 0o755);
    gitTimeoutLimits.short = 20;
    try {
      const r = await gitRun(
        dir,
        ['status'],
        { PATH: `${dir}:${process.env.PATH}` },
        { timeout: 0 },
      );
      expect(r).toMatchObject({ code: 0, stdout: 'finished' });
      expect(r.stderr).not.toContain('timed out');
    } finally {
      gitTimeoutLimits.short = 100;
    }
  });

  it('does not call an ordinary non-zero exit a timeout', async () => {
    // This git must finish, not be killed: give it the production deadlines, not the 100 ms
    // this block uses to expire a hung helper, so a loaded runner cannot turn it into a timeout.
    gitTimeoutLimits.long = saved.long;
    gitTimeoutLimits.short = saved.short;
    try {
      const r = await gitRun(dir, ['rev-parse', '--verify', 'nope']);
      expect(r.code).toBe(128);
      expect(r.stderr).not.toContain('timed out');
    } finally {
      gitTimeoutLimits.long = 100;
      gitTimeoutLimits.short = 100;
    }
  });
});

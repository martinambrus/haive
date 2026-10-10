import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hardenGitArgs } from '@haive/shared/git-args';

const seen = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

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
  return { ...actual, execFile: wrapped };
});

import { gitDefaultTimeoutMs, gitExec, gitRun, gitTimeoutLimits } from '../src/repo/git-exec.js';

const MIN = 60_000;
const LONG = 30 * MIN;
const SHORT = 10 * MIN;

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

describe('the limit that reaches execFile', () => {
  it('is the default for the subcommand, an explicit value wins, and 0 stays unlimited', async () => {
    seen.options.length = 0;
    await gitRun(tmpdir(), ['--version']);
    await gitRun(tmpdir(), ['--version'], undefined, { timeout: 12_345 });
    await gitRun(tmpdir(), ['--version'], undefined, { timeout: 0 });
    await gitRun(tmpdir(), ['--version'], undefined, { timeout: undefined });
    await gitExec(['--version']);
    await gitExec(['--version'], { timeout: 0 });
    await gitExec(['--version'], { timeout: 777 });
    expect(seen.options.map((o) => o.timeout)).toEqual([SHORT, 12_345, 0, SHORT, SHORT, 0, 777]);
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
    gitTimeoutLimits.long = 2000;
    gitTimeoutLimits.short = 2000;
  });

  afterAll(async () => {
    Object.assign(gitTimeoutLimits, saved);
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    await rm(dir, { recursive: true, force: true });
  });

  const argv = () => ['-c', `credential.helper=!${helper}`, 'ls-remote', url];

  it('ends near the limit with code 124 and the timeout line (gitRun)', async () => {
    const started = Date.now();
    const result = await Promise.race([
      gitRun(dir, argv()),
      new Promise<'still running'>((ok) => setTimeout(() => ok('still running'), 4500)),
    ]);
    expect(result).not.toBe('still running');
    const r = result as Awaited<ReturnType<typeof gitRun>>;
    expect(Date.now() - started).toBeLessThan(4500);
    expect(r.code).toBe(124);
    expect(r.stderr.trimEnd().split('\n').at(-1)).toBe('git ls-remote timed out after 2 s');
  });

  it('throws an error that says the same (gitExec)', async () => {
    await expect(gitExec(argv(), { cwd: dir })).rejects.toThrow(
      /git ls-remote timed out after 2 s/,
    );
  });

  it('keeps the caller timeout instead of the default', async () => {
    const started = Date.now();
    const r = await gitRun(dir, argv(), undefined, { timeout: 700 });
    expect(r.code).toBe(124);
    expect(r.stderr.trimEnd().split('\n').at(-1)).toBe('git ls-remote timed out after 1 s');
    expect(Date.now() - started).toBeLessThan(1900);
  });

  it('does not call an ordinary non-zero exit a timeout', async () => {
    const r = await gitRun(dir, ['rev-parse', '--verify', 'nope']);
    expect(r.code).toBe(128);
    expect(r.stderr).not.toContain('timed out');
  });
});

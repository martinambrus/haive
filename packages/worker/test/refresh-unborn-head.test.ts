import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { GitRunResult } from '../src/repo/git-exec.js';
import { usableCheckout } from '../src/repo/refresh.js';
import { gitTemplate } from './support/git-template.js';

const fault = vi.hoisted(() => ({
  head: false,
  symbolic: undefined as GitRunResult | undefined,
  refs: undefined as GitRunResult | undefined,
}));
vi.mock('../src/repo/git-exec.js', async (original) => {
  const real = await original<typeof import('../src/repo/git-exec.js')>();
  return {
    ...real,
    gitRun: (...args: Parameters<typeof real.gitRun>) => {
      if (fault.head && args[1].join(' ') === 'rev-parse --verify --quiet HEAD')
        return Promise.resolve({ code: 1, stdout: '', stderr: '' });
      if (args[1][0] === 'symbolic-ref' && fault.symbolic) return Promise.resolve(fault.symbolic);
      if (args[1][0] === 'for-each-ref' && fault.refs) return Promise.resolve(fault.refs);
      return real.gitRun(...args);
    },
  };
});
afterEach(() => {
  fault.head = false;
  fault.symbolic = undefined;
  fault.refs = undefined;
});

const exec = promisify(execFile);
const empty = gitTemplate(async (dir) => {
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
});
const committed = gitTemplate(async (dir) => {
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await exec(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=t@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'baseline',
    ],
    { cwd: dir },
  );
});
const unknown = { unknown: expect.any(String), repairNeeded: true };

it('keeps a broken branch ref unknown even though quiet HEAD exits 1', async () => {
  const { dir } = await committed.copy();
  await writeFile(join(dir, '.git/refs/heads/main'), 'unreadable-ref\n');
  await expect(
    exec('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: dir }),
  ).rejects.toMatchObject({ code: 1 });
  expect(await usableCheckout(dir)).toEqual(unknown);
});

it('does not rebuild on HEAD exit 1 when the branch ref still exists', async () => {
  const { dir } = await committed.copy();
  fault.head = true;
  expect(await usableCheckout(dir)).toEqual(unknown);
});

it('positively recognizes a genuinely unborn branch', async () => {
  expect(await usableCheckout((await empty.copy()).dir)).toBe('unusable');
});

it.each(['symbolic', 'refs'] as const)('holds when the %s proof fails', async (probe) => {
  const { dir } = await empty.copy();
  fault[probe] = { code: 128, stdout: '', stderr: 'arbitrary diagnostic' };
  expect(await usableCheckout(dir)).toEqual(unknown);
});

it('holds when enumeration succeeds but reports an ignored ref', async () => {
  const { dir } = await empty.copy();
  fault.refs = { code: 0, stdout: '', stderr: 'arbitrary diagnostic' };
  expect(await usableCheckout(dir)).toEqual(unknown);
});

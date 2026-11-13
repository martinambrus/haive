import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { readBlob } from '../src/plan/projection-merge.js';
import {
  putBackProjections,
  setAsideHaiveProjections,
  type KeptFiles,
} from '../src/project-state/set-aside.js';
import { gitTemplate } from './support/git-template.js';

const fault = vi.hoisted(() => ({ code: 0 }));
vi.mock('../src/repo/git-exec.js', async (original) => {
  const real = await original<typeof import('../src/repo/git-exec.js')>();
  return {
    ...real,
    gitRun: (...args: Parameters<typeof real.gitRun>) =>
      fault.code && args[1][0] === 'cat-file' && args[1][1] === 'blob'
        ? Promise.resolve({ code: fault.code, stdout: '', stderr: 'arbitrary diagnostic' })
        : real.gitRun(...args),
  };
});
afterEach(() => {
  fault.code = 0;
});

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) =>
  exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  });
const rel = '.haive-data/plan.md';
const template = gitTemplate(async (dir) => {
  await git(dir, ['init', '-q', '-b', 'main']);
  await mkdir(join(dir, '.haive-data'));
  await writeFile(join(dir, rel), 'committed\n');
  await git(dir, ['add', rel]);
  await git(dir, ['commit', '-qm', 'baseline']);
});
const db = {
  execute: async () => [],
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => (table === schema.planNodes ? [{ id: 'plan' }] : []),
      }),
    }),
  }),
  insert: () => ({ values: () => ({ onConflictDoUpdate: async () => [] }) }),
  transaction: async (fn: (tx: Database) => Promise<unknown>) => fn(db),
} as unknown as Database;

it.each([128, 124, -1])('a failed blob read (%s) is never absence', async (code) => {
  const { dir } = await template.copy();
  fault.code = code;
  await expect(readBlob(dir, `HEAD:${rel}`)).rejects.toThrow();
});

it('does not remove a pending working file when its HEAD blob cannot be read', async () => {
  const { dir } = await template.copy();
  await writeFile(join(dir, rel), 'pending\n');
  fault.code = 128;
  const result = await setAsideHaiveProjections(db, 'repo', dir).catch((error: unknown) => error);
  expect.soft(result).toBeInstanceOf(Error);
  expect(
    await readFile(join(dir, rel), 'utf8').catch((error: NodeJS.ErrnoException) => error.code),
  ).toBe('pending\n');
});

it('does not report a successful put-back when its HEAD blob cannot be read', async () => {
  const { dir } = await template.copy();
  const { stdout: entry } = await git(dir, ['ls-files', '-s', rel]);
  const kept: KeptFiles = new Map([
    [
      rel,
      {
        bytes: Buffer.from('pending\n'),
        index: entry.split('\t')[0]!.replace(/ 0$/, ''),
      },
    ],
  ]);
  fault.code = 128;
  await expect(putBackProjections(db, 'repo', dir, kept)).rejects.toThrow();
  expect(await readFile(join(dir, rel), 'utf8')).toBe('committed\n');
});

it('returns null for a positively absent HEAD path and bytes for an existing one', async () => {
  const { dir } = await template.copy();
  expect(await readBlob(dir, 'HEAD:missing')).toBeNull();
  expect(await readBlob(dir, `HEAD:${rel}`)).toEqual(Buffer.from('committed\n'));
});

it('does not treat an unreadable known object id as an absent path', async () => {
  const { dir } = await template.copy();
  await expect(readBlob(dir, 'a'.repeat(40))).rejects.toThrow();
});

it('can restore projections in a genuinely unborn repository', async () => {
  const { dir } = await template.copy();
  await git(dir, ['update-ref', '-d', 'HEAD']);
  expect(await readBlob(dir, `HEAD:${rel}`)).toBeNull();
});

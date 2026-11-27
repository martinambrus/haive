import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveHaiveProjectionConflicts } from '../src/plan/projection-merge.js';
import { gitTemplate } from './support/git-template.js';
import { git } from './support/projection-fixture.js';

const fault = vi.hoisted(() => ({ blob: 0, listing: 0 }));
vi.mock('../src/repo/git-exec.js', async (original) => {
  const real = await original<typeof import('../src/repo/git-exec.js')>();
  return {
    ...real,
    gitRun: (...args: Parameters<typeof real.gitRun>) => {
      const command = args[1];
      const code =
        command[0] === 'cat-file' && command[2] === ':.haive-data/plan.json'
          ? fault.blob
          : command[0] === 'ls-files' && command.includes('--stage')
            ? fault.listing
            : 0;
      return code
        ? Promise.resolve({ code, stdout: '', stderr: 'arbitrary diagnostic' })
        : real.gitRun(...args);
    },
  };
});
afterEach(() => {
  fault.blob = 0;
  fault.listing = 0;
});
const md = '.haive-data/plan.md';
const json = '.haive-data/plan.json';
const template = gitTemplate(async (dir) => {
  await git(dir, ['init', '-q', '-b', 'main']);
  await mkdir(join(dir, '.haive-data'));
  await writeFile(join(dir, json), '{}\n');
  await writeFile(join(dir, md), 'base\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'base']);
  await git(dir, ['checkout', '-qb', 'feature']);
  await writeFile(join(dir, md), 'incoming\n');
  await git(dir, ['commit', '-qam', 'incoming']);
  await git(dir, ['checkout', '-q', 'main']);
  await writeFile(join(dir, md), 'local\n');
  await git(dir, ['commit', '-qam', 'local']);
  await git(dir, ['merge', '--no-ff', '--no-edit', 'feature']).catch(() => {});
});
it.each([128, 124, -1])(
  'an unreadable indexed plan (%s) leaves markdown and index untouched',
  async (code) => {
    const { dir } = await template.copy();
    const bytes = await readFile(join(dir, md));
    const index = await git(dir, ['ls-files', '-s', '-z']);
    fault.blob = code;
    await expect(resolveHaiveProjectionConflicts(dir)).rejects.toMatchObject({
      code: 'PLAN_INDEX_UNREADABLE',
    });
    expect(await readFile(join(dir, md))).toEqual(bytes);
    expect(await git(dir, ['ls-files', '-s', '-z'])).toBe(index);
  },
);
it('a failed absence listing also refuses, while a proven absent plan keeps the fallback', async () => {
  const { dir } = await template.copy();
  await git(dir, ['rm', '-f', '--', json]);
  fault.listing = 128;
  await expect(resolveHaiveProjectionConflicts(dir)).rejects.toMatchObject({
    code: 'PLAN_INDEX_UNREADABLE',
  });
  fault.listing = 0;
  const result = await resolveHaiveProjectionConflicts(dir);
  expect(result.resolved).toContain(md);
  expect(result.warnings[0]).toContain('took the incoming side');
  expect(await readFile(join(dir, md), 'utf8')).toBe('incoming\n');
});

it('a missing index blob is already refused by the conflict listing', async () => {
  const { dir } = await template.copy();
  await git(dir, ['update-index', '--cacheinfo', `100644,${'1'.repeat(40)},${json}`]);
  const bytes = await readFile(join(dir, md));
  const index = await git(dir, ['ls-files', '-s', '-z']);
  await expect(resolveHaiveProjectionConflicts(dir)).rejects.toThrow(
    /git diff --diff-filter=U failed/,
  );
  expect(await readFile(join(dir, md))).toEqual(bytes);
  expect(await git(dir, ['ls-files', '-s', '-z'])).toBe(index);
});

it.each(['directory', 'gitlink'])('an indexed %s is not a plan.json blob', async (kind) => {
  const { dir } = await template.copy();
  await git(dir, ['rm', '-f', '--', json]);
  if (kind === 'directory') {
    await mkdir(join(dir, json));
    await writeFile(join(dir, json, 'child'), 'not a plan\n');
    await git(dir, ['add', '--', json]);
  } else {
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    await git(dir, ['update-index', '--add', '--cacheinfo', `160000,${head},${json}`]);
  }
  const index = await git(dir, ['ls-files', '-s', '-z', '--', `:(literal)${json}`]);
  expect(index).toContain(kind === 'directory' ? `${json}/child\0` : `\t${json}\0`);
  const result = await resolveHaiveProjectionConflicts(dir);
  expect(result.resolved).toContain(md);
  expect(result.warnings[0]).toContain('took the incoming side');
  expect(await readFile(join(dir, md), 'utf8')).toBe('incoming\n');
  expect(await git(dir, ['ls-files', '-s', '-z', '--', `:(literal)${json}`])).toBe(index);
});

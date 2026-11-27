import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHaiveProjectionConflicts } from '../src/plan/projection-merge.js';
import { gitTemplate } from './support/git-template.js';
import { git } from './support/projection-fixture.js';

const fault = vi.hoisted(() => ({
  blob: 0,
  listing: 0,
  fake: false,
  run: vi.fn<typeof import('../src/repo/git-exec.js').gitRun>(),
}));
vi.mock('../src/repo/git-exec.js', async (original) => {
  const real = await original<typeof import('../src/repo/git-exec.js')>();
  return {
    ...real,
    gitRun: (...args: Parameters<typeof real.gitRun>) => {
      if (fault.fake) return fault.run(...args);
      const command = args[1];
      const code = command[0] === 'ls-files' && command.includes('--stage') ? fault.listing : 0;
      return code
        ? Promise.resolve({ code, stdout: '', stderr: 'arbitrary diagnostic' })
        : real.gitRun(...args);
    },
  };
});
afterEach(() => {
  fault.fake = false;
  fault.blob = 0;
  fault.listing = 0;
  fault.run.mockReset();
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
it('a markdown-only conflict refuses an unreadable index and resolves a proven absent plan', async () => {
  const { dir } = await template.copy();
  // A dangling index object makes Git's conflict listing fail before the blob probe.
  await git(dir, ['update-index', '--cacheinfo', `100644,${'1'.repeat(40)},${json}`]);
  const conflict = await readFile(join(dir, md));
  const brokenIndex = await git(dir, ['ls-files', '-s', '-z']);
  await expect(resolveHaiveProjectionConflicts(dir)).rejects.toThrow(
    /git diff --diff-filter=U failed/,
  );
  expect(await readFile(join(dir, md))).toEqual(conflict);
  expect(await git(dir, ['ls-files', '-s', '-z'])).toBe(brokenIndex);
  await git(dir, ['rm', '-f', '--', json]);
  const bytes = await readFile(join(dir, md));
  const index = await git(dir, ['ls-files', '-s', '-z']);
  fault.listing = 128;
  await expect(resolveHaiveProjectionConflicts(dir)).rejects.toMatchObject({
    code: 'PLAN_INDEX_UNREADABLE',
  });
  expect(await readFile(join(dir, md))).toEqual(bytes);
  expect(await git(dir, ['ls-files', '-s', '-z'])).toBe(index);
  fault.listing = 0;
  const result = await resolveHaiveProjectionConflicts(dir);
  expect(result.resolved).toContain(md);
  expect(result.warnings[0]).toContain('took the incoming side');
  expect(await readFile(join(dir, md), 'utf8')).toBe('incoming\n');
});

// Input variants use only an in-memory Git seam: no fixture copy or Git child.
describe('index read decisions with fake gitRun', () => {
  const dir = '/fake/plan-index';
  const oid = '1'.repeat(40);
  let markdown: string;
  let index: string;
  const writes = new Set([
    'checkout',
    'add',
    'rm',
    'update-index',
    'hash-object',
    'checkout-index',
  ]);

  function fakeIndex(listing: string) {
    fault.fake = true;
    markdown = 'local with conflict markers\n';
    index = listing;
    fault.run.mockImplementation(async (_dir, args) => {
      if (args[0] === 'diff') return { code: 0, stdout: `${md}\0`, stderr: '' };
      if (args[0] === 'cat-file')
        return { code: fault.blob || 128, stdout: '', stderr: 'arbitrary diagnostic' };
      if (args[0] === 'ls-files' && args.includes('--stage'))
        return { code: fault.listing, stdout: listing, stderr: '' };
      if (args[0] === 'ls-files' && args.includes('-u'))
        return { code: 0, stdout: `100644 ${oid} 3\t${md}\0`, stderr: '' };
      if (args[0] === 'checkout') markdown = 'incoming\n';
      else if (args[0] === 'add') index += `resolved ${md}`;
      else throw new Error(`unexpected fake Git command: ${args.join(' ')}`);
      return { code: 0, stdout: '', stderr: '' };
    });
  }

  function expectUntouched() {
    expect(markdown).toBe('local with conflict markers\n');
    expect(fault.run.mock.calls.filter(([, args]) => writes.has(args[0]!))).toEqual([]);
  }

  it.each([128, 124, -1])(
    'an unreadable indexed plan (%s) leaves markdown and index untouched',
    async (code) => {
      const listing = `100644 ${oid} 0\t${json}\0`;
      fakeIndex(listing);
      fault.blob = code;
      await expect(resolveHaiveProjectionConflicts(dir)).rejects.toMatchObject({
        code: 'PLAN_INDEX_UNREADABLE',
      });
      expect(index).toBe(listing);
      expectUntouched();
    },
  );

  it('a failed absence listing leaves markdown and index untouched', async () => {
    fakeIndex('');
    fault.listing = 128;
    const before = index;
    await expect(resolveHaiveProjectionConflicts(dir)).rejects.toMatchObject({
      code: 'PLAN_INDEX_UNREADABLE',
    });
    expect(index).toBe(before);
    expectUntouched();
  });

  it.each(['directory', 'gitlink'])('an indexed %s is not a plan.json blob', async (kind) => {
    const listing =
      kind === 'directory' ? `100644 ${oid} 0\t${json}/child\0` : `160000 ${oid} 0\t${json}\0`;
    fakeIndex(listing);
    const result = await resolveHaiveProjectionConflicts(dir);
    expect(result.resolved).toContain(md);
    expect(result.warnings[0]).toContain('took the incoming side');
    expect(markdown).toBe('incoming\n');
    // Only plan.md was staged; the non-blob plan.json entry stays unchanged.
    expect(index).toBe(`${listing}resolved ${md}`);
    expect(
      fault.run.mock.calls.filter(([, args]) => writes.has(args[0]!)).map(([, args]) => args),
    ).toEqual([
      ['checkout', '--theirs', '--', `:(literal)${md}`],
      ['add', '--', `:(literal)${md}`],
    ]);
  });
});

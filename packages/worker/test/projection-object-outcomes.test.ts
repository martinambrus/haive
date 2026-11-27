import { vi, expect, it } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  projectionEntries,
  projectionHeadBlobs,
  stagedProjectionBlobs,
} from '../src/project-state/projection-git.js';
import { gitBlobSizes } from '../src/repo/git-blobs.js';
import { gitTemplate } from './support/git-template.js';
import { buildProjectionFixture, fixtureDb, git } from './support/projection-fixture.js';
import { setAsideHaiveProjections, putBackProjections } from '../src/project-state/set-aside.js';
const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/repo/git-exec.js', async (original) => {
  const real = await original<typeof import('../src/repo/git-exec.js')>();
  return {
    ...real,
    gitRun: (...args: Parameters<typeof real.gitRun>) => {
      calls.count++;
      return real.gitRun(...args);
    },
  };
});
vi.mock('../src/project-state/sync.js', async (original) => ({
  ...(await original<typeof import('../src/project-state/sync.js')>()),
  syncProjectStateFromCheckout: async () => ({ outcome: 'unchanged' }),
  readProjectStateBase: async () => 'stable',
  rebaseProjectStateOnHeadLocked: async () => {},
}));
const fixture = gitTemplate(buildProjectionFixture);
const plan = '.haive-data/plan.md';

it.each(['added gitlink', 'changed gitlink', 'missing blob'])(
  'names and preserves a staged %s instead of throwing',
  async (kind) => {
    const { dir, data } = await fixture.copy();
    const rel = '.haive-data/state/sub';
    if (kind === 'changed gitlink') {
      const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      await git(dir, ['update-index', '--add', '--cacheinfo', `160000,${head},${rel}`]);
      await git(dir, ['commit', '-qm', 'gitlink baseline']);
    }
    const oid =
      kind === 'changed gitlink' ? (await git(dir, ['rev-parse', 'HEAD'])).trim() : '1'.repeat(40);
    const mode = kind === 'missing blob' ? '100644' : '160000';
    await git(dir, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${rel}`]);
    const before = await git(dir, ['ls-files', '-s', '-z']);
    expect(await setAsideHaiveProjections(fixtureDb(data), 'repo', dir)).toMatchObject({
      outcome: 'refused',
      code: 'projection_not_owned',
      file: rel,
    });
    expect(await git(dir, ['ls-files', '-s', '-z'])).toBe(before);
  },
);

it('accepts the staged oid equal to a HEAD gitlink without trying to read it as a blob', async () => {
  const { dir } = await fixture.copy();
  const rel = '.haive-data/state/sub';
  const oid = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  await git(dir, ['update-index', '--add', '--cacheinfo', `160000,${oid},${rel}`]);
  await git(dir, ['commit', '-qm', 'gitlink baseline']);
  const entries = await projectionEntries(dir);
  expect(entries.head.get(rel)).toBe(`160000 ${oid}`);
  expect(entries.staged.get(rel)).toBe(oid);
  expect(await gitBlobSizes(dir, [oid, '2'.repeat(40)])).toEqual(new Map());
  calls.count = 0;
  expect(await stagedProjectionBlobs(dir, [rel], entries, () => 1024, 1024)).toEqual(new Map());
  expect(calls.count).toBe(0);
  // Presence in HEAD must never become permission to remove a working file as untracked.
  expect(() => projectionHeadBlobs(dir, [rel], entries, 1024)).toThrow();
});

it('keeps a missing HEAD blob present and fails before removing pending bytes', async () => {
  const { dir, data } = await fixture.copy();
  const oid = '2'.repeat(40);
  const siblings = (await git(dir, ['ls-tree', 'HEAD:.haive-data']))
    .split('\n')
    .filter((line) => line && !line.endsWith('\tplan.md'));
  const tree = (
    await git(
      dir,
      ['mktree', '--missing'],
      Buffer.from([...siblings, `100644 blob ${oid}\tplan.md`].join('\n') + '\n'),
    )
  ).trim();
  const root = (
    await git(dir, ['mktree'], Buffer.from(`040000 tree ${tree}\t.haive-data\n`))
  ).trim();
  const commit = (
    await git(dir, ['commit-tree', root], Buffer.from('missing blob fixture\n'))
  ).trim();
  await git(dir, ['update-ref', 'HEAD', commit]);
  await git(dir, ['read-tree', 'HEAD']);
  const entries = await projectionEntries(dir);
  expect(entries.head.get(plan)).toBe(`100644 ${oid}`);
  await writeFile(join(dir, plan), 'pending\n');
  await expect(setAsideHaiveProjections(fixtureDb(data), 'repo', dir)).rejects.toThrow();
  expect(await readFile(join(dir, plan), 'utf8')).toBe('pending\n');
});

it('retains every unmerged stage and refuses the move without changing bytes or the index', async () => {
  const { dir, data } = await fixture.copy();
  const oid = (await git(dir, ['rev-parse', `HEAD:${plan}`])).trim();
  await git(
    dir,
    ['update-index', '--index-info'],
    Buffer.from(
      `0 ${'0'.repeat(40)}\t${plan}\n100644 ${oid} 1\t${plan}\n100644 ${oid} 2\t${plan}\n100644 ${oid} 3\t${plan}\n`,
    ),
  );
  const before = await git(dir, ['ls-files', '-s', '-z']);
  const entries = await projectionEntries(dir);
  expect(entries.staged.get(plan)).toBe('unmerged');
  expect(entries.index.has(plan)).toBe(false);
  expect(await stagedProjectionBlobs(dir, [plan], entries, () => 1024, 1024)).toEqual(new Map());
  expect(await setAsideHaiveProjections(fixtureDb(data), 'repo', dir)).toMatchObject({
    outcome: 'refused',
  });
  expect(await git(dir, ['ls-files', '-s', '-z'])).toBe(before);
  expect(await readFile(join(dir, plan), 'utf8')).toBe('baseline\n');
});

it('sets aside and puts back a staged owned plan.json and refuses foreign staged bytes', async () => {
  const { dir, data } = await fixture.copy();
  const rel = '.haive-data/plan.json';
  const pending = '{"pending":true}\n';
  await writeFile(join(dir, rel), pending);
  await git(dir, ['add', '--', rel]);
  const before = await git(dir, ['ls-files', '-s', '-z']);
  const aside = await setAsideHaiveProjections(fixtureDb(data), 'repo', dir);
  expect(aside.outcome).toBe('set-aside');
  if (aside.outcome !== 'set-aside') throw new Error('expected set-aside');
  expect(await readFile(join(dir, rel), 'utf8')).toBe('{}\n');
  await putBackProjections(fixtureDb(data), 'repo', dir, aside.kept);
  expect(await git(dir, ['ls-files', '-s', '-z'])).toBe(before);
  expect(await readFile(join(dir, rel), 'utf8')).toBe(pending);
  await writeFile(join(dir, rel), 'personal\n');
  await git(dir, ['add', '--', rel]);
  await writeFile(join(dir, rel), pending);
  const personalIndex = await git(dir, ['ls-files', '-s', '-z']);
  expect(await setAsideHaiveProjections(fixtureDb(data), 'repo', dir)).toMatchObject({
    outcome: 'refused',
    code: 'projection_not_owned',
    file: rel,
  });
  expect(await git(dir, ['ls-files', '-s', '-z'])).toBe(personalIndex);
  expect(await readFile(join(dir, rel), 'utf8')).toBe(pending);
});

import { vi, expect, it } from 'vitest';
import { writeFile, readFile, rename, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { claimFileName, renderProjectState } from '@haive/shared/project-state';
import { readStateTree } from '../src/plan/projection-merge.js';
import { gitTemplate } from './support/git-template.js';
import {
  buildProjectionFixture,
  fixtureDb,
  git,
  hash,
  writeRecord,
} from './support/projection-fixture.js';
import {
  setAsideHaiveProjections,
  putBackProjections,
  restoreFaults,
} from '../src/project-state/set-aside.js';
const calls = vi.hoisted(() => ({
  count: 0,
  afterRewrite: undefined as (() => Promise<void>) | undefined,
}));
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
vi.mock('@haive/shared/fs-safe', async (original) => {
  const real = await original<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    rewriteFileIfNoFollow: async (...args: Parameters<typeof real.rewriteFileIfNoFollow>) => {
      const result = await real.rewriteFileIfNoFollow(...args);
      await calls.afterRewrite?.();
      return result;
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

it('sets aside and puts back staged renames, deletions and binary plan bytes without touching unrelated index entries', async () => {
  const { dir, data: base } = await fixture.copy();
  const claims = base.claims.slice(0, 3).map((c, i) => ({
    ...c,
    path: i === 0 ? 'generated/renamed.txt' : c.path,
    writtenHash: hash('new'),
  }));
  const pending = { ...base, claims };
  await rename(
    join(dir, '.haive-data/state', claimFileName(base.claims[0]!.path)),
    join(dir, '.haive-data/state', claimFileName(claims[0]!.path)),
  );
  await unlink(join(dir, '.haive-data/state', claimFileName(base.claims[3]!.path)));
  await writeRecord(dir, pending);
  const binary = Buffer.from([0, 255, 10, 254]);
  await writeFile(join(dir, plan), binary);
  await writeFile(join(dir, 'unrelated'), 'staged by a person');
  await git(dir, ['add', '-A']);
  const before = await git(dir, ['ls-files', '-s', '-z']);
  const aside = await setAsideHaiveProjections(fixtureDb(pending), 'repo', dir);
  expect(aside.outcome).toBe('set-aside');
  if (aside.outcome !== 'set-aside') throw new Error('expected set-aside');
  expect(await readFile(join(dir, plan), 'utf8')).toBe('baseline\n');
  expect(await git(dir, ['diff', 'HEAD', '--name-only', '-z', '--', '.haive-data'])).toBe('');
  await putBackProjections(fixtureDb(pending), 'repo', dir, aside.kept);
  expect(await git(dir, ['ls-files', '-s', '-z'])).toBe(before);
  expect(await readFile(join(dir, plan))).toEqual(binary);
});

it('refuses a symlink without reading or replacing its target', async () => {
  const { dir, data } = await fixture.copy();
  await writeFile(join(dir, 'target'), 'personal bytes');
  await unlink(join(dir, plan));
  await symlink('../target', join(dir, plan));
  const aside = await setAsideHaiveProjections(fixtureDb(data), 'repo', dir);
  expect(aside).toMatchObject({ outcome: 'refused', file: plan });
  expect(await readFile(join(dir, 'target'), 'utf8')).toBe('personal bytes');
});

it('keeps a personal save and staging that raced the capture', async () => {
  const { dir, data } = await fixture.copy();
  await writeFile(join(dir, plan), 'pending\n');
  restoreFaults.beforeRestore = async () => {
    await writeFile(join(dir, plan), 'personal\n');
    await git(dir, ['add', '--', plan]);
  };
  try {
    const aside = await setAsideHaiveProjections(fixtureDb(data), 'repo', dir);
    expect(aside.outcome).toBe('refused');
    expect(await git(dir, ['show', `:${plan}`])).toBe('personal\n');
  } finally {
    delete restoreFaults.beforeRestore;
  }
});

it('detects an index change after a filesystem restore even when the captured index matched HEAD', async () => {
  const { dir, data } = await fixture.copy();
  await writeFile(join(dir, plan), 'pending\n');
  const personal = (
    await git(dir, ['hash-object', '-w', '--stdin'], Buffer.from('personal\n'))
  ).trim();
  calls.afterRewrite = async () => {
    calls.afterRewrite = undefined;
    await git(dir, ['update-index', '--cacheinfo', `100644,${personal},${plan}`]);
  };
  try {
    const aside = await setAsideHaiveProjections(fixtureDb(data), 'repo', dir);
    expect(aside.outcome).toBe('refused');
    expect(await git(dir, ['show', `:${plan}`])).toBe('personal\n');
    expect(await readFile(join(dir, plan), 'utf8')).toBe('pending\n');
  } finally {
    calls.afterRewrite = undefined;
  }
});

it('bounds Git spawns independently of the number of unstaged dirty files', async () => {
  const counts: number[] = [];
  for (const dirtyCount of [1, 4]) {
    const { dir, data: base } = await fixture.copy();
    const pending = {
      ...base,
      claims: base.claims.map((c, i) => (i < dirtyCount ? { ...c, writtenHash: hash('new') } : c)),
    };
    await writeRecord(dir, pending);
    calls.count = 0;
    expect((await setAsideHaiveProjections(fixtureDb(pending), 'repo', dir)).outcome).toBe(
      'set-aside',
    );
    counts.push(calls.count);
  }
  expect(counts[0]).toBeLessThanOrEqual(60);
  expect(counts[1]).toBe(counts[0]);
});

it('reads an entire committed state tree with one listing and one blob batch', async () => {
  const { dir, data } = await fixture.copy();
  calls.count = 0;
  expect(await readStateTree(dir, 'HEAD')).toEqual(renderProjectState(data));
  expect(calls.count).toBe(2);
});

import { afterEach, expect, it } from 'vitest';
import { writeFileNoFollow } from '@haive/shared/fs-safe';
import { git, repoFixture } from './support/nested-repo.js';
import { stageAllArgs } from '../src/step-engine/steps/workflow/_gitlink-registration.js';

let cleanup: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await cleanup?.();
});
it('a root add excludes the atomic projection writer temp names at every depth', async () => {
  const fixture = await repoFixture();
  cleanup = fixture.cleanup;
  const { repo } = fixture;
  const temps = [
    '.haive-data/.plan.json.haive-tmp-123-abcdef',
    '.haive-data/state/.record.json.haive-tmp-123-abcdef',
    '.root.haive-tmp-123-abcdef',
    '.root.haive-alias-kept-abcdef',
    'nested/.root.haive-alias-park-123-abcdef',
    '.root.haive-alias-park-123-abcdef.name',
    '.root.haive-park-123-abcdef',
    '.root.haive-alias-tmp-123-abcdef',
  ];
  for (const name of temps)
    await writeFileNoFollow(repo, name, 'partial projection', { createParents: true });
  await writeFileNoFollow(repo, 'a.txt', 'ordinary edit\n');
  await writeFileNoFollow(repo, '.haive-data/plan.json', '{}', { createParents: true });
  await git(repo, stageAllArgs([]));
  expect((await git(repo, ['diff', '--cached', '--name-only'])).trim().split('\n')).toEqual([
    '.haive-data/plan.json',
    'a.txt',
  ]);
});

it('L-b scoped directory adds exclude sweep artifacts at every depth', async () => {
  const { gitStageScopedPaths } = await import('../src/repo/git-commit.js');
  const { repo, cleanup: clean } = await repoFixture();
  cleanup = clean;
  for (const name of [
    'knowledge_base/.f.haive-alias-tmp-123-abcdef',
    'knowledge_base/nested/.f.haive-tmp-123-abcdef',
    'knowledge_base/.f.haive-park-123-abcdef',
  ])
    await writeFileNoFollow(repo, name, 'private', { createParents: true });
  await writeFileNoFollow(repo, 'knowledge_base/real.md', 'public');
  await gitStageScopedPaths(repo, ['knowledge_base'], []);
  expect((await git(repo, ['diff', '--cached', '--name-only'])).trim()).toBe(
    'knowledge_base/real.md',
  );
});

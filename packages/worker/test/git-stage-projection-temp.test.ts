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

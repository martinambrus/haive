import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureDirNoFollow, removeNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { emptyProjectState, renderProjectState } from '@haive/shared/project-state';
import { gitRun } from '../src/repo/git-exec.js';
import { commitHaiveProjections } from '../src/project-state/commit.js';

const identity = {
  GIT_AUTHOR_NAME: 'probe',
  GIT_AUTHOR_EMAIL: 'probe@example.test',
  GIT_COMMITTER_NAME: 'probe',
  GIT_COMMITTER_EMAIL: 'probe@example.test',
};
const plans = ['.haive-data/plan.json', '.haive-data/plan.md'];
let template: string;
const roots: string[] = [];
const git = async (root: string, args: string[]) => {
  const result = await gitRun(root, args, identity);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
};
const save = (repoPath: string) =>
  commitHaiveProjections({
    repositoryId: '00000000-0000-4000-8000-000000000001',
    repoPath,
    identity,
    waitForIndexRetry: async () => undefined,
  });
async function record(root: string, settings: Record<string, unknown>) {
  await ensureDirNoFollow(root, '.haive-data/state/settings');
  for (const [rel, text] of renderProjectState({ ...emptyProjectState(), settings }))
    await writeFileNoFollow(root, `.haive-data/state/${rel}`, text);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-save-index-'));
  roots.push(root);
  await cp(template, root, { recursive: true });
  await writeFileNoFollow(root, 'notes', 'unrelated staged work\n');
  await git(root, ['add', 'notes']);
  return root;
}

describe('Save index repair through supported Save and index-lock sequences', () => {
  beforeAll(async () => {
    template = await mkdtemp(join(tmpdir(), 'git-save-template-'));
    await git(template, ['init', '-q', '-b', 'main']);
    await writeFileNoFollow(template, 'notes', 'original\n');
    await git(template, ['add', 'notes']);
    await git(template, ['commit', '-qm', 'initial']);
    await record(template, { 'rtk-version': '1' });
    await writeFileNoFollow(template, plans[0]!, '{}\n');
    await writeFileNoFollow(template, plans[1]!, '# Plan\n');
    expect(await save(template)).toMatchObject({ committed: true, indexSynced: true });
  });
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    if (template) await rm(template, { recursive: true, force: true });
  });

  it('repairs an earlier owned staging entry when a later Save commits a sibling', async () => {
    const root = await fixture();
    const unrelated = await git(root, ['ls-files', '--stage', '--', 'notes']);
    // A tooling mutation followed by Save while a Terminal writer holds the real index.
    await record(root, { 'rtk-version': '2' });
    await writeFileNoFollow(root, '.git/index.lock', 'another git writer\n');
    expect(await save(root)).toMatchObject({ committed: true, indexSynced: false });
    await removeNoFollow(root, '.git/index.lock');
    // A second tooling mutation makes this retry a committing Save, not a no-op repair.
    await record(root, { 'rtk-version': '2', 'chrome-devtools-mcp-version': '1' });
    expect(await save(root)).toMatchObject({ committed: true, indexSynced: true });
    expect(await git(root, ['ls-files', '--stage', '--', 'notes'])).toBe(unrelated);
    expect(await git(root, ['show', 'HEAD:notes'])).toBe('original');
    expect.soft(await git(root, ['diff', '--cached', '--name-only'])).toBe('notes');
    await git(root, ['commit', '-qm', 'commit unrelated notes']);
    expect
      .soft(
        JSON.parse(await git(root, ['show', 'HEAD:.haive-data/state/settings/rtk-version.json'])),
      )
      .toBe('2');
  });

  it('syncs committed names even when an older owned name has a user-staged child', async () => {
    const root = await fixture();
    const stale = '.haive-data/state/settings/rtk-version.json';
    const child = `${stale}/mine.txt`;
    const committed = '.haive-data/state/settings/chrome-devtools-mcp-version.json';
    await removeNoFollow(root, stale);
    await ensureDirNoFollow(root, stale);
    await writeFileNoFollow(root, child, 'personal staged bytes\n');
    await git(root, ['add', child]);
    const staged = await git(root, ['ls-files', '--stage', '--', child]);
    await record(root, { 'chrome-devtools-mcp-version': '1' });

    expect(await save(root)).toMatchObject({
      committed: true,
      indexSynced: false,
      files: [committed],
    });
    expect(await git(root, ['ls-files', '--stage', '--', child])).toBe(staged);
    expect(await git(root, ['diff', '--cached', '--name-only'])).toBe(
      [stale, child, 'notes'].join('\n'),
    );
    await git(root, ['commit', '-qm', 'commit personal changes']);
    expect(JSON.parse(await git(root, ['show', `HEAD:${committed}`]))).toBe('1');
  });

  it('preserves an unrelated staged file whose disk bytes changed during a committing repair', async () => {
    const root = await fixture();
    const personal = '.haive-data/state/settings/personal.txt';
    await writeFileNoFollow(root, personal, 'personal staged bytes\n');
    await git(root, ['add', personal]);
    const staged = await git(root, ['ls-files', '--stage', '--', personal]);
    await writeFileNoFollow(root, personal, 'personal unstaged bytes\n');
    await record(root, { 'rtk-version': '2' });
    await writeFileNoFollow(root, '.git/index.lock', 'another git writer\n');
    expect(await save(root)).toMatchObject({ committed: true, indexSynced: false });
    await removeNoFollow(root, '.git/index.lock');
    await record(root, { 'rtk-version': '2', 'chrome-devtools-mcp-version': '1' });
    expect(await save(root)).toMatchObject({ committed: true, indexSynced: true });
    expect(await git(root, ['ls-files', '--stage', '--', personal])).toBe(staged);
    expect(await git(root, ['show', `:${personal}`])).toBe('personal staged bytes');
    expect(await git(root, ['ls-tree', '--name-only', 'HEAD', '--', personal])).toBe('');
  });

  it.each(plans)('repairs a committed deletion of %s on repeat Save', async (removed) => {
    const root = await fixture();
    const unrelated = await git(root, ['ls-files', '--stage', '--', 'notes']);
    // An empty-plan flush removes the pair (plan/mirror.ts); Save commits those removals.
    for (const rel of plans) await removeNoFollow(root, rel);
    await writeFileNoFollow(root, '.git/index.lock', 'another git writer\n');
    expect(await save(root)).toMatchObject({
      committed: true,
      indexSynced: false,
      files: plans,
    });
    await removeNoFollow(root, '.git/index.lock');
    const head = await git(root, ['rev-parse', 'HEAD']);
    expect(await save(root)).toMatchObject({ committed: false, indexSynced: true });
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(root, ['ls-files', '--stage', '--', 'notes'])).toBe(unrelated);
    expect(await git(root, ['ls-tree', '--name-only', 'HEAD', '--', removed])).toBe('');
    expect.soft(await git(root, ['ls-files', '--stage', '--', removed])).toBe('');
    await git(root, ['commit', '-qm', 'commit unrelated notes']);
    expect.soft(await git(root, ['ls-tree', '--name-only', 'HEAD', '--', removed])).toBe('');
  });
});

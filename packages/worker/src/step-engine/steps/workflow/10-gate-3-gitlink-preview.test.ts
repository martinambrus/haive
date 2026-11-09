import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDirNoFollow, removeNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { gate3CommitStep } from './10-gate-3-commit.js';
import { gateContext, git, repoFixture } from '../../../../test/support/nested-repo.js';
import { failGit } from '../../../../test/support/fake-git.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(committed = true, name = 'nested') {
  const fixture = await repoFixture();
  cleanups.push(fixture.cleanup);
  const { repo } = fixture;
  await ensureDirNoFollow(repo, name);
  await git(path.join(repo, name), ['init', '-q', '-b', 'main']);
  await writeFileNoFollow(repo, `${name}/inside.txt`, 'nested contents\n');
  if (committed) {
    await git(path.join(repo, name), ['add', '-A']);
    await git(path.join(repo, name), ['commit', '-q', '-m', 'nested seed']);
  }
  await writeFileNoFollow(repo, 'a.txt', 'after\n');
  return repo;
}

async function preview(repo: string) {
  const ctx = gateContext(repo);
  const detected = await gate3CommitStep.detect!(ctx);
  return { detected, form: gate3CommitStep.form!(ctx, detected)! };
}

describe('gate 3 unregistered nested repository preview', () => {
  it('lists an unregistered nested repository and the two ways out', async () => {
    const { detected, form } = await preview(await fixture());
    expect(detected.unregisteredGitlinks).toEqual(['nested']);
    for (const word of ['nested', '.gitmodules', 'ordinary files', 'submodule']) {
      expect(form.description).toContain(word);
    }
  });

  it('lists nothing for a registered submodule', async () => {
    const repo = await fixture();
    await writeFileNoFollow(
      repo,
      '.gitmodules',
      '[submodule "lib"]\n\tpath = nested\n\turl = https://example.invalid/x.git\n',
    );
    const { detected, form } = await preview(repo);
    expect(detected.unregisteredGitlinks).toEqual([]);
    expect(form.description).not.toContain('not registered as submodules');
  });

  it('lists nothing for an unborn nested repository', async () => {
    const { detected, form } = await preview(await fixture(false));
    expect(detected.unregisteredGitlinks).toEqual([]);
    expect(form.description).not.toContain('not registered as submodules');
  });

  it('leaves no raw tag from a repository-derived name in the description', async () => {
    const { detected, form } = await preview(await fixture(true, 'x<img src=y>'));
    expect(detected.unregisteredGitlinks).toEqual(['x<img src=y>']);
    expect(form.description).not.toMatch(/(^|[^\\])<img/);
    expect(form.description).toContain('\\<img');
  });

  it('still resolves with the field undefined when the check throws', async () => {
    const repo = await fixture();
    const shim = await failGit(['diff-index']);
    try {
      const { detected } = await preview(repo);
      expect(detected.hasGit).toBe(true);
      expect(detected.unregisteredGitlinks).toBeUndefined();
    } finally {
      await shim.restore();
    }
  });

  it('still resolves for an outer repository with no commit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gitlink-preview-'));
    cleanups.push(() => removeNoFollow(tmpdir(), path.basename(dir), { recursive: true }));
    await git(dir, ['init', '-q', '-b', 'main']);
    await writeFileNoFollow(dir, 'a.txt', 'new\n');
    const { detected } = await preview(dir);
    expect(detected.unregisteredGitlinks).toEqual([]);
  });
});

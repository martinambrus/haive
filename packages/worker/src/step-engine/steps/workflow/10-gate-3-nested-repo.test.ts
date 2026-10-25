import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureDirNoFollow,
  readTextNoFollow,
  removeNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { gate3CommitStep } from './10-gate-3-commit.js';
import { gateContext, git, repoFixture } from '../../../../test/support/nested-repo.js';
import { failGit } from '../../../../test/support/fake-git.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(committed = false, name = 'nested') {
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

async function commit(repo: string) {
  const ctx = gateContext(repo);
  const detected = await gate3CommitStep.detect!(ctx);
  return gate3CommitStep.apply(ctx, {
    detected,
    formValues: { commit: true, commitMessage: 'fix: update a' },
    iteration: 0,
    previousIterations: [],
  });
}

describe('gate 3 nested repository controls', () => {
  it('names an unborn nested repository and all three choices before Finalise', async () => {
    const repo = await fixture();
    const ctx = gateContext(repo);
    const detected = await gate3CommitStep.detect!(ctx);
    const form = gate3CommitStep.form!(ctx, detected)!;
    const text = JSON.stringify(form);
    expect(form.description?.replaceAll('\\', '')).toContain('nested/');
    expect(text).toMatch(/commit inside/i);
    expect(text).toMatch(/remove it/i);
    expect(text).toMatch(/leave it out/i);
    expect(text).toMatch(/left out/i);
  });

  it.each(['nested', 'nested [x]', ':magic'])(
    'commits other changes and leaves unborn %s intact and untracked',
    async (name) => {
      const repo = await fixture(false, name);
      expect((await commit(repo)).committed).toBe(true);
      expect(await git(repo, ['show', 'HEAD:a.txt'])).toBe('after\n');
      expect(await git(repo, ['ls-tree', 'HEAD', '--', `:(literal)${name}`])).toBe('');
      expect(await readTextNoFollow(repo, `${name}/inside.txt`)).toBe('nested contents\n');
      expect(await git(repo, ['status', '--porcelain', '-z', '-uall'])).toBe(`?? ${name}/\0`);
    },
  );

  it('keeps the existing gitlink behavior for a nested repository with commits', async () => {
    const repo = await fixture(true);
    const nestedHead = (await git(path.join(repo, 'nested'), ['rev-parse', 'HEAD'])).trim();
    expect((await commit(repo)).committed).toBe(true);
    expect(await git(repo, ['ls-tree', 'HEAD', '--', 'nested'])).toBe(
      `160000 commit ${nestedHead}\tnested\n`,
    );
  });

  it.each(['scratch', 'scratch [x]', ':scratch', 'scratch\nline'])(
    'excludes only the unborn dependency checkout %s and commits the owned edit',
    async (name) => {
      const nested = `modules/contrib/${name}`;
      const repo = await fixture(false, nested);
      expect(await commit(repo)).toMatchObject({
        committed: true,
        excludedRepositories: [`${nested}/`],
      });
      expect(await git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe(
        'a.txt\n',
      );
      expect(await git(repo, ['show', 'HEAD:a.txt'])).toBe('after\n');
      expect(await git(repo, ['ls-tree', 'HEAD', '--', `:(literal)${nested}`])).toBe('');
      expect(await readTextNoFollow(repo, `${nested}/inside.txt`)).toBe('nested contents\n');
      expect(await git(repo, ['status', '--porcelain', '-z', '-uall'])).toBe(`?? ${nested}/\0`);
    },
  );

  it.each(['modified', 'new'])(
    'still refuses %s third-party source beside an excluded unborn checkout',
    async (state) => {
      const repo = await fixture(false, 'modules/contrib/scratch');
      const upstream = 'modules/contrib/scratch-sibling/source.php';
      await writeFileNoFollow(repo, upstream, 'upstream baseline\n', { createParents: true });
      if (state === 'modified') {
        await git(repo, ['add', '--', upstream]);
        await git(repo, ['commit', '-q', '-m', 'upstream baseline']);
        await writeFileNoFollow(repo, upstream, 'upstream edit\n');
      }
      const head = await git(repo, ['rev-parse', 'HEAD']);
      await expect(commit(repo)).rejects.toThrow(`changed upstream source: ${upstream}.`);
      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
      expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('');
    },
  );

  it.each([false, true])(
    'keeps the baseline ownership decision for a committed dependency checkout (owned: %s)',
    async (owned) => {
      const nested = 'modules/contrib/scratch';
      const repo = await fixture(true, nested);
      if (owned) {
        await writeFileNoFollow(
          repo,
          '.haive-data/dependency-ownership.json',
          JSON.stringify({ ownedPaths: [nested] }),
          { createParents: true },
        );
        await git(repo, ['add', '--', '.haive-data/dependency-ownership.json']);
        await git(repo, ['commit', '-q', '-m', 'operator ownership']);
      }
      if (owned) {
        expect((await commit(repo)).committed).toBe(true);
        expect(await git(repo, ['ls-tree', 'HEAD', '--', nested])).toMatch(/^160000 commit /);
      } else {
        await expect(commit(repo)).rejects.toThrow(`changed upstream source: ${nested}/.`);
      }
    },
  );

  it.each(['lost first commit', 'gained first commit', 'became ordinary directory', 'legacy'])(
    'proves current dependency exclusions for a stale gate payload: %s',
    async (transition) => {
      const nested = 'modules/contrib/scratch';
      const repo = await fixture(transition === 'lost first commit', nested);
      const ctx = gateContext(repo);
      const detected = await gate3CommitStep.detect!(ctx);
      if (transition === 'lost first commit') {
        await git(path.join(repo, nested), ['update-ref', '-d', 'refs/heads/main']);
      } else if (transition === 'gained first commit') {
        await git(path.join(repo, nested), ['add', '-A']);
        await git(path.join(repo, nested), ['commit', '-q', '-m', 'first commit']);
      } else if (transition === 'became ordinary directory') {
        await removeNoFollow(repo, `${nested}/.git`, { recursive: true });
      } else {
        delete detected.excludedRepositories;
      }
      const apply = gate3CommitStep.apply(ctx, {
        detected,
        formValues: { commit: true, commitMessage: 'fix: stale gate' },
        iteration: 0,
        previousIterations: [],
      });
      if (transition === 'gained first commit' || transition === 'became ordinary directory') {
        await expect(apply).rejects.toThrow('changed upstream source');
      } else {
        expect(await apply).toMatchObject({
          committed: true,
          excludedRepositories: [`${nested}/`],
        });
        expect(await git(repo, ['show', 'HEAD:a.txt'])).toBe('after\n');
      }
    },
  );

  it('still refuses earlier committed upstream changes against the fork point', async () => {
    const repo = await fixture(false, 'modules/contrib/scratch');
    const upstream = 'modules/contrib/existing/source.php';
    await writeFileNoFollow(repo, upstream, 'baseline\n', { createParents: true });
    await git(repo, ['add', '--', upstream]);
    await git(repo, ['commit', '-q', '-m', 'upstream baseline']);
    await git(repo, ['branch', 'task-base']);
    await writeFileNoFollow(repo, upstream, 'earlier issue edit\n');
    await git(repo, ['add', '--', upstream]);
    await git(repo, ['commit', '-q', '-m', 'earlier issue']);
    const ctx = gateContext(repo);
    const detected = await gate3CommitStep.detect!(ctx);
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => [{ output: { baseBranch: 'task-base' } }],
    });
    ctx.db.select = (() => chain) as unknown as typeof ctx.db.select;
    await expect(
      gate3CommitStep.apply(ctx, {
        detected,
        formValues: { commit: true, commitMessage: 'fix: finalize' },
        iteration: 0,
        previousIterations: [],
      }),
    ).rejects.toThrow(`changed upstream source: ${upstream}.`);
  });

  it.each(['submission status', 'guard status', 'nested HEAD'])(
    'fails closed before staging when the %s read fails',
    async (read) => {
      const repo = await fixture(false, 'modules/contrib/scratch');
      const ctx = gateContext(repo);
      const detected = await gate3CommitStep.detect!(ctx);
      const before = await git(repo, ['rev-parse', 'HEAD']);
      const shim = await failGit(
        read === 'nested HEAD' ? ['--git-dir=.git'] : ['--no-optional-locks', 'status'],
        { from: read === 'guard status' ? 2 : 1 },
      );
      try {
        await expect(
          gate3CommitStep.apply(ctx, {
            detected,
            formValues: { commit: true, commitMessage: 'fix: finalize' },
            iteration: 0,
            previousIterations: [],
          }),
        ).rejects.toThrow(
          read === 'nested HEAD'
            ? 'HEAD could not be read'
            : read === 'guard status'
              ? 'Cannot check dependency changes'
              : 'git status failed',
        );
      } finally {
        await shim.restore();
      }
      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before);
      expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('');
      expect(await readTextNoFollow(repo, 'modules/contrib/scratch/inside.txt')).toBe(
        'nested contents\n',
      );
    },
  );

  it('defaults off and skips generation when only an unborn repository is dirty', async () => {
    const repo = await fixture();
    await writeFileNoFollow(repo, 'a.txt', 'before\n');
    const ctx = gateContext(repo);
    const detected = await gate3CommitStep.detect!(ctx);
    expect(
      gate3CommitStep.form!(ctx, detected)!.fields.find((f) => f.id === 'commit'),
    ).toMatchObject({ default: false });
    expect(gate3CommitStep.llm!.skipIf!({ detected, formValues: {} })).toBe(true);
    const before = await git(repo, ['rev-parse', 'HEAD']);
    expect(await commit(repo)).toMatchObject({
      committed: false,
      message: 'nothing to commit',
      excludedRepositories: ['nested/'],
    });
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before);
  });

  it('still stages deletions, renames, new files and a similarly named sibling', async () => {
    const repo = await fixture();
    await git(repo, ['mv', 'a.txt', 'renamed.txt']);
    await writeFileNoFollow(repo, 'gone.txt', 'delete me\n');
    await git(repo, ['add', '--', 'gone.txt']);
    await git(repo, ['commit', '-q', '-m', 'seed deletion']);
    await removeNoFollow(repo, 'gone.txt');
    await writeFileNoFollow(repo, 'renamed.txt', 'changed again\n');
    await writeFileNoFollow(repo, 'nested-sibling/new.txt', 'new\n', { createParents: true });
    expect((await commit(repo)).committed).toBe(true);
    expect(await git(repo, ['show', 'HEAD:renamed.txt'])).toBe('changed again\n');
    expect(await git(repo, ['show', 'HEAD:nested-sibling/new.txt'])).toBe('new\n');
    expect(await git(repo, ['ls-tree', 'HEAD', '--', 'gone.txt', 'nested'])).toBe('');
  });

  it.each([false, true])(
    'rechecks nested HEAD when Finalise runs (committed at detection: %s)',
    async (committed) => {
      const repo = await fixture(committed);
      const ctx = gateContext(repo);
      const detected = await gate3CommitStep.detect!(ctx);
      if (committed) await git(path.join(repo, 'nested'), ['update-ref', '-d', 'refs/heads/main']);
      else {
        await git(path.join(repo, 'nested'), ['add', '-A']);
        await git(path.join(repo, 'nested'), ['commit', '-q', '-m', 'first commit']);
      }
      expect(
        (
          await gate3CommitStep.apply(ctx, {
            detected,
            formValues: { commit: true, commitMessage: 'fix: finalize' },
            iteration: 0,
            previousIterations: [],
          })
        ).committed,
      ).toBe(true);
      const entry = await git(repo, ['ls-tree', 'HEAD', '--', 'nested']);
      if (committed) expect(entry).toBe('');
      else expect(entry).toMatch(/^160000 commit /);
    },
  );

  it('works in a feature worktree and leaves the parent checkout unchanged', async () => {
    const { repo, cleanup } = await repoFixture();
    cleanups.push(cleanup);
    const workspace = path.join(repo, '.haive/worktrees/feature');
    await git(repo, ['worktree', 'add', '-q', '-b', 'feature', workspace]);
    await ensureDirNoFollow(repo, '.haive/worktrees/feature/nested');
    await git(path.join(workspace, 'nested'), ['init', '-q']);
    await writeFileNoFollow(repo, '.haive/worktrees/feature/nested/inside.txt', 'kept\n');
    await writeFileNoFollow(repo, '.haive/worktrees/feature/a.txt', 'feature change\n');
    expect((await commit(workspace)).committed).toBe(true);
    expect(await git(workspace, ['show', 'HEAD:a.txt'])).toBe('feature change\n');
    expect(await git(repo, ['show', 'HEAD:a.txt'])).toBe('before\n');
    expect(await git(workspace, ['status', '--porcelain', '-z', '-uall'])).toBe('?? nested/\0');
  });
});

import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  writeFileNoFollow,
  readFileNoFollow,
  removeNoFollow,
  ensureDirNoFollow,
} from '@haive/shared/fs-safe';
import { gateContext, git, repoFixture } from '../../../../test/support/nested-repo.js';

vi.mock('../workflow/_app-runtime.js', () => ({
  ensureAppServing: async () => ({ mode: 'none', url: null }),
}));
import * as commitDiff from '../workflow/_commit-diff.js';
import * as gitExec from '../../../repo/git-exec.js';
import * as branchRevert from '../../../project-state/branch-revert.js';
import * as gitPush from '../../../repo/git-push.js';
import { runAppReadyStep } from './99-run-app-ready.js';
import { ReopenStepFormError } from '../../step-definition.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const { repo, cleanup } = await repoFixture();
  cleanups.push(cleanup);
  const ctx = gateContext(repo);
  ctx.logger.warn = vi.fn();
  return { repo, ctx };
}
const finish = (
  ctx: ReturnType<typeof gateContext>,
  detected: Awaited<ReturnType<NonNullable<typeof runAppReadyStep.detect>>>,
) =>
  runAppReadyStep.apply(ctx, {
    detected,
    formValues: { commit: true },
    iteration: 0,
    previousIterations: [],
  });

it('reopens an initially empty preview to review edits made during the session', async () => {
  const { repo, ctx } = await setup();
  const detected = await runAppReadyStep.detect!(ctx);
  expect(detected.commitPreview?.paths).toEqual([]);
  const head = await git(repo, ['rev-parse', 'HEAD']);
  await writeFileNoFollow(repo, 'a.txt', 'later session edit\n');
  const index = await git(repo, ['ls-files', '-s']);
  await expect(finish(ctx, detected)).rejects.toMatchObject({
    constructor: ReopenStepFormError,
    notice: true,
    message:
      'The edits changed since the commit preview. Review the refreshed preview before finishing.',
  });
  expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
  expect(await git(repo, ['ls-files', '-s'])).toBe(index);
  const refreshed = await runAppReadyStep.detect!(ctx);
  expect(refreshed.commitPreview?.paths).toEqual(['a.txt']);
  expect(refreshed.changedFileCount).toBe(1);
  const artifact = JSON.parse(
    (await readFileNoFollow(repo, '.haive/gate3-diff.json'))!.data.toString('utf8'),
  );
  expect(artifact.files.map((file: { path: string }) => file.path)).toEqual(['a.txt']);
  expect(await finish(ctx, refreshed)).toMatchObject({ committed: true });
});

it('finishes an initially empty preview without edits as nothing to commit', async () => {
  const { repo, ctx } = await setup();
  const detected = await runAppReadyStep.detect!(ctx);
  expect(detected.commitPreview?.paths).toEqual([]);
  const head = await git(repo, ['rev-parse', 'HEAD']);
  expect(await finish(ctx, detected)).toMatchObject({
    finished: true,
    committed: false,
    message: 'nothing to commit',
  });
  expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
});

it('commits only previewed paths and leaves a later staged file in the index', async () => {
  const { repo, ctx } = await setup();
  await writeFileNoFollow(repo, 'a.txt', 'previewed\n');
  const detected = await runAppReadyStep.detect!(ctx);
  expect(
    detected.commitPreview,
    vi
      .mocked(ctx.logger.warn)
      .mock.calls.map((args) => String((args[0] as { err: unknown }).err))
      .join('; '),
  ).toBeTruthy();
  await writeFileNoFollow(repo, 'later.txt', 'unseen\n');
  await git(repo, ['add', '--', 'later.txt']);
  expect(await finish(ctx, detected)).toMatchObject({ committed: true });
  expect(await git(repo, ['show', '--format=', '--name-only', 'HEAD'])).toBe('a.txt\n');
  expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('later.txt\n');
});

it('refuses a changed previewed file before staging or committing', async () => {
  const { repo, ctx } = await setup();
  await writeFileNoFollow(repo, 'a.txt', 'previewed\n');
  const detected = await runAppReadyStep.detect!(ctx);
  expect(
    detected.commitPreview,
    vi
      .mocked(ctx.logger.warn)
      .mock.calls.map((args) => String((args[0] as { err: unknown }).err))
      .join('; '),
  ).toBeTruthy();
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const index = await git(repo, ['ls-files', '-s']);
  await writeFileNoFollow(repo, 'a.txt', 'unseen bytes\n');
  await expect(finish(ctx, detected)).rejects.toThrow(/preview.*changed|changed.*preview/i);
  expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
  expect(await git(repo, ['ls-files', '-s'])).toBe(index);
});

it.each(['addition', 'deletion'] as const)(
  'recognizes its already committed %s after a restart without making another commit',
  async (kind) => {
    const { repo, ctx } = await setup();
    if (kind === 'addition') await writeFileNoFollow(repo, 'added.txt', 'previewed\n');
    else await removeNoFollow(repo, 'a.txt');
    const detected = await runAppReadyStep.detect!(ctx);
    expect(detected.commitPreview?.paths).toContain(kind === 'addition' ? 'added.txt' : 'a.txt');
    expect(await finish(ctx, detected)).toMatchObject({ committed: true });
    const sha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await writeFileNoFollow(repo, 'later.txt', 'unreviewed\n');
    await git(repo, ['add', '--', 'later.txt']);
    expect(await finish(gateContext(repo), structuredClone(detected))).toMatchObject({
      committed: true,
      commitSha: sha,
    });
    expect((await git(repo, ['rev-parse', 'HEAD'])).trim()).toBe(sha);
    expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('later.txt\n');
  },
);

it('reopens for a foreign empty commit on top of the preview even when its tree is identical', async () => {
  const { repo, ctx } = await setup();
  await writeFileNoFollow(repo, 'a.txt', 'previewed\n');
  const detected = await runAppReadyStep.detect!(ctx);
  await finish(ctx, detected);
  await git(repo, ['commit', '--allow-empty', '-m', 'chore: run-app session edits']);
  const head = await git(repo, ['rev-parse', 'HEAD']);
  expect((await git(repo, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe(detected.commitPreview!.tree);
  await expect(finish(gateContext(repo), detected)).rejects.toThrow(/preview/i);
  expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
});

it('excludes Haive projections from the preview and commit, even when staged', async () => {
  const { repo, ctx } = await setup();
  await writeFileNoFollow(repo, 'a.txt', 'previewed\n');
  await writeFileNoFollow(repo, '.haive-data/plan.json', '{"state":"unseen"}', {
    createParents: true,
  });
  await git(repo, ['add', '--', '.haive-data/plan.json']);
  const detected = await runAppReadyStep.detect!(ctx);
  expect(
    detected.commitPreview,
    vi
      .mocked(ctx.logger.warn)
      .mock.calls.map((args) => String((args[0] as { err: unknown }).err))
      .join('; '),
  ).toBeTruthy();
  const artifact = JSON.parse(
    (await readFileNoFollow(repo, '.haive/gate3-diff.json'))!.data.toString('utf8'),
  );
  expect(artifact.files.map((f: { path: string }) => f.path)).toEqual(['a.txt']);
  expect(await finish(ctx, detected)).toMatchObject({ committed: true });
  expect(await git(repo, ['show', '--format=', '--name-only', 'HEAD'])).toBe('a.txt\n');
  expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('.haive-data/plan.json\n');
});

it('requires a fresh preview for a legacy parked form', async () => {
  const { repo, ctx } = await setup();
  await writeFileNoFollow(repo, 'a.txt', 'unseen\n');
  await expect(finish(ctx, { workspacePath: repo, hasGit: true } as never)).rejects.toThrow(
    /preview/i,
  );
});

it('commits the reviewed bytes when the terminal writes again during the commit', async () => {
  const { repo, ctx } = await setup();
  await writeFileNoFollow(repo, 'a.txt', 'reviewed bytes');
  const detected = await runAppReadyStep.detect!(ctx);
  const real = gitExec.gitRun;
  let edited = false;
  vi.spyOn(gitExec, 'gitRun').mockImplementation(async (...args) => {
    if (['commit', 'commit-tree'].includes(args[1][0]!)) {
      edited = true;
      await writeFileNoFollow(repo, 'a.txt', 'later terminal edit');
    }
    return real(...args);
  });
  expect(await finish(ctx, detected)).toMatchObject({ committed: true });
  expect(edited).toBe(true);
  expect(await git(repo, ['show', 'HEAD:a.txt'])).toBe('reviewed bytes');
  expect((await readFileNoFollow(repo, 'a.txt'))!.data.toString()).toBe('later terminal edit');
});

it('keeps a competing commit when HEAD moves after preview validation', async () => {
  const { repo, ctx } = await setup();
  await writeFileNoFollow(repo, 'a.txt', 'reviewed bytes');
  const detected = await runAppReadyStep.detect!(ctx);
  const real = gitExec.gitRun;
  let otherHead = '';
  vi.spyOn(gitExec, 'gitRun').mockImplementation(async (...args) => {
    if (args[1][0] === 'update-ref') {
      await git(repo, ['commit', '--allow-empty', '-m', 'competing commit']);
      otherHead = await git(repo, ['rev-parse', 'HEAD']);
    }
    return real(...args);
  });
  await expect(finish(ctx, detected)).rejects.toThrow(/branch changed/i);
  expect(otherHead).not.toBe('');
  expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(otherHead);
  expect(await git(repo, ['show', 'HEAD:a.txt'])).toBe('before\n');
});

it.each(['unreadable', 'truncated'] as const)(
  'allows finishing without committing when the preview is %s',
  async (kind) => {
    const { repo, ctx } = await setup();
    const head = await git(repo, ['rev-parse', 'HEAD']);
    if (kind === 'truncated') {
      await Promise.all(
        Array.from({ length: commitDiff.MAX_FILES + 1 }, (_, i) =>
          writeFileNoFollow(repo, `file-${i}.txt`, 'session edit'),
        ),
      );
    } else {
      await writeFileNoFollow(repo, 'a.txt', 'session edit');
      vi.spyOn(commitDiff, 'buildCommitDiffArtifact').mockRejectedValue(
        new Error('diff unavailable'),
      );
    }
    const detected = await runAppReadyStep.detect!(ctx);
    expect(detected.commitPreview).toBeNull();
    const form = runAppReadyStep.form!(ctx, detected)!;
    expect(form.fields.some((field) => field.id === 'commit')).toBe(false);
    expect(form.fields.some((field) => field.id === 'commitMessage')).toBe(false);
    expect(JSON.stringify(form)).toMatch(/preview.*unavailable/i);
    expect(JSON.stringify(form)).toMatch(/terminal/i);
    if (kind === 'truncated') expect(JSON.stringify(form)).toMatch(/not all.*shown/i);
    expect(
      await runAppReadyStep.apply(ctx, {
        detected,
        formValues: { commit: false },
        iteration: 0,
        previousIterations: [],
      }),
    ).toMatchObject({ finished: true, committed: false, message: 'finished without committing' });
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
  },
);

it.each([false, true])(
  'judges gitlink registration on the pinned tree (registration previewed=%s)',
  async (registeredInPreview) => {
    const { repo, ctx } = await setup();
    await ensureDirNoFollow(repo, 'nested');
    await git(path.join(repo, 'nested'), ['init', '-q', '-b', 'main']);
    await writeFileNoFollow(repo, 'nested/inner.txt', 'nested\n');
    await git(path.join(repo, 'nested'), ['add', '-A']);
    await git(path.join(repo, 'nested'), ['commit', '-qm', 'nested']);
    const register = () =>
      writeFileNoFollow(
        repo,
        '.gitmodules',
        '[submodule "lib"]\n\tpath = nested\n\turl = https://example.invalid/nested.git\n',
      );
    if (registeredInPreview) await register();
    const detected = await runAppReadyStep.detect!(ctx);
    expect(detected.commitPreview?.paths).toContain('nested');
    if (!registeredInPreview) await register();
    await git(repo, ['add', '--', '.gitmodules']);
    const index = await git(repo, ['ls-files', '-s']);
    const head = await git(repo, ['rev-parse', 'HEAD']);
    if (registeredInPreview) {
      expect(await finish(ctx, detected)).toMatchObject({ committed: true });
      expect(await git(repo, ['show', 'HEAD:.gitmodules'])).toContain('path = nested');
    } else {
      await expect(finish(ctx, detected)).rejects.toThrow(
        'Nothing was committed. These paths are nested git repositories that are not registered as a submodule:',
      );
      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
      expect(await git(repo, ['ls-files', '-s'])).toBe(index);
    }
  },
);

it('refuses a branch switch after the preview recheck without moving either branch or index', async () => {
  const { repo, ctx } = await setup();
  await writeFileNoFollow(repo, 'a.txt', 'reviewed');
  const detected = await runAppReadyStep.detect!(ctx);
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const real = gitExec.gitRun;
  let index = '';
  vi.spyOn(gitExec, 'gitRun').mockImplementation(async (...args) => {
    if (args[1][0] === 'commit-tree') {
      await git(repo, ['switch', '-c', 'other']);
      await writeFileNoFollow(repo, 'a.txt', 'new branch staged bytes');
      await git(repo, ['add', '--', 'a.txt']);
      index = await git(repo, ['ls-files', '-s']);
    }
    return real(...args);
  });
  await expect(finish(ctx, detected)).rejects.toThrow(
    'The branch changed since the commit preview.',
  );
  expect(index).not.toBe('');
  expect(await git(repo, ['rev-parse', 'main'])).toBe(head);
  expect(await git(repo, ['rev-parse', 'other'])).toBe(head);
  expect(await git(repo, ['ls-files', '-s'])).toBe(index);
});

it.each(['put-back', 'push'] as const)(
  'Retry checks its branch again before %s after recognizing a landed preview',
  async (seam) => {
    const { repo, ctx } = await setup();
    await writeFileNoFollow(repo, 'a.txt', 'reviewed');
    const detected = await runAppReadyStep.detect!(ctx);
    await finish(ctx, detected);
    const head = await git(repo, ['rev-parse', 'HEAD']);
    Object.assign(detected, { hasOrigin: true, branch: 'main', baseBranch: 'base' });
    const putBack = vi.spyOn(branchRevert, 'putBackProjections').mockResolvedValue([]);
    const push = vi.spyOn(gitPush, 'pushBranch').mockResolvedValue({
      pushed: true,
      remote: 'origin',
      branch: 'main',
    });
    let index = '';
    const switchBranch = async () => {
      await git(repo, ['switch', '-c', 'other']);
      await writeFileNoFollow(repo, 'a.txt', 'other staged bytes');
      await git(repo, ['add', '--', 'a.txt']);
      index = await git(repo, ['ls-files', '-s']);
    };
    if (seam === 'put-back') {
      const real = gitExec.gitRun;
      vi.spyOn(gitExec, 'gitRun').mockImplementation(async (...args) => {
        const result = await real(...args);
        if (args[1].includes('--format=%P%n%T')) await switchBranch();
        return result;
      });
    } else {
      putBack.mockImplementationOnce(async () => {
        await switchBranch();
        return [];
      });
    }
    let note = '';
    try {
      note = (
        await runAppReadyStep.apply(ctx, {
          detected,
          formValues: { commit: true, push: true },
          iteration: 0,
          previousIterations: [],
        })
      ).message;
    } catch (error) {
      note = (error as Error).message;
    }
    expect(index).not.toBe('');
    expect(push).not.toHaveBeenCalled();
    expect(putBack).toHaveBeenCalledTimes(seam === 'put-back' ? 0 : 1);
    expect(note).toMatch(/landed on refs\/heads\/main.*branch/s);
    expect(await git(repo, ['rev-parse', 'main'])).toBe(head);
    expect(await git(repo, ['rev-parse', 'other'])).toBe(head);
    expect(await git(repo, ['ls-files', '-s'])).toBe(index);
  },
);

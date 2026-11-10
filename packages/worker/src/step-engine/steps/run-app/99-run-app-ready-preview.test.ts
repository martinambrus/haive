import { afterEach, expect, it, vi } from 'vitest';
import { writeFileNoFollow, readFileNoFollow } from '@haive/shared/fs-safe';
import { gateContext, git, repoFixture } from '../../../../test/support/nested-repo.js';

vi.mock('../workflow/_app-runtime.js', () => ({
  ensureAppServing: async () => ({ mode: 'none', url: null }),
}));
import * as gitExec from '../../../repo/git-exec.js';
import { runAppReadyStep } from './99-run-app-ready.js';

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

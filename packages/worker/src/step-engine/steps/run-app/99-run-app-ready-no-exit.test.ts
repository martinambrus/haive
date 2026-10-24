import { fixtureBase, networkGitArgs } from '../../../../test/support/git-http.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  loadPreviousStepOutput: vi.fn(),
  ensureAppServing: vi.fn(),
}));

vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput: m.loadPreviousStepOutput,
}));
vi.mock('../workflow/_app-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workflow/_app-runtime.js')>()),
  ensureAppServing: m.ensureAppServing,
}));

import { failGit, type FakeGit } from '../../../../test/support/fake-git.js';
import { killGit, type KilledGit } from '../../../../test/support/kill-git.js';
import { runAppReadyStep } from './99-run-app-ready.js';

const BRANCH_READ = ['rev-parse', '--abbrev-ref', 'HEAD'];

const warn = vi.fn();
const ctx = {
  taskId: 'task-1',
  workspacePath: '/repos/u/r',
  db: { query: { tasks: { findFirst: vi.fn(async () => ({ exposeDbPort: false })) } } },
  logger: { info: vi.fn(), warn },
} as never;

const git = (cwd: string, args: string[]) =>
  execFileSync('git', networkGitArgs(args), { cwd, stdio: 'pipe' });

describe('run-app ready gate when the branch read gives no answer', () => {
  let dirs: string[] = [];
  let shim: KilledGit | FakeGit | null = null;

  async function makeRepo(withOrigin: boolean): Promise<string> {
    const repo = await mkdtemp(path.join(fixtureBase, 'run-app-ready-'));
    dirs.push(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'gc.auto', '0']);
    git(repo, ['config', 'user.email', 't@example.com']);
    git(repo, ['config', 'user.name', 't']);
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'one']);
    if (withOrigin) {
      const bare = await mkdtemp(path.join(fixtureBase, 'run-app-ready-origin-'));
      dirs.push(bare);
      git(bare, ['init', '--bare', '-b', 'main']);
      git(repo, ['remote', 'add', 'origin', `file://${bare}`]);
    }
    m.loadPreviousStepOutput.mockImplementation(async (_db: unknown, _id: string, step: string) =>
      step === '01-worktree-setup' ? { output: { worktreePath: repo } } : null,
    );
    return repo;
  }

  const detect = () => runAppReadyStep.detect!(ctx);

  beforeEach(() => {
    m.loadPreviousStepOutput.mockReset().mockResolvedValue(null);
    m.ensureAppServing.mockReset().mockResolvedValue({ mode: 'host', url: 'http://app.local' });
    warn.mockClear();
  });

  afterEach(async () => {
    await shim?.restore();
    shim = null;
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs = [];
  });

  it('records why and offers no push when the branch read is killed', async () => {
    await makeRepo(true);
    shim = await killGit(BRANCH_READ);

    const detected = await detect();
    const form = runAppReadyStep.form!(ctx, detected)!;
    const notes = form.fields.filter((f) => f.type === 'note');

    expect(detected.branch).toBeNull();
    expect(detected.branchError).toMatch(/could not read the checkout's current branch/);
    expect(form.fields.map((f) => f.id)).not.toContain('push');
    expect(form.fields.map((f) => f.id)).toContain('commit');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ variant: 'warning' });
    expect((notes[0] as { body: string }).body).toContain(detected.branchError!);
  });

  it('offers the push for a healthy branch read (negative control)', async () => {
    await makeRepo(true);

    const detected = await detect();
    const form = runAppReadyStep.form!(ctx, detected)!;

    expect(detected.branch).toBe('main');
    expect(detected.branchError ?? null).toBeNull();
    expect(form.fields.map((f) => f.id)).toContain('push');
    expect(form.fields.filter((f) => f.type === 'note')).toHaveLength(0);
  });

  it('records why and offers no push when the branch read exits non-zero', async () => {
    await makeRepo(true);
    shim = await failGit(BRANCH_READ, { exit: 128 });

    const detected = await detect();
    const form = runAppReadyStep.form!(ctx, detected)!;
    const notes = form.fields.filter((f) => f.type === 'note');

    expect(detected.branch).toBeNull();
    expect(detected.branchError).toMatch(/could not read the checkout's current branch/);
    expect(form.fields.map((f) => f.id)).not.toContain('push');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ variant: 'warning' });
    expect((notes[0] as { body: string }).body).toContain(detected.branchError!);
  });

  it('shows no note and no push for a killed read with no origin remote (negative control)', async () => {
    await makeRepo(false);
    shim = await killGit(BRANCH_READ);

    const detected = await detect();
    const form = runAppReadyStep.form!(ctx, detected)!;

    expect(detected.hasOrigin).toBe(false);
    expect(form.fields.map((f) => f.id)).not.toContain('push');
    expect(form.fields.filter((f) => f.type === 'note')).toHaveLength(0);
  });

  it('shows no note and no push for a non-zero branch read with no origin remote (negative control)', async () => {
    await makeRepo(false);
    shim = await failGit(BRANCH_READ, { exit: 128 });

    const detected = await detect();
    const form = runAppReadyStep.form!(ctx, detected)!;

    expect(detected.hasOrigin).toBe(false);
    expect(form.fields.map((f) => f.id)).not.toContain('push');
    expect(form.fields.filter((f) => f.type === 'note')).toHaveLength(0);
  });
});

describe('run-app ready gate apply when a push is asked for', () => {
  let dirs: string[] = [];

  async function makeRepo(withOrigin: boolean, dirty: boolean): Promise<string> {
    const repo = await mkdtemp(path.join(fixtureBase, 'run-app-apply-'));
    dirs.push(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'gc.auto', '0']);
    git(repo, ['config', 'user.email', 't@example.com']);
    git(repo, ['config', 'user.name', 't']);
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'one']);
    if (withOrigin) {
      const bare = await mkdtemp(path.join(fixtureBase, 'run-app-apply-origin-'));
      dirs.push(bare);
      git(bare, ['init', '--bare', '-b', 'main']);
      git(repo, ['remote', 'add', 'origin', `file://${bare}`]);
    }
    if (dirty) await writeFile(path.join(repo, 'b.txt'), 'b\n');
    return repo;
  }

  function mkApplyCtx() {
    let warningMessage: string | null = null;
    const db = {
      query: {
        tasks: { findFirst: async () => ({ repositoryId: null }) },
        users: { findFirst: async () => undefined },
        taskSteps: { findFirst: async () => ({ id: 'step1', warningMessage }) },
      },
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              warningMessage = v.warningMessage as string | null;
              return [{ id: 'step1', warningMessage }];
            },
          }),
        }),
      }),
    };
    const applyCtx = {
      userId: 'u1',
      taskId: 't1',
      taskStepId: 'step1',
      workspacePath: '/repos/u/r',
      db,
      logger: { info: vi.fn(), warn: vi.fn() },
    } as never;
    return { applyCtx, warning: () => warningMessage };
  }

  async function apply(
    repo: string,
    detectedPatch: Record<string, unknown>,
    formValues: Record<string, unknown>,
  ) {
    const { applyCtx, warning } = mkApplyCtx();
    const detected = {
      mode: 'host',
      appUrl: null,
      liveBrowser: null,
      directAccess: false,
      dbAccess: false,
      workspacePath: repo,
      hasGit: true,
      hasOrigin: true,
      branch: null,
      dirtyFiles: 1,
      diffArtifactPath: null,
      changedFileCount: 1,
      ...detectedPatch,
    };
    const out = await runAppReadyStep.apply(applyCtx, {
      detected,
      formValues,
      iteration: 0,
      previousIterations: [],
    } as never);
    return { out, warning };
  }

  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs = [];
  });

  it('warns that a ticked push was not made for a payload parked before branchError existed', async () => {
    const repo = await makeRepo(true, true);
    const { out, warning } = await apply(
      repo,
      {},
      { commit: true, push: true, commitMessage: 'x' },
    );

    expect(out).toMatchObject({ committed: true, pushed: false });
    expect(git(repo, ['log', '--format=%s', '-1']).toString().trim()).toBe('x');
    expect(warning()).toContain('push');
    expect(warning()).toContain('not made');
    expect(warning()).toContain('branch was not read');
  });

  it('warns with the recorded branchError text', async () => {
    const repo = await makeRepo(true, true);
    const { warning } = await apply(
      repo,
      { branchError: "could not read the checkout's current branch: boom" },
      { commit: true, push: true, commitMessage: 'x' },
    );

    expect(warning()).toContain("could not read the checkout's current branch: boom");
  });

  it('warns on a clean tree too and still reports nothing to commit', async () => {
    const repo = await makeRepo(true, false);
    const { out, warning } = await apply(
      repo,
      {},
      { commit: true, push: true, commitMessage: 'x' },
    );

    expect(out).toMatchObject({ committed: false, pushed: false, message: 'nothing to commit' });
    expect(warning()).toContain('not made');
  });

  it('pushes and does not warn for a known branch (negative control)', async () => {
    const repo = await makeRepo(true, true);
    const { out, warning } = await apply(
      repo,
      { branch: 'main' },
      { commit: true, push: true, commitMessage: 'x' },
    );

    expect(out).toMatchObject({ committed: true, pushed: true });
    expect(warning()).toBeNull();
  });

  it('does not warn when no push was asked for (negative control)', async () => {
    const repo = await makeRepo(true, true);
    const { out, warning } = await apply(repo, {}, { commit: true, commitMessage: 'x' });

    expect(out).toMatchObject({ committed: true, pushed: false });
    expect(warning()).toBeNull();
  });

  it('keeps the early return without a warning when commit is unticked or there is no git (negative control)', async () => {
    const repo = await makeRepo(true, true);
    const a = await apply(repo, {}, { commit: false, push: true });
    const b = await apply(repo, { hasGit: false }, { commit: true, push: true });

    expect(a.out).toMatchObject({ committed: false, message: 'finished without committing' });
    expect(a.warning()).toBeNull();
    expect(b.out).toMatchObject({ committed: false, message: 'no git repo' });
    expect(b.warning()).toBeNull();
  });
});

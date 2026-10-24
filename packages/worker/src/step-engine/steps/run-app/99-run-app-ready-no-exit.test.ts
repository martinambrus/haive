import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

describe('run-app ready gate when the branch read gives no answer', () => {
  let dirs: string[] = [];
  let shim: KilledGit | FakeGit | null = null;

  async function makeRepo(withOrigin: boolean): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), 'run-app-ready-'));
    dirs.push(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'gc.auto', '0']);
    git(repo, ['config', 'user.email', 't@example.com']);
    git(repo, ['config', 'user.name', 't']);
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'one']);
    if (withOrigin) {
      const bare = await mkdtemp(path.join(tmpdir(), 'run-app-ready-origin-'));
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

  it('keeps a plain non-zero exit meaning: no branch, push still offered (negative control)', async () => {
    await makeRepo(true);
    shim = await failGit(BRANCH_READ, { exit: 128 });

    const detected = await detect();
    const form = runAppReadyStep.form!(ctx, detected)!;

    expect(detected.branch).toBeNull();
    expect(detected.branchError ?? null).toBeNull();
    expect(form.fields.map((f) => f.id)).toContain('push');
    expect(form.fields.filter((f) => f.type === 'note')).toHaveLength(0);
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
});

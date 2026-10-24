import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it, expect } from 'vitest';
import type { Database } from '@haive/database';
import { worktreeSetupStep } from './01-worktree-setup.js';
import type { StepContext } from '../../step-definition.js';
import { killGit, type KilledGit } from '../../../../test/support/kill-git.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const NOTE_ID = 'currentBranchUnreadable';

const roots: string[] = [];
let shim: KilledGit | null = null;

afterEach(async () => {
  await shim?.restore();
  shim = null;
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function git(dir: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: dir, env: GIT_ENV });
}

async function mkRepo(commit: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'wt-setup-noexit-'));
  roots.push(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'gc.auto', '0']);
  if (commit) {
    await writeFile(path.join(root, 'f.txt'), 'one\n', 'utf8');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'one']);
  }
  return root;
}

function mkCtx(root: string, syncRows: unknown[] = []): StepContext {
  return {
    taskId: 'task1',
    userId: 'u1',
    repoPath: root,
    sandboxWorkdir: '/haive/workdir',
    logger,
    db: {
      query: {
        tasks: {
          findFirst: async () => ({
            title: 'Add DDEV',
            description: null,
            metadata: null,
            repositoryId: 'r1',
          }),
        },
      },
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => syncRows }) }),
        }),
      }),
    } as unknown as Database,
  } as unknown as StepContext;
}

const DEVELOP_ROW = [{ detectOutput: null, output: { base: 'develop' }, iterations: [] }];

type Detect = NonNullable<Awaited<ReturnType<NonNullable<typeof worktreeSetupStep.detect>>>>;

function notes(ctx: StepContext, d: Detect) {
  const form = worktreeSetupStep.form!(ctx, d)!;
  return form.fields.filter((f) => f.id === NOTE_ID) as {
    type: string;
    variant?: string;
    body?: string;
  }[];
}

describe('01 worktree setup: a branch read that gave no answer', () => {
  it('records why and warns on the form when no earlier step recorded a base', async () => {
    const root = await mkRepo(true);
    shim = await killGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const ctx = mkCtx(root);
    const d = await worktreeSetupStep.detect!(ctx);
    expect(d.currentBranch).toBeNull();
    expect(d.currentBranchError).toMatch(/could not read the checkout's current branch/);
    const found = notes(ctx, d);
    expect(found).toHaveLength(1);
    expect(found[0]!.type).toBe('note');
    expect(found[0]!.variant).toBe('warning');
    expect(found[0]!.body).toContain(d.currentBranchError!);
  });

  it('keeps the error in detect but shows no note when 00a recorded a base', async () => {
    const root = await mkRepo(true);
    shim = await killGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const ctx = mkCtx(root, DEVELOP_ROW);
    const d = await worktreeSetupStep.detect!(ctx);
    expect(d.syncedBase).toBe('develop');
    expect(d.currentBranchError).toMatch(/could not read the checkout's current branch/);
    expect(notes(ctx, d)).toHaveLength(0);
  });

  it('negative control: a healthy read has the branch, no error, no note', async () => {
    const root = await mkRepo(true);
    const ctx = mkCtx(root);
    const d = await worktreeSetupStep.detect!(ctx);
    expect(d.currentBranch).toBe('main');
    expect(d.currentBranchError ?? null).toBeNull();
    expect(notes(ctx, d)).toHaveLength(0);
  });

  it('negative control: an unborn HEAD (plain exit) stays unknown without an error or note', async () => {
    const root = await mkRepo(false);
    const ctx = mkCtx(root);
    const d = await worktreeSetupStep.detect!(ctx);
    expect(d.currentBranch).toBeNull();
    expect(d.currentBranchError ?? null).toBeNull();
    expect(notes(ctx, d)).toHaveLength(0);
  });

  it('negative control: a stored detect without the field renders its form without the note', async () => {
    const root = await mkRepo(true);
    const ctx = mkCtx(root);
    const d = await worktreeSetupStep.detect!(ctx);
    delete d.currentBranchError;
    expect(() => worktreeSetupStep.form!(ctx, d)).not.toThrow();
    expect(notes(ctx, d)).toHaveLength(0);
  });
});

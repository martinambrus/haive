import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { schema } from '@haive/database';
import { afterEach, describe, expect, it } from 'vitest';
import { gate3CommitStep } from './10-gate-3-commit.js';
import type { StepContext } from '../../step-definition.js';
import { failGit } from '../../../../test/support/fake-git.js';
import { killGit } from '../../../../test/support/kill-git.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const ID_NOTE =
  "The commit landed, but git gave no answer when its id was read, so this task's recorded commit id is not updated.";
const FILES_NOTE =
  "The commit landed, but git gave no answer when its changed files were read, so they are not added to this task's file list.";

interface Recorded {
  taskWrites: Array<Record<string, unknown>>;
  stepWrites: Array<Record<string, unknown>>;
  warning: () => string | null;
}

function mkCtx(
  workspacePath: string,
  storedRow: Record<string, unknown> = { repositoryId: null, changedPaths: [] },
): { ctx: StepContext; rec: Recorded } {
  let warningMessage: string | null = null;
  const rec: Recorded = { taskWrites: [], stepWrites: [], warning: () => warningMessage };
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject),
  });
  const db = {
    select: () => chain,
    query: {
      tasks: { findFirst: async () => storedRow },
      users: { findFirst: async () => undefined },
      taskSteps: { findFirst: async () => ({ id: 'step1', warningMessage }) },
    },
    update: (table: unknown) => ({
      set: (v: Record<string, unknown>) => {
        if (table === schema.tasks) {
          rec.taskWrites.push(v);
          return { where: async () => undefined };
        }
        rec.stepWrites.push(v);
        return {
          where: () => ({
            returning: async () => {
              warningMessage = v.warningMessage as string | null;
              return [{ id: 'step1', warningMessage }];
            },
          }),
        };
      },
    }),
  };
  const ctx = {
    repoPath: workspacePath,
    workspacePath,
    sandboxWorkdir: workspacePath,
    userId: 'u1',
    taskId: 't1',
    taskStepId: 'step1',
    db,
    logger,
  } as unknown as StepContext;
  return { ctx, rec };
}

const dirs: string[] = [];
let shim: { restore(): Promise<void> } | null = null;
afterEach(async () => {
  await shim?.restore();
  shim = null;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function dirtyRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'gate3-noexit-'));
  dirs.push(repo);
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'gc.auto', '0']);
  await writeFile(path.join(repo, 'a.txt'), '1\n', 'utf8');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'c1']);
  await writeFile(path.join(repo, 'a.txt'), '2\n', 'utf8');
  return repo;
}

async function run(
  repo: string,
  install?: () => Promise<{ restore(): Promise<void> }>,
  storedRow?: Record<string, unknown>,
) {
  const { ctx, rec } = mkCtx(repo, storedRow);
  const detected = await gate3CommitStep.detect!(ctx);
  if (install) shim = await install();
  const out = await gate3CommitStep.apply(ctx, {
    detected,
    formValues: { commit: true, commitMessage: 'x' },
    iteration: 0,
    previousIterations: [],
  } as never);
  const write = rec.taskWrites.at(-1) as { commitSha: string | null; changedPaths: string[] };
  return { out: out as { committed: boolean; commitSha: string | null }, rec, write };
}

describe('10-gate-3-commit reads after the commit', () => {
  it('a rev-parse HEAD with no answer leaves the stored id alone and says so', async () => {
    const repo = await dirtyRepo();
    const { out, rec, write } = await run(repo, () => killGit(['rev-parse', 'HEAD']));
    expect(out.committed).toBe(true);
    expect(out.commitSha).toBeNull();
    expect(write).not.toHaveProperty('commitSha');
    expect(write.changedPaths).toContain('a.txt');
    expect(rec.warning()).toContain(ID_NOTE);
  });

  it('a rev-parse HEAD with no answer never overwrites an earlier round id', async () => {
    const repo = await dirtyRepo();
    const { rec, write } = await run(repo, () => killGit(['rev-parse', 'HEAD']), {
      repositoryId: null,
      changedPaths: [],
      commitSha: 'a'.repeat(40),
    });
    expect(write).not.toHaveProperty('commitSha');
    expect(rec.warning()).toContain(ID_NOTE);
  });

  it('a rev-parse HEAD that answers on the second try records the id with no warning', async () => {
    const repo = await dirtyRepo();
    const { out, rec, write } = await run(repo, () => killGit(['rev-parse', 'HEAD'], { times: 1 }));
    const real = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    expect(out.commitSha).toBe(real);
    expect(write.commitSha).toBe(real);
    expect(rec.warning()).toBeNull();
  });

  it('a show --name-only with no answer leaves the file list short and says so', async () => {
    const repo = await dirtyRepo();
    const { out, rec, write } = await run(repo, () =>
      killGit(['show'], { contains: '--name-only' }),
    );
    expect(out.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(write.commitSha).toBe(out.commitSha);
    expect(write.changedPaths).not.toContain('a.txt');
    expect(rec.warning()).toContain(FILES_NOTE);
  });

  it('a show --name-only that answers on the second try records the file with no warning', async () => {
    const repo = await dirtyRepo();
    const { rec, write } = await run(repo, () =>
      killGit(['show'], { contains: '--name-only', times: 1 }),
    );
    expect(write.changedPaths).toContain('a.txt');
    expect(rec.warning()).toBeNull();
  });

  it('a rev-parse HEAD that exits 128 keeps its meaning: no id, no warning', async () => {
    const repo = await dirtyRepo();
    const { out, rec, write } = await run(repo, () => failGit(['rev-parse', 'HEAD']));
    expect(out.committed).toBe(true);
    expect(write.commitSha).toBeNull();
    expect(rec.warning()).toBeNull();
    expect(rec.stepWrites).toEqual([]);
  });

  it('a healthy run records the id and paths with no warning', async () => {
    const repo = await dirtyRepo();
    const { out, rec, write } = await run(repo);
    expect(write.commitSha).toBe(out.commitSha);
    expect(write.changedPaths).toContain('a.txt');
    expect(rec.stepWrites).toEqual([]);
  });
});

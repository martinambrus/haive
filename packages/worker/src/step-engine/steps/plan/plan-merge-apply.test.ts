import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { planMergeStep } from './01-plan-merge.js';
import type { StepContext } from '../../step-definition.js';

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

async function gitCode(dir: string, args: string[]): Promise<number> {
  try {
    await exec('git', args, { cwd: dir, env: GIT_ENV });
    return 0;
  } catch (e) {
    return (e as { code?: number }).code ?? 1;
  }
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function write(dir: string, file: string, body: string): Promise<void> {
  const full = path.join(dir, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, 'utf8');
}

/** A Haive repo and a remote made on its own, sharing no commit: both READMEs collide. */
async function unrelatedPair(): Promise<string> {
  const remote = await mkdtemp(path.join(tmpdir(), 'planmerge-apply-remote-'));
  const local = await mkdtemp(path.join(tmpdir(), 'planmerge-apply-local-'));
  dirs.push(remote, local);
  for (const [dir, readme] of [
    [remote, '# vareska\n\nfrom the forge\n'],
    [local, '# vareska\n\nfrom Haive\n'],
  ] as const) {
    await git(dir, ['init', '-b', 'main']);
    await git(dir, ['config', 'gc.auto', '0']);
    await write(dir, 'README.md', readme);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'initial']);
  }
  await git(local, ['remote', 'add', 'origin', remote]);
  return local;
}

function fakeDb() {
  const events: { eventType: string; payload: unknown }[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === schema.tasks ? [{ repositoryId: 'r1' }] : []),
          orderBy: async () => [],
        }),
      }),
    }),
    query: {
      repositories: { findFirst: async () => ({ credentialsSecretId: null }) },
      users: { findFirst: async () => ({ gitName: 'T', gitEmail: 't@haive.local' }) },
    },
    insert: (table: unknown) => ({
      values: async (v: { eventType: string; payload: unknown }) => {
        if (table === schema.taskEvents) events.push(v);
      },
    }),
  };
  return { db, events };
}

describe('plan merge: the answer pass', () => {
  it("moves the agent's changes outside the conflict aside and commits only the merge", async () => {
    const local = await unrelatedPair();
    const { db, events } = fakeDb();
    const ctx = {
      repoPath: local,
      userId: 'u1',
      taskId: 't1',
      taskStepId: 's1',
      cliProviderId: null,
      db,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as StepContext;
    const detected = await planMergeStep.detect!(ctx);
    expect(detected.conflicts).toEqual(['README.md']);
    const wt = detected.worktreePath;
    await writeFile(path.join(wt, 'README.md'), '# vareska\n\nboth sides\n', 'utf8');
    await writeFile(path.join(wt, 'notes.txt'), 'scratch\n', 'utf8');
    const out = await planMergeStep.apply(ctx, {
      detected,
      formValues: {},
      llmOutput: 'Kept both sides.',
      llmInvocationId: 'inv1',
      iteration: 0,
      previousIterations: [],
    });
    expect(out.resolved).toBe(true);
    expect(await git(wt, ['show', 'HEAD:README.md'])).toBe('# vareska\n\nboth sides\n');
    expect(await gitCode(wt, ['cat-file', '-e', 'HEAD:notes.txt'])).not.toBe(0);
    const moved = path.join(local, '.haive', 'merge-leftovers', 't1', 'inv1', 'files', 'notes.txt');
    expect(await readFile(moved, 'utf8')).toBe('scratch\n');
    expect(events.map((e) => e.eventType)).toContain('merge.fixer_leftovers');
    expect(out.summary).toContain('.haive/merge-leftovers/t1/');
  });
});

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));

import { integrateOrigin } from '../src/queues/plan-mirror-queue.js';
import { PLAN_MERGE_BASELINE_EVENT } from '../src/plan/merge-baseline.js';
import { planMergeStep } from '../src/step-engine/steps/plan/01-plan-merge.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const exec = promisify(execFile);
const IDENTITY = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};

async function git(dir: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: dir, env: { ...process.env, ...IDENTITY } });
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A Haive repo and a remote made on its own, sharing no commit: both READMEs collide. */
async function unrelatedPair(): Promise<string> {
  const remote = await mkdtemp(path.join(tmpdir(), 'planmerge-save-remote-'));
  const local = await mkdtemp(path.join(tmpdir(), 'planmerge-save-local-'));
  dirs.push(remote, local);
  for (const [dir, readme] of [
    [remote, '# vareska\n\nfrom the forge\n'],
    [local, '# vareska\n\nfrom Haive\n'],
  ] as const) {
    await git(dir, ['init', '-b', 'main']);
    await git(dir, ['config', 'gc.auto', '0']);
    await writeFile(path.join(dir, 'README.md'), readme, 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'initial']);
  }
  await git(local, ['remote', 'add', 'origin', remote]);
  return local;
}

type Event = { taskId: string; taskStepId: string; eventType: string; payload: unknown };

function fakeDb() {
  const events: Event[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === schema.tasks ? [{ repositoryId: 'r1' }] : []),
          orderBy: async () => [],
        }),
        innerJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async (n: number) =>
                events
                  .filter((e) => e.eventType === PLAN_MERGE_BASELINE_EVENT)
                  .reverse()
                  .slice(0, n),
            }),
          }),
        }),
      }),
    }),
    query: {
      tasks: { findFirst: async () => ({ userId: 'u1', repositoryId: 'r1' }) },
      repositories: { findFirst: async () => ({ credentialsSecretId: null }) },
      users: { findFirst: async () => ({ gitName: 'T', gitEmail: 't@haive.local' }) },
    },
    insert: (table: unknown) => ({
      values: async (v: Event) => {
        if (table === schema.taskEvents) events.push(v);
      },
    }),
  };
  return { db, events };
}

describe('plan snapshot save and pull: a merge a conversation left open', () => {
  it('moves aside what its fixer left before the scratch worktree is removed', async () => {
    const local = await unrelatedPair();
    const { db, events } = fakeDb();
    h.db = db;
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
    await mkdir(path.join(detected.worktreePath, 'docs'), { recursive: true });
    await writeFile(path.join(detected.worktreePath, 'docs', 'notes.txt'), 'scratch\n', 'utf8');

    const out = await integrateOrigin({
      repositoryId: 'r1',
      repoPath: local,
      branch: 'main',
      userId: 'u1',
      credentialId: null,
      identity: IDENTITY,
    });
    expect(out.conflict?.paths).toEqual(['README.md']);
    const moved = events.find((e) => e.eventType === 'merge.fixer_leftovers');
    expect(moved).toMatchObject({ taskId: 't1', payload: { moved: ['docs/notes.txt'] } });
    const folder = (moved?.payload as { folder: string }).folder;
    expect(await readFile(path.join(local, folder, 'files', 'docs', 'notes.txt'), 'utf8')).toBe(
      'scratch\n',
    );
  });
});

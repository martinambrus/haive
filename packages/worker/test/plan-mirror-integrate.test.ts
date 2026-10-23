import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const flags = { lookupFails: false, liveConversation: false, locked: [] as unknown[] };
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
              limit: async (n: number) => {
                if (flags.lookupFails) throw new Error('lookup failed');
                return events
                  .filter((e) => e.eventType === PLAN_MERGE_BASELINE_EVENT)
                  .reverse()
                  .slice(0, n);
              },
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
    // The conversation these tests leave open is abandoned, so no live one is found under the lock.
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        execute: async (q: unknown) => void flags.locked.push(q),
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => (flags.liveConversation ? [{ id: 't9' }] : []),
            }),
          }),
        }),
      }),
  };
  return { db, events, flags };
}

function contextFor(repoPath: string, db: unknown): StepContext {
  return {
    repoPath,
    userId: 'u1',
    taskId: 't1',
    taskStepId: 's1',
    cliProviderId: null,
    db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as StepContext;
}

async function failingBranchRead(): Promise<() => void> {
  const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  const shimDir = await mkdtemp(path.join(tmpdir(), 'planmerge-branch-shim-'));
  dirs.push(shimDir);
  await writeFile(
    path.join(shimDir, 'git'),
    [
      '#!/bin/sh',
      `for a in "$@"; do if [ "$a" = '--show-current' ]; then echo "fatal: simulated failure" >&2; exit 128; fi; done`,
      `exec ${realGit} "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(path.join(shimDir, 'git'), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${savedPath}`;
  return () => {
    process.env.PATH = savedPath;
  };
}

const integrate = (repoPath: string) =>
  integrateOrigin({
    repositoryId: 'r1',
    repoPath,
    branch: 'main',
    userId: 'u1',
    credentialId: null,
    identity: IDENTITY,
    kept: new Map(),
  });

describe('plan snapshot save and pull: a merge a conversation left open', () => {
  it('moves aside what its fixer left before the scratch worktree is removed', async () => {
    const local = await unrelatedPair();
    const { db, events } = fakeDb();
    h.db = db;
    const detected = await planMergeStep.detect!(contextFor(local, db));
    await mkdir(path.join(detected.worktreePath, 'docs'), { recursive: true });
    await writeFile(path.join(detected.worktreePath, 'docs', 'notes.txt'), 'scratch\n', 'utf8');

    const out = await integrate(local);
    expect(out.conflict?.paths).toEqual(['README.md']);
    const moved = events.find((e) => e.eventType === 'merge.fixer_leftovers');
    expect(moved).toMatchObject({ taskId: 't1', payload: { moved: ['docs/notes.txt'] } });
    const folder = (moved?.payload as { folder: string }).folder;
    expect(await readFile(path.join(local, folder, 'files', 'docs', 'notes.txt'), 'utf8')).toBe(
      'scratch\n',
    );
  });

  it('refuses, under the lock, a save that finds a live conversation, and leaves its worktree', async () => {
    const local = await unrelatedPair();
    const { db, flags } = fakeDb();
    h.db = db;
    const detected = await planMergeStep.detect!(contextFor(local, db));
    const work = path.join(detected.worktreePath, 'notes.txt');
    await writeFile(work, 'in progress\n', 'utf8');
    flags.liveConversation = true;

    await expect(integrate(local)).rejects.toThrow('A merge conversation is open');
    expect(flags.locked).toHaveLength(1);
    expect(await readFile(work, 'utf8')).toBe('in progress\n');
  });

  it('fails the save and keeps the worktree when they cannot be moved aside', async () => {
    const local = await unrelatedPair();
    const { db, flags } = fakeDb();
    h.db = db;
    const detected = await planMergeStep.detect!(contextFor(local, db));
    const stray = path.join(detected.worktreePath, 'notes.txt');
    await writeFile(stray, 'scratch\n', 'utf8');
    flags.lookupFails = true;

    await expect(integrate(local)).rejects.toThrow('lookup failed');
    expect(await readFile(stray, 'utf8')).toBe('scratch\n');
  });

  it('rejects when the divergence read fails instead of reporting nothing to pull', async () => {
    const local = await unrelatedPair();
    const { db } = fakeDb();
    h.db = db;
    const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    const shimDir = await mkdtemp(path.join(tmpdir(), 'planmerge-save-shim-'));
    dirs.push(shimDir);
    await writeFile(
      path.join(shimDir, 'git'),
      [
        '#!/bin/sh',
        `for a in "$@"; do if [ "$a" = 'rev-list' ]; then echo "fatal: simulated failure" >&2; exit 128; fi; done`,
        `exec ${realGit} "$@"`,
        '',
      ].join('\n'),
    );
    await chmod(path.join(shimDir, 'git'), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${savedPath}`;
    try {
      await expect(integrate(local)).rejects.toThrow(/git rev-list failed in/);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('stops the plan-merge detect when the branch read fails instead of finding nothing to merge', async () => {
    const local = await unrelatedPair();
    const { db } = fakeDb();
    const restore = await failingBranchRead();
    try {
      await expect(planMergeStep.detect!(contextFor(local, db))).rejects.toThrow(
        /git branch failed in/,
      );
    } finally {
      restore();
    }
  });

  it('still finds nothing to merge on a detached HEAD', async () => {
    const local = await unrelatedPair();
    await git(local, ['checkout', '--detach']);
    const { db } = fakeDb();
    const detected = await planMergeStep.detect!(contextFor(local, db));
    expect(detected).toMatchObject({ branch: '', conflicts: [], mergeOpen: false });
  });
});

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: vi.fn() }));
vi.mock('../src/lib/plan-mirror.js', () => ({
  enqueuePlanMirrorRefresh: vi.fn(),
  pullPlanMirror: vi.fn(),
  savePlanMirror: vi.fn(),
}));
vi.mock('../src/lib/spawn-plan-task.js', () => ({ spawnPlanTask: vi.fn() }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { HAIVE_DATA_FILES } from '@haive/shared';
import { planRoutes } from '../src/routes/plan.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git']).toString().trim();

const app = new Hono<AppEnv>();
app.route('/', planRoutes);
app.onError(errorHandler);

let base = '';
let root = '';
let shimDir = '';
let logFile = '';
const savedPath = process.env.PATH;

function git(...args: string[]): void {
  execFileSync(REAL_GIT, ['-C', root, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'plan-snapshot-git-'));
  root = path.join(base, 'repo');
  shimDir = path.join(base, 'shim');
  logFile = path.join(base, 'git.log');
  await mkdir(root);
  await mkdir(shimDir);
  await writeFile(logFile, '');
  execFileSync(REAL_GIT, ['init', '-q', '-b', 'main', root], { stdio: 'ignore' });
  git('config', 'gc.auto', '0');
  for (const rel of [HAIVE_DATA_FILES.plan, HAIVE_DATA_FILES.planMarkdown]) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), '{}\n');
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  const origin = path.join(base, 'origin.git');
  execFileSync(REAL_GIT, ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
});

afterEach(async () => {
  process.env.PATH = savedPath;
  await rm(base, { recursive: true, force: true });
});

async function installShim(failArg: string | null): Promise<void> {
  const script = [
    '#!/bin/sh',
    `echo "$*" >> '${logFile}'`,
    failArg === null
      ? ''
      : `for a in "$@"; do if [ "$a" = '${failArg}' ]; then echo "fatal: simulated failure" >&2; exit 128; fi; done`,
    `exec ${REAL_GIT} "$@"`,
    '',
  ].join('\n');
  await writeFile(path.join(shimDir, 'git'), script);
  await chmod(path.join(shimDir, 'git'), 0o755);
}

interface Snapshot {
  gitAvailable: boolean | null;
  tracked: boolean | null;
  uncommitted: boolean | null;
  committed: boolean;
  pushed: boolean | null;
  branch: string | null;
  hasOrigin: boolean | null;
  originUrl: string | null;
}

async function snapshot(failArg: string | null = null): Promise<Snapshot> {
  const fake = createFakeDb({
    repositories: schema.repositories,
    planMirrorState: schema.planMirrorState,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', storagePath: root });
  fake.insert(schema.planMirrorState, { repositoryId: REPO, revision: 1, writtenRevision: 1 });
  h.db = fake.db;
  await installShim(failArg);
  process.env.PATH = `${shimDir}:${savedPath}`;
  try {
    const res = await app.request(`/${REPO}/plan/snapshot`);
    expect(res.status).toBe(200);
    return (await res.json()) as Snapshot;
  } finally {
    process.env.PATH = savedPath;
  }
}

async function ran(sub: string): Promise<boolean> {
  return (await readFile(logFile, 'utf8')).split('\n').some((line) => line.includes(sub));
}

describe('the plan snapshot git state', () => {
  it('reads clean and pushed', async () => {
    expect(await snapshot()).toMatchObject({
      gitAvailable: true,
      tracked: true,
      uncommitted: false,
      committed: true,
      pushed: true,
      branch: 'main',
      hasOrigin: true,
    });
    expect(await ran('rev-list')).toBe(true);
  });

  it('reads an edited plan as uncommitted', async () => {
    await writeFile(path.join(root, HAIVE_DATA_FILES.planMarkdown), 'edited\n');
    expect(await snapshot()).toMatchObject({
      uncommitted: true,
      committed: false,
      pushed: null,
    });
  });

  it('reads an unpushed commit as committed and not pushed', async () => {
    await writeFile(path.join(root, 'other.txt'), 'x\n');
    git('add', 'other.txt');
    git('commit', '-q', '-m', 'other');
    expect(await snapshot()).toMatchObject({
      uncommitted: false,
      committed: true,
      pushed: false,
    });
  });

  it('claims nothing when git status fails', async () => {
    expect(await snapshot('status')).toMatchObject({
      uncommitted: null,
      committed: false,
      pushed: null,
    });
    expect(await ran('rev-list')).toBe(false);
  });

  it('reports every git fact unknown when the work-tree probe fails, and reads nothing more', async () => {
    expect(await snapshot('--is-inside-work-tree')).toEqual({
      revision: 1,
      writtenRevision: 1,
      snapshotState: 'written',
      snapshotWritten: true,
      lastError: null,
      filesExist: true,
      gitAvailable: null,
      tracked: null,
      uncommitted: null,
      committed: false,
      pushed: null,
      branch: null,
      hasOrigin: null,
      originUrl: null,
    });
    for (const sub of ['ls-files', 'status', 'remote', 'branch', 'rev-list']) {
      expect(await ran(sub)).toBe(false);
    }
  });

  it('reports the origin unknown when reading it fails', async () => {
    expect(await snapshot('get-url')).toMatchObject({
      gitAvailable: true,
      hasOrigin: null,
      originUrl: null,
      tracked: true,
      uncommitted: false,
      committed: true,
      pushed: true,
    });
  });

  it('reports tracking unknown when ls-files fails', async () => {
    expect(await snapshot('--error-unmatch')).toMatchObject({
      tracked: null,
      committed: false,
      pushed: null,
    });
  });

  it('reads a repository without an origin as a definite negative', async () => {
    git('remote', 'remove', 'origin');
    expect(await snapshot()).toMatchObject({ hasOrigin: false, originUrl: null, pushed: null });
  });

  it('reads untracked plan files as not tracked', async () => {
    git('rm', '-q', '--cached', HAIVE_DATA_FILES.plan, HAIVE_DATA_FILES.planMarkdown);
    git('commit', '-q', '-m', 'untrack');
    expect(await snapshot()).toMatchObject({ tracked: false, committed: false });
  });

  it('reads a branch as null when it cannot be read', async () => {
    expect(await snapshot('--show-current')).toMatchObject({
      branch: null,
      tracked: true,
      uncommitted: false,
      committed: true,
      pushed: true,
    });
  });
});

describe('the plan snapshot repository root', () => {
  type Row = Record<string, unknown>;
  async function request(row: Row, throwOnCall: number | null) {
    const fake = createFakeDb({
      repositories: schema.repositories,
      planMirrorState: schema.planMirrorState,
    });
    fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', ...row });
    fake.insert(schema.planMirrorState, { repositoryId: REPO, revision: 1, writtenRevision: 1 });
    const repositories = fake.db.query.repositories;
    const inner = repositories.findFirst.bind(repositories);
    let calls = 0;
    repositories.findFirst = ((...args: Parameters<typeof inner>) => {
      calls += 1;
      if (calls === throwOnCall) throw new Error('repositories read failed');
      return inner(...args);
    }) as typeof repositories.findFirst;
    h.db = fake.db;
    const res = await app.request(`/${REPO}/plan/snapshot`);
    return { res, calls: () => calls };
  }

  it('answers from the row it already loaded when a second repositories read would fail', async () => {
    const { res } = await request({ storagePath: root }, 2);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ gitAvailable: true, hasOrigin: true });
  });

  it('reads a row with no checkout path as no checkout, in one repositories read', async () => {
    const { res, calls } = await request({ storagePath: null, localPath: null }, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      filesExist: false,
      gitAvailable: false,
      hasOrigin: false,
    });
    expect(calls()).toBe(1);
  });

  it('fails the request when the ownership read itself fails', async () => {
    const { res } = await request({ storagePath: root }, 1);
    expect(res.status).toBe(500);
  });
});

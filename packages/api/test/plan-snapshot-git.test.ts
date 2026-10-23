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

async function installShim(failStatus: boolean): Promise<void> {
  const script = [
    '#!/bin/sh',
    `echo "$*" >> '${logFile}'`,
    failStatus
      ? 'for a in "$@"; do if [ "$a" = status ]; then echo "fatal: simulated status failure" >&2; exit 128; fi; done'
      : '',
    `exec ${REAL_GIT} "$@"`,
    '',
  ].join('\n');
  await writeFile(path.join(shimDir, 'git'), script);
  await chmod(path.join(shimDir, 'git'), 0o755);
}

async function snapshot(failStatus: boolean) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    planMirrorState: schema.planMirrorState,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', storagePath: root });
  fake.insert(schema.planMirrorState, { repositoryId: REPO, revision: 1, writtenRevision: 1 });
  h.db = fake.db;
  await installShim(failStatus);
  process.env.PATH = `${shimDir}:${savedPath}`;
  try {
    const res = await app.request(`/${REPO}/plan/snapshot`);
    expect(res.status).toBe(200);
    return (await res.json()) as {
      uncommitted: boolean | null;
      committed: boolean;
      pushed: boolean | null;
    };
  } finally {
    process.env.PATH = savedPath;
  }
}

async function sawRevList(): Promise<boolean> {
  return (await readFile(logFile, 'utf8')).split('\n').some((line) => line.includes('rev-list'));
}

describe('the plan snapshot git state', () => {
  it('reads clean and pushed', async () => {
    expect(await snapshot(false)).toMatchObject({
      uncommitted: false,
      committed: true,
      pushed: true,
    });
    expect(await sawRevList()).toBe(true);
  });

  it('reads an edited plan as uncommitted', async () => {
    await writeFile(path.join(root, HAIVE_DATA_FILES.planMarkdown), 'edited\n');
    expect(await snapshot(false)).toMatchObject({
      uncommitted: true,
      committed: false,
      pushed: null,
    });
  });

  it('reads an unpushed commit as committed and not pushed', async () => {
    await writeFile(path.join(root, 'other.txt'), 'x\n');
    git('add', 'other.txt');
    git('commit', '-q', '-m', 'other');
    expect(await snapshot(false)).toMatchObject({
      uncommitted: false,
      committed: true,
      pushed: false,
    });
  });

  it('claims nothing when git status fails', async () => {
    expect(await snapshot(true)).toMatchObject({
      uncommitted: null,
      committed: false,
      pushed: null,
    });
    expect(await sawRevList()).toBe(false);
  });
});

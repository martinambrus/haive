import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  processor: undefined as ((job: unknown, token?: string) => Promise<unknown>) | undefined,
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Worker: class {
    constructor(_name: string, processor: (job: unknown, token?: string) => Promise<unknown>) {
      h.processor = processor;
    }
    on() {
      return this;
    }
  },
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}), getRedis: () => ({}) }));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  acquireRootClaim: async () => ({ release: async () => {}, lost: () => false }),
}));
vi.mock('../src/plan/mirror.js', async (original) => ({
  ...(await original<typeof import('../src/plan/mirror.js')>()),
  seedPlanBaseFromCheckout: async () => {},
}));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger, REPO_JOB_NAMES, type RepoJobPayload } from '@haive/shared';
import { startRepoWorker } from '../src/queues/repo-queue.js';

// A repository's status message is shown to its owner. Git echoes the remote it was given, query and
// fragment included, and a person may have put a token in that query. gitClone and the refresh fetch
// run git's stderr through scrubSecret, which applies redactGitText, so the message the queue stores
// keeps neither. Each case first proves with plain git that the marker would otherwise be echoed,
// then runs the real queue processor against real git. The remote's host is under .invalid, which
// never resolves: git fails at once on the lookup and no connection is made. A loopback port is no
// substitute, since a sandboxed network drops the connection and git waits. Synthetic values only.
const USER = '00000000-0000-4000-8000-000000000001';
const REPO = '00000000-0000-4000-8000-000000000002';
const MARKERS = ['fixture-query-token', 'fixture-fragment'];
const REDACTED = 'https://nonexistent.invalid/repo.git';
const REMOTE = `${REDACTED}?access_token=fixture-query-token#fixture-fragment`;
const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const git = (cwd: string, args: string[]) => exec('git', args, { cwd, env: GIT_ENV });
/** What plain git prints when it fails, which is where a marker would come from. */
const gitStderr = (cwd: string, args: string[]) =>
  git(cwd, args).then(
    () => '',
    (err: { stderr?: string }) => err.stderr ?? '',
  );

const newFakeDb = () => createFakeDb({ repositories: schema.repositories, tasks: schema.tasks });
let base: string;
let fake: ReturnType<typeof newFakeDb>;
const stored = () => fake.rows(schema.repositories).find((r) => r.id === REPO)!;

beforeEach(async () => {
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  base = await mkdtemp(path.join(tmpdir(), 'repo-status-message-'));
  fake = newFakeDb();
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    source: 'git_https',
    remoteUrl: REMOTE,
    status: 'cloning',
  });
  h.db = fake.db;
  startRepoWorker(base);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

const run = (name: string) => {
  const data: RepoJobPayload = {
    repositoryId: REPO,
    userId: USER,
    source: 'git_https',
    remoteUrl: REMOTE,
    branch: 'main',
  };
  return Promise.resolve()
    .then(() => h.processor!({ id: 'job', name, data }, 'token'))
    .then(
      () => null,
      (err: unknown) => err,
    );
};
const expectRedacted = (message: unknown) => {
  expect(typeof message).toBe('string');
  expect(message).toContain(REDACTED);
  for (const marker of MARKERS) expect(message).not.toContain(marker);
};

describe('the message a repository job leaves on the row', () => {
  it('a failed clone stores git’s message without the remote’s query and fragment', async () => {
    const plain = await gitStderr(base, [
      'clone',
      '--depth',
      '1',
      '--',
      REMOTE,
      path.join(base, 'x'),
    ]);
    for (const marker of MARKERS) expect(plain, 'plain git echoes the remote').toContain(marker);

    const failure = await run(REPO_JOB_NAMES.CLONE);

    expect(failure).toBeInstanceOf(Error);
    expect(stored().status).toBe('error');
    expectRedacted(stored().statusMessage);
  });

  it('a failed refresh stores its note without the remote’s query and fragment', async () => {
    const dest = path.join(base, USER, REPO);
    await mkdir(dest, { recursive: true });
    await git(dest, ['init', '-b', 'main']);
    await writeFile(path.join(dest, 'a.txt'), 'x\n', 'utf8');
    await git(dest, ['add', '-A']);
    await git(dest, ['commit', '-m', 'a']);
    await git(dest, ['remote', 'add', 'origin', REMOTE]);
    fake.patch(schema.repositories, REPO, { storagePath: dest, status: 'ready' });
    const plain = await gitStderr(dest, ['fetch', 'origin', 'refs/heads/main']);
    for (const marker of MARKERS) expect(plain, 'plain git echoes the remote').toContain(marker);

    expect(await run(REPO_JOB_NAMES.REFRESH)).toBeNull();

    expect(stored().status).toBe('ready');
    expectRedacted(stored().statusMessage);
  });
});

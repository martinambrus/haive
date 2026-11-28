import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getRepoQueue: () => ({ add: h.add }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/middleware/maintenance.js', () => ({
  requireNewWorkAllowed: async (_c: unknown, next: () => Promise<void>) => next(),
  admitNewWork: vi.fn(),
  assertNewWorkAllowed: vi.fn(),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { QUEUE_ADD_WAIT_MS } from '../src/lib/queue-bounded.js';
import type { AppEnv } from '../src/context.js';

// A create or an upload complete commits its row at `cloning` with the admission job id before
// it adds the job. A deadline on the add leaves the outcome unknown: the job may still land, so
// the row stays as admitted and the request answers 503.

const app = new Hono<AppEnv>();
app.route('/repos', repoRoutes);
app.onError(errorHandler);

const newFakeDb = () =>
  createFakeDb({
    repositories: schema.repositories,
    auditEvents: schema.auditEvents,
    projectStateOutbox: schema.projectStateOutbox,
    repoUploads: schema.repoUploads,
  });
let fake: ReturnType<typeof newFakeDb>;

let storage: string;
let previousRoot: string | undefined;
beforeAll(async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'repo-queue-timeout-'));
  previousRoot = process.env.REPO_STORAGE_ROOT;
  process.env.REPO_STORAGE_ROOT = storage;
});
afterAll(async () => {
  if (previousRoot === undefined) delete process.env.REPO_STORAGE_ROOT;
  else process.env.REPO_STORAGE_ROOT = previousRoot;
  await rm(storage, { recursive: true, force: true });
});

beforeEach(() => {
  fake = newFakeDb();
  h.db = fake.db;
  h.add.mockReset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const send = (url: string, body: unknown) =>
  app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const untilAddCalled = async () => {
  for (let i = 0; i < 500 && h.add.mock.calls.length === 0; i++)
    await new Promise((resolve) => setImmediate(resolve));
  expect(h.add).toHaveBeenCalledTimes(1);
};

/** Runs the request until the add has been called, then past the add deadline. A request that is
 *  still unanswered then fails the assertion instead of hanging the run. */
async function answeredAfterDeadline(request: Response | Promise<Response>): Promise<Response> {
  let res: Response | undefined;
  void Promise.resolve(request).then((r) => (res = r));
  await untilAddCalled();
  await vi.advanceTimersByTimeAsync(QUEUE_ADD_WAIT_MS);
  for (let i = 0; i < 50 && !res; i++) await new Promise((resolve) => setImmediate(resolve));
  expect(res, 'the request is still waiting for the add').toBeDefined();
  return res!;
}

const admitted = () => {
  const [row] = fake.rows(schema.repositories);
  expect(row).toBeDefined();
  return row!;
};

async function expectOutcomeUnknownWithAdmittedRow(res: Response) {
  expect(res.status).toBe(503);
  expect(((await res.json()) as { code: string }).code).toBe('queue_outcome_unknown');
  const row = admitted();
  expect(row).toMatchObject({ status: 'cloning', refreshPending: true });
  expect(row.refreshJobId).toEqual(expect.any(String));
  expect(row.rootClaimedAt ?? null).toBeNull();
  expect(h.add.mock.calls[0]![2]).toMatchObject({ jobId: row.refreshJobId });
}

describe('POST /repos', () => {
  it('keeps the admitted row and answers 503 when the add never settles', async () => {
    h.add.mockReturnValue(new Promise(() => undefined));
    const res = await answeredAfterDeadline(
      send('/repos', { source: 'git_https', remoteUrl: 'https://example.test/new.git' }),
    );
    await expectOutcomeUnknownWithAdmittedRow(res);
  });

  it('marks the row error and answers the failure when the add rejects', async () => {
    h.add.mockRejectedValue(new Error('redis is down'));
    const res = await send('/repos', {
      source: 'git_https',
      remoteUrl: 'https://example.test/new.git',
    });
    expect(res.status).toBe(500);
    expect(admitted()).toMatchObject({
      status: 'error',
      refreshPending: false,
      refreshJobId: null,
    });
  });
});

describe('POST /repos/upload/:id/complete', () => {
  it('keeps the admitted row and answers 503 when the add never settles', async () => {
    const bytes = new Uint8Array([80, 75, 3, 4, 0, 1, 2, 3]);
    const init = await send('/repos/upload/init', {
      filename: 'source.zip',
      totalSize: bytes.length,
      chunkSize: bytes.length,
    });
    expect(init.status).toBe(201);
    const { session } = (await init.json()) as { session: { id: string } };
    const chunk = await app.request(`/repos/upload/${session.id}/chunk`, {
      method: 'PUT',
      headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` },
      body: bytes,
    });
    expect(chunk.status).toBe(200);
    h.add.mockReturnValue(new Promise(() => undefined));
    const res = await answeredAfterDeadline(
      app.request(`/repos/upload/${session.id}/complete`, { method: 'POST' }),
    );
    await expectOutcomeUnknownWithAdmittedRow(res);
  });
});

import { randomBytes } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
  return {
    db: undefined as unknown,
    add: vi.fn(),
    wait: vi.fn(),
    events: { name: 'plan-mirror-events' },
  };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', async (load) => ({
  ...(await load<typeof import('../src/queues.js')>()),
  getPlanMirrorQueue: () => ({ add: h.add }),
  getPlanMirrorQueueEvents: () => h.events,
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null, getBoolean: async () => true },
}));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { HaiveDataSaveResult } from '@haive/shared/haive-data';

// The real app, so the body is read behind the same middleware a request meets in production.
const { createApiApp } = await import('../src/index.js');

const OTHER_USER = '00000000-0000-4000-8000-0000000000a2';
const REPO = '00000000-0000-4000-8000-0000000000c1';
const FOREIGN = '00000000-0000-4000-8000-0000000000c2';
const app = createApiApp('http://localhost:3000');

const SAVED: HaiveDataSaveResult = {
  outcome: 'saved',
  committed: true,
  commitSha: 'a'.repeat(40),
  files: ['.haive-data/plan.json'],
  skipped: [],
  pushed: false,
  branch: 'main',
  refusal: null,
  indexSynced: true,
};

beforeEach(() => {
  const fake = createFakeDb({ repositories: schema.repositories, tasks: schema.tasks });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo' });
  fake.insert(schema.repositories, { id: FOREIGN, userId: OTHER_USER, name: 'theirs' });
  h.db = fake.db;
  h.add.mockReset().mockResolvedValue({ waitUntilFinished: h.wait });
  h.wait.mockReset().mockResolvedValue(SAVED);
});

/** `raw` is the body exactly as it goes on the wire; undefined sends none. */
const save = (raw?: string, id = REPO, extra: Record<string, string> = {}) =>
  app.request(`/repositories/${id}/haive-data/save`, {
    method: 'POST',
    headers: { host: 'localhost:3001', 'content-type': 'application/json', ...extra },
    ...(raw === undefined ? {} : { body: raw }),
  });

describe('POST /repositories/:id/haive-data/save', () => {
  it('answers 404 for another user repository and queues nothing', async () => {
    for (const raw of ['{}', '{"push":"yes"}', 'null']) {
      const res = await save(raw, FOREIGN);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'Repository not found' });
    }
    expect(h.add).not.toHaveBeenCalled();
  });

  it('answers 404 for a repository that does not exist and queues nothing', async () => {
    const res = await save('{}', '00000000-0000-4000-8000-0000000000ff');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Repository not found' });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('refuses a request from another page and queues nothing', async () => {
    const res = await save('{}', REPO, { origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('queues an empty object as a save that does not push, and waits 120 s for the worker', async () => {
    const res = await save('{}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAVED);
    expect(h.add).toHaveBeenCalledOnce();
    expect(h.add).toHaveBeenCalledWith(
      'save-haive-data',
      { repositoryId: REPO, userId: USER, push: false },
      { removeOnComplete: 100, removeOnFail: 100 },
    );
    expect(h.wait).toHaveBeenCalledOnce();
    expect(h.wait).toHaveBeenCalledWith(h.events, 120_000);
  });

  it('queues exactly the push flag and the trimmed message', async () => {
    const res = await save('{"push":true,"commitMessage":"  chore: save the record  "}');
    expect(res.status).toBe(200);
    expect(h.add.mock.calls[0]![1]).toStrictEqual({
      repositoryId: REPO,
      userId: USER,
      push: true,
      commitMessage: 'chore: save the record',
    });
  });

  it('takes the repository and the user from the session, never from the body', async () => {
    const res = await save(
      JSON.stringify({ push: true, repositoryId: FOREIGN, userId: OTHER_USER }),
    );
    expect(res.status).toBe(200);
    expect(h.add.mock.calls[0]![1]).toStrictEqual({ repositoryId: REPO, userId: USER, push: true });
  });

  it.each([
    ['a push that is a string', '{"push":"true"}'],
    ['a push that is a number', '{"push":1}'],
    ['a push that is null', '{"push":null}'],
    ['a message with a NUL', '{"commitMessage":"bad\\u0000message"}'],
    ['a message of 501 characters', JSON.stringify({ commitMessage: 'x'.repeat(501) })],
    ['an empty message', '{"commitMessage":""}'],
    ['a message of spaces', '{"commitMessage":"   "}'],
    ['a message that is a number', '{"commitMessage":5}'],
  ])('answers 400 for %s and queues nothing', async (_what, raw) => {
    const res = await save(raw);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Validation failed' });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('accepts a message of 500 characters', async () => {
    const res = await save(JSON.stringify({ commitMessage: 'x'.repeat(500) }));
    expect(res.status).toBe(200);
    expect(h.add).toHaveBeenCalledOnce();
  });

  it.each([
    ['null', 'null'],
    ['a list', '[{"push":true}]'],
    ['an empty list', '[]'],
    ['a string', '"push"'],
    ['a number', '5'],
    ['a boolean', 'true'],
  ])(
    'answers 400 invalid_body for a JSON body that is %s and queues nothing',
    async (_what, raw) => {
      const res = await save(raw);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_body' });
      expect(h.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['text that is not JSON', 'push=true'],
    ['JSON cut short', '{"push":'],
    ['an empty body', ''],
  ])('answers 400 invalid_json for %s and queues nothing', async (_what, raw) => {
    const res = await save(raw);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_json' });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('answers 400 for a request with no body at all and queues nothing', async () => {
    expect((await save()).status).toBe(400);
    expect(h.add).not.toHaveBeenCalled();
  });

  it.each<[string, HaiveDataSaveResult]>([
    ['saved', SAVED],
    ['unchanged', { ...SAVED, outcome: 'unchanged', committed: false, commitSha: null, files: [] }],
    [
      'refused',
      {
        ...SAVED,
        outcome: 'refused',
        committed: false,
        commitSha: null,
        files: [],
        refusal: { code: 'checkout_held', taskIds: ['t1', 't2'] },
      },
    ],
    [
      'conflict',
      {
        ...SAVED,
        outcome: 'conflict',
        pushed: false,
        conflict: { paths: ['a.txt'], unrelated: false, autoResolved: [] },
      },
    ],
    [
      'failed',
      {
        ...SAVED,
        outcome: 'failed',
        pushed: false,
        failure: { code: 'push_failed' },
      },
    ],
  ])('passes a %s result through with status 200', async (_outcome, result) => {
    h.wait.mockResolvedValue(result);
    const res = await save('{"push":true}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
  });

  it('answers 409 haive_data_save_failed when the worker job throws, with paths scrubbed', async () => {
    h.wait.mockRejectedValue(new Error("fatal: cannot open '/srv/haive/repos/u/r/.git/index'"));
    const res = await save('{}');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "fatal: cannot open '[path]'",
      code: 'haive_data_save_failed',
    });
  });

  it('answers 409 haive_data_save_failed when the wait times out', async () => {
    h.wait.mockRejectedValue(
      new Error(
        'Job wait save-haive-data timed out before finishing, no finish notification arrived',
      ),
    );
    const res = await save('{}');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'haive_data_save_failed' });
  });

  it('answers 409 haive_data_save_failed when the job cannot be queued', async () => {
    h.add.mockRejectedValue(new Error('Connection is closed.'));
    const res = await save('{}');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Connection is closed.',
      code: 'haive_data_save_failed',
    });
  });

  it('does not return a bound query value in the 409', async () => {
    const secret = randomBytes(24).toString('base64url');
    h.wait.mockRejectedValue(new DrizzleQueryError('select $1', [secret], new Error(secret)));
    const res = await save('{}');
    const text = await res.text();
    expect(res.status).toBe(409);
    expect(
      Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
        text.includes(part),
      ),
    ).toBe(false);
  });
});

describe('POST /repositories/:id/plan/snapshot/save', () => {
  const planSave = (raw: string) =>
    app.request(`/repositories/${REPO}/plan/snapshot/save`, {
      method: 'POST',
      headers: { host: 'localhost:3001', 'content-type': 'application/json' },
      body: raw,
    });

  it('answers 400, not 500, for a commit message with a NUL, and queues nothing', async () => {
    const res = await planSave('{"commitMessage":"bad\\u0000message"}');
    expect(res.status).toBe(400);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('still queues a plan save for a valid message', async () => {
    const res = await planSave('{"commitMessage":"fine"}');
    expect(res.status).toBe(200);
    expect(h.add).toHaveBeenCalledWith(
      'save-plan-mirror',
      { repositoryId: REPO, userId: USER, push: false, commitMessage: 'fine' },
      { removeOnComplete: 100, removeOnFail: 100 },
    );
  });
});

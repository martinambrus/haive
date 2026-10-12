import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown, resolve: vi.fn() }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: vi.fn() }));
vi.mock('../src/lib/project-state-resolve.js', () => ({ resolveProjectStateConflict: h.resolve }));
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
import { conflictSide } from '@haive/shared/project-state';
import { projectStateConflictRoutes } from '../src/routes/project-state-conflicts.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const FOREIGN_REPO = '00000000-0000-4000-8000-0000000000c2';
const STRANGER = '00000000-0000-4000-8000-0000000000a2';
const PENDING = '00000000-0000-4000-8000-0000000000d1';
const PENDING_WHOLE = '00000000-0000-4000-8000-0000000000d2';
const CLOSED = '00000000-0000-4000-8000-0000000000d3';
const OTHER_REPO_ROW = '00000000-0000-4000-8000-0000000000d4';

const app = new Hono<AppEnv>();
app.route('/repos', projectStateConflictRoutes);
app.onError(errorHandler);

function seed() {
  const fake = createFakeDb({
    repositories: schema.repositories,
    projectStateConflicts: schema.projectStateConflicts,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'mine' });
  fake.insert(schema.repositories, { id: FOREIGN_REPO, userId: STRANGER, name: 'theirs' });
  const row = (id: string, repositoryId: string, unit: string, over: Record<string, unknown>) =>
    fake.insert(schema.projectStateConflicts, {
      id,
      repositoryId,
      unit,
      base: conflictSide(['a']),
      local: conflictSide(['a', 'b']),
      incoming: conflictSide(['a', 'c']),
      detectedAt: new Date('2026-10-01T10:00:00Z'),
      resolution: null,
      resolvedAt: null,
      resolvedBy: null,
      ...over,
    });
  row(PENDING, REPO, 'project/render.json#acceptedAgentIds', {});
  row(PENDING_WHOLE, REPO, 'project/render.json', {
    base: conflictSide({ framework: 'x' }),
    local: null,
    incoming: conflictSide({ framework: null }),
    detectedAt: new Date('2026-10-01T11:00:00Z'),
  });
  row(CLOSED, REPO, 'project/render.json#framework', {
    resolution: 'keep_mine',
    resolvedAt: new Date('2026-10-02T10:00:00Z'),
  });
  row(OTHER_REPO_ROW, FOREIGN_REPO, 'project/render.json#acceptedAgentIds', {});
  h.db = fake.db;
}

const get = (repo = REPO) => app.request(`/repos/${repo}/project-state/conflicts`);
const post = (conflictId: string, body: unknown, repo = REPO) =>
  app.request(`/repos/${repo}/project-state/conflicts/${conflictId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  seed();
  h.resolve.mockReset();
});

describe('GET /repos/:id/project-state/conflicts', () => {
  it('lists the pending questions only, values unwrapped and an absent side marked', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    const { conflicts } = (await res.json()) as { conflicts: Record<string, unknown>[] };
    expect(conflicts.map((c) => c.id)).toEqual([PENDING, PENDING_WHOLE]);
    expect(conflicts[0]).toEqual({
      id: PENDING,
      unit: 'project/render.json#acceptedAgentIds',
      key: 'acceptedAgentIds',
      base: { present: true, value: ['a'] },
      local: { present: true, value: ['a', 'b'] },
      incoming: { present: true, value: ['a', 'c'] },
      detectedAt: '2026-10-01T10:00:00.000Z',
      resolution: null,
      resolvedAt: null,
    });
    expect(conflicts[1]).toMatchObject({
      key: null,
      local: { present: false },
      incoming: { present: true, value: { framework: null } },
    });
  });

  it('is a 404 for another user’s repository, and for an id that is no repository', async () => {
    expect((await get(FOREIGN_REPO)).status).toBe(404);
    expect((await get('00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
  });
});

describe('GET /repos/:id/project-state/conflicts/:conflictId', () => {
  beforeEach(seed);

  it('returns one question, answered or not, with its resolution', async () => {
    const closed = await app.request(`/repos/${REPO}/project-state/conflicts/${CLOSED}`);
    expect(closed.status).toBe(200);
    expect((await closed.json()).conflict).toMatchObject({ id: CLOSED, resolution: 'keep_mine' });
    const open = await app.request(`/repos/${REPO}/project-state/conflicts/${PENDING}`);
    expect((await open.json()).conflict).toMatchObject({ id: PENDING, resolution: null });
  });

  it('is a 404 for a row of another repository, and for another user’s repository', async () => {
    const other = await app.request(`/repos/${REPO}/project-state/conflicts/${OTHER_REPO_ROW}`);
    expect(other.status).toBe(404);
    const foreign = await app.request(
      `/repos/${FOREIGN_REPO}/project-state/conflicts/${OTHER_REPO_ROW}`,
    );
    expect(foreign.status).toBe(404);
  });
});

describe('POST /repos/:id/project-state/conflicts/:conflictId', () => {
  const closed = {
    id: PENDING,
    unit: 'project/render.json#acceptedAgentIds',
    key: 'acceptedAgentIds',
    resolution: 'keep_mine',
  };

  for (const answer of ['keep_mine', 'take_theirs'] as const) {
    it(`hands ${answer} to the worker and returns what it did`, async () => {
      h.resolve.mockResolvedValue({
        kind: 'resolved',
        conflict: { ...closed, resolution: answer },
        written: ['.haive-data/state/project/render.json'],
      });

      const res = await post(PENDING, { answer });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        conflict: { ...closed, resolution: answer },
        written: ['.haive-data/state/project/render.json'],
      });
      expect(h.resolve).toHaveBeenCalledWith({
        repositoryId: REPO,
        userId: USER,
        conflictId: PENDING,
        answer,
      });
    });
  }

  it('answers the same answer again with the same body (the worker returns the closed row)', async () => {
    h.resolve.mockResolvedValue({ kind: 'resolved', conflict: closed, written: [] });
    const first = await (await post(PENDING, { answer: 'keep_mine' })).json();
    const again = await post(PENDING, { answer: 'keep_mine' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
  });

  const refusals: [string, unknown, number, string][] = [
    ['a different answer', { kind: 'settled', resolution: 'keep_mine' }, 409, 'already answered'],
    ['a converged row', { kind: 'settled', resolution: 'converged' }, 409, 'now match'],
    ['a live upgrade', { kind: 'busy' }, 409, 'using this repository'],
    ['a moved record', { kind: 'moved' }, 409, "checkout's record moved"],
    ['no value of mine', { kind: 'no_local' }, 409, 'no value of its own'],
    ['an unusable answer', { kind: 'invalid' }, 409, 'nothing was changed'],
    ['an unknown row', { kind: 'not_found' }, 404, 'not found'],
  ];
  for (const [name, result, status, words] of refusals) {
    it(`is a ${status} for ${name}, in plain words`, async () => {
      h.resolve.mockResolvedValue(result);
      const res = await post(PENDING, { answer: 'take_theirs' });
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toContain(words);
    });
  }

  it('is a 202 saying the answer is still being applied when the wait ends first', async () => {
    h.resolve.mockResolvedValue({ kind: 'pending' });
    const res = await post(PENDING, { answer: 'keep_mine' });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { pending: boolean }).pending).toBe(true);
  });

  it('is a 502 with nothing said of the cause when the job fails', async () => {
    h.resolve.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:6379'));
    const res = await post(PENDING, { answer: 'keep_mine' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('10.0.0.5');
  });

  it('is a 404 for another user’s repository and never reaches the worker', async () => {
    const res = await post(OTHER_REPO_ROW, { answer: 'keep_mine' }, FOREIGN_REPO);
    expect(res.status).toBe(404);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('is a 400 for an answer that is neither, and never reaches the worker', async () => {
    for (const body of [{ answer: 'both' }, {}, { answer: 'keep_mine', extra: 1 }]) {
      expect((await post(PENDING, body)).status).toBe(400);
    }
    expect((await post('not-a-uuid', { answer: 'keep_mine' })).status).toBe(404);
    expect(h.resolve).not.toHaveBeenCalled();
  });
});

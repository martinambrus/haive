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
import { RTK_ENABLED_UNIT, claimFileName, conflictSide } from '@haive/shared/project-state';
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
const RTK_ROW = '00000000-0000-4000-8000-0000000000d5';
const CLAIM_ROW = '00000000-0000-4000-8000-0000000000d6';
const STRAY_ROW = '00000000-0000-4000-8000-0000000000d7';
const SETTING_ROW = '00000000-0000-4000-8000-0000000000d8';
const ENV_ROW = '00000000-0000-4000-8000-0000000000d9';
const CLAIM_UNIT = claimFileName('docs/guide.md');
const claim = (writtenHash: string) => ({
  path: 'docs/guide.md',
  templateId: 'workflow-config',
  kind: 'workflow-config',
  schemaVersion: 1,
  templateHash: 'c'.repeat(64),
  writtenHash,
  haiveVersion: '1.2.3',
});

const app = new Hono<AppEnv>();
app.route('/repos', projectStateConflictRoutes);
app.onError(errorHandler);

function seed() {
  const fake = createFakeDb({
    repositories: schema.repositories,
    projectStateConflicts: schema.projectStateConflicts,
    planNodes: schema.planNodes,
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
  row(RTK_ROW, REPO, RTK_ENABLED_UNIT, {
    base: conflictSide(true),
    local: conflictSide(true),
    incoming: conflictSide(false),
    detectedAt: new Date('2026-10-01T12:00:00Z'),
  });
  row(CLAIM_ROW, REPO, CLAIM_UNIT, {
    base: conflictSide(claim('1'.repeat(64))),
    local: conflictSide(claim('2'.repeat(64))),
    incoming: null,
    detectedAt: new Date('2026-10-01T13:00:00Z'),
  });
  row(SETTING_ROW, REPO, 'settings/lsp-servers.json', {
    base: conflictSide(['vtsls']),
    local: conflictSide(['pyright']),
    incoming: conflictSide(['gopls']),
    detectedAt: new Date('2026-10-01T13:30:00Z'),
  });
  row(ENV_ROW, REPO, 'project/environment.json#confirmedValues', {
    detectedAt: new Date('2026-10-01T13:40:00Z'),
  });
  row(STRAY_ROW, REPO, 'artifacts/not-a-claim.json', {
    detectedAt: new Date('2026-10-01T14:00:00Z'),
  });
  row(OTHER_REPO_ROW, FOREIGN_REPO, 'project/render.json#acceptedAgentIds', {});
  h.db = fake.db;
  return fake;
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
    expect(conflicts.map((c) => c.id)).toEqual([
      PENDING,
      PENDING_WHOLE,
      RTK_ROW,
      CLAIM_ROW,
      SETTING_ROW,
      ENV_ROW,
    ]);
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

  it('lists the RTK question with its values, and no render key', async () => {
    const { conflicts } = (await (await get()).json()) as { conflicts: Record<string, unknown>[] };
    expect(conflicts.find((c) => c.id === RTK_ROW)).toEqual({
      id: RTK_ROW,
      unit: RTK_ENABLED_UNIT,
      key: null,
      base: { present: true, value: true },
      local: { present: true, value: true },
      incoming: { present: true, value: false },
      detectedAt: '2026-10-01T12:00:00.000Z',
      resolution: null,
      resolvedAt: null,
    });
  });

  it('lists a claim question with the claim as each side holds it, and no render key', async () => {
    const { conflicts } = (await (await get()).json()) as { conflicts: Record<string, unknown>[] };
    expect(conflicts.find((c) => c.id === CLAIM_ROW)).toEqual({
      id: CLAIM_ROW,
      unit: CLAIM_UNIT,
      key: null,
      base: { present: true, value: claim('1'.repeat(64)) },
      local: { present: true, value: claim('2'.repeat(64)) },
      incoming: { present: false },
      detectedAt: '2026-10-01T13:00:00.000Z',
      resolution: null,
      resolvedAt: null,
    });
  });

  it('lists a settings question and an environment key question, the same way', async () => {
    const { conflicts } = (await (await get()).json()) as { conflicts: Record<string, unknown>[] };
    expect(conflicts.find((c) => c.id === SETTING_ROW)).toEqual({
      id: SETTING_ROW,
      unit: 'settings/lsp-servers.json',
      key: null,
      base: { present: true, value: ['vtsls'] },
      local: { present: true, value: ['pyright'] },
      incoming: { present: true, value: ['gopls'] },
      detectedAt: '2026-10-01T13:30:00.000Z',
      resolution: null,
      resolvedAt: null,
    });
    expect(conflicts.find((c) => c.id === ENV_ROW)).toMatchObject({ key: 'confirmedValues' });
  });

  it('leaves out a row whose unit is no unit it can answer', async () => {
    const { conflicts } = (await (await get()).json()) as { conflicts: Record<string, unknown>[] };
    expect(conflicts.map((c) => c.id)).not.toContain(STRAY_ROW);
  });

  it('is a 404 for another user’s repository, and for an id that is no repository', async () => {
    expect((await get(FOREIGN_REPO)).status).toBe(404);
    expect((await get('00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
  });
});

describe('plan questions', () => {
  const NODE = '00000000-0000-4000-8000-0000000000e1';
  const GONE = '00000000-0000-4000-8000-0000000000e2';
  const PLAN_ROW = '00000000-0000-4000-8000-0000000000d0';
  const GONE_ROW = '00000000-0000-4000-8000-0000000000da';

  function seedPlan() {
    const fake = seed();
    fake.insert(schema.planNodes, {
      id: NODE,
      repositoryId: REPO,
      parentId: null,
      path: `/${NODE}/`,
      ordinal: 0,
      title: 'Billing',
      kind: 'component',
      status: 'todo',
      taskable: true,
      version: 1,
    });
    const row = (id: string, nodeId: string) =>
      fake.insert(schema.projectStateConflicts, {
        id,
        repositoryId: REPO,
        unit: `plan/${nodeId}#title`,
        base: conflictSide('Billing'),
        local: conflictSide('Billing v2'),
        incoming: conflictSide('Invoices'),
        detectedAt: new Date('2026-10-03T10:00:00Z'),
        resolution: null,
        resolvedAt: null,
        resolvedBy: null,
      });
    row(PLAN_ROW, NODE);
    row(GONE_ROW, GONE);
  }

  it('lists a pending plan row with its node title, and null once the node is gone', async () => {
    seedPlan();
    const { conflicts } = (await (await get()).json()) as { conflicts: Record<string, unknown>[] };
    expect(conflicts.find((c) => c.id === PLAN_ROW)).toMatchObject({
      unit: `plan/${NODE}#title`,
      key: 'title',
      nodeTitle: 'Billing',
      incoming: { present: true, value: 'Invoices' },
    });
    expect(conflicts.find((c) => c.id === GONE_ROW)).toMatchObject({ nodeTitle: null });
    expect(conflicts.find((c) => c.id === PENDING)).not.toHaveProperty('nodeTitle');
  });

  it('returns one plan row with its node title and hands its answer to the worker', async () => {
    seedPlan();
    const one = await app.request(`/repos/${REPO}/project-state/conflicts/${PLAN_ROW}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { conflict: unknown }).conflict).toMatchObject({
      id: PLAN_ROW,
      nodeTitle: 'Billing',
    });
    h.resolve.mockResolvedValue({
      kind: 'resolved',
      conflict: { id: PLAN_ROW },
      written: [],
    });
    expect((await post(PLAN_ROW, { answer: 'take_theirs' })).status).toBe(200);
    expect(h.resolve).toHaveBeenCalledWith({
      repositoryId: REPO,
      userId: USER,
      conflictId: PLAN_ROW,
      answer: 'take_theirs',
    });
  });
});

describe('GET /repos/:id/project-state/conflicts/:conflictId', () => {
  beforeEach(seed);

  it('returns one question, answered or not, with its resolution', async () => {
    const closed = await app.request(`/repos/${REPO}/project-state/conflicts/${CLOSED}`);
    expect(closed.status).toBe(200);
    const closedBody = (await closed.json()) as { conflict: unknown };
    expect(closedBody.conflict).toMatchObject({ id: CLOSED, resolution: 'keep_mine' });
    const open = await app.request(`/repos/${REPO}/project-state/conflicts/${PENDING}`);
    const openBody = (await open.json()) as { conflict: unknown };
    expect(openBody.conflict).toMatchObject({ id: PENDING, resolution: null });
  });

  it('returns a settings question', async () => {
    const res = await app.request(`/repos/${REPO}/project-state/conflicts/${SETTING_ROW}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conflict: unknown };
    expect(body.conflict).toMatchObject({ id: SETTING_ROW, unit: 'settings/lsp-servers.json' });
  });

  it('returns the RTK question', async () => {
    const res = await app.request(`/repos/${REPO}/project-state/conflicts/${RTK_ROW}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conflict: unknown };
    expect(body.conflict).toMatchObject({ id: RTK_ROW, unit: RTK_ENABLED_UNIT, resolution: null });
  });

  it('returns a claim question', async () => {
    const res = await app.request(`/repos/${REPO}/project-state/conflicts/${CLAIM_ROW}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conflict: unknown };
    expect(body.conflict).toMatchObject({ id: CLAIM_ROW, unit: CLAIM_UNIT, key: null });
  });

  it('is a 404 for a row whose unit is no unit it can answer', async () => {
    const res = await app.request(`/repos/${REPO}/project-state/conflicts/${STRAY_ROW}`);
    expect(res.status).toBe(404);
  });

  it('is a 404 for a question id that is not a uuid', async () => {
    const res = await app.request(`/repos/${REPO}/project-state/conflicts/not-a-uuid`);
    expect(res.status).toBe(404);
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

  it('hands an answer to the RTK question to the worker', async () => {
    h.resolve.mockResolvedValue({
      kind: 'resolved',
      conflict: { id: RTK_ROW, unit: RTK_ENABLED_UNIT, key: null, resolution: 'take_theirs' },
      written: [],
    });
    const res = await post(RTK_ROW, { answer: 'take_theirs' });
    expect(res.status).toBe(200);
    expect(h.resolve).toHaveBeenCalledWith({
      repositoryId: REPO,
      userId: USER,
      conflictId: RTK_ROW,
      answer: 'take_theirs',
    });
  });

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
    ['a busy record or checkout', { kind: 'busy' }, 409, 'project settings recovery'],
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

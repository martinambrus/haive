import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { Hono } from 'hono';
import { desc, is, SQL } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const OTHER = '00000000-0000-4000-8000-0000000000a2';
const REPO_A = '00000000-0000-4000-8000-0000000000b1';
const REPO_B = '00000000-0000-4000-8000-0000000000b2';
const P1 = '00000000-0000-4000-8000-0000000000c1';
const P2 = '00000000-0000-4000-8000-0000000000c2';

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);

const minute = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, n));

const isExpression = (order: unknown) =>
  is(order, SQL) && order.queryChunks.some((chunk) => is(chunk, SQL));

// The fake db orders by a column only: the summary query's coalesce is read as summary_cli_choice_at, set on every row.
function setup() {
  const fake = createFakeDb({ tasks: schema.tasks });
  const findFirst = fake.db.query.tasks.findFirst;
  fake.db.query.tasks.findFirst = (opts = {}) =>
    findFirst({
      ...opts,
      orderBy: [opts.orderBy]
        .flat()
        .map((order) => (isExpression(order) ? desc(schema.tasks.summaryCliChoiceAt) : order)),
    });
  h.db = fake.db;
  const task = (at: number, over: Record<string, unknown> = {}) =>
    fake.insert(schema.tasks, {
      userId: USER,
      repositoryId: REPO_A,
      cliProviderId: null,
      cliChoiceRecorded: false,
      summaryCliProviderId: null,
      summaryLlmEnabled: true,
      summaryCliChoiceRecorded: false,
      createdAt: minute(at),
      summaryCliChoiceAt: minute(at),
      ...over,
    });
  return { task };
}

const lastCli = async (query = '') => {
  const res = await app.request(`/last-cli${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    cliProviderId: string | null;
    cliChoice: { providerId: string | null } | null;
    summaryChoice: { providerId: string | null; llmEnabled: boolean } | null;
  };
};

describe('GET /tasks/last-cli without a repository', () => {
  it("answers the user's latest choice across all their repositories", async () => {
    const { task } = setup();
    task(1, { repositoryId: REPO_A, cliProviderId: P1, cliChoiceRecorded: true });
    task(2, {
      repositoryId: REPO_B,
      cliProviderId: P2,
      cliChoiceRecorded: true,
      summaryCliProviderId: P2,
      summaryCliChoiceRecorded: true,
    });
    expect(await lastCli()).toEqual({
      cliProviderId: P2,
      cliChoice: { providerId: P2 },
      summaryChoice: { providerId: P2, llmEnabled: true },
    });
  });

  it('counts a task that was started without a repository', async () => {
    const { task } = setup();
    task(1, { repositoryId: REPO_A, cliProviderId: P1, cliChoiceRecorded: true });
    task(2, { repositoryId: null, cliProviderId: P2, cliChoiceRecorded: true });
    expect((await lastCli()).cliChoice).toEqual({ providerId: P2 });
  });

  it("never answers with another user's choice", async () => {
    const { task } = setup();
    task(1, { cliProviderId: P1, cliChoiceRecorded: true });
    task(2, { userId: OTHER, cliProviderId: P2, cliChoiceRecorded: true });
    expect(await lastCli()).toMatchObject({ cliProviderId: P1, cliChoice: { providerId: P1 } });
  });

  it('ranks a stated choice above a newer task that merely ran, as for one repository', async () => {
    const { task } = setup();
    task(1, { cliProviderId: null, cliChoiceRecorded: true });
    task(2, { repositoryId: REPO_B, cliProviderId: P2 });
    expect(await lastCli()).toMatchObject({ cliProviderId: P2, cliChoice: { providerId: null } });
  });

  it('ranks a summary choice stated by an edit above a newer task, as for one repository', async () => {
    const { task } = setup();
    task(1, {
      summaryCliProviderId: P1,
      summaryCliChoiceRecorded: true,
      summaryCliChoiceAt: minute(5),
    });
    task(2, { repositoryId: REPO_B, summaryCliProviderId: P2, summaryCliChoiceRecorded: true });
    expect((await lastCli()).summaryChoice).toEqual({ providerId: P1, llmEnabled: true });
  });

  it('answers nothing for a user with no task', async () => {
    const { task } = setup();
    task(1, { userId: OTHER, cliProviderId: P1, cliChoiceRecorded: true });
    expect(await lastCli()).toEqual({ cliProviderId: null, cliChoice: null, summaryChoice: null });
  });
});

describe('GET /tasks/last-cli with a repository', () => {
  it("answers from that repository's tasks only", async () => {
    const { task } = setup();
    task(1, { repositoryId: REPO_A, cliProviderId: P1, cliChoiceRecorded: true });
    task(2, { repositoryId: REPO_B, cliProviderId: P2, cliChoiceRecorded: true });
    expect(await lastCli(`?repositoryId=${REPO_A}`)).toMatchObject({
      cliProviderId: P1,
      cliChoice: { providerId: P1 },
    });
  });
});

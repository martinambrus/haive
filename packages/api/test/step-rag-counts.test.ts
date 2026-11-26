import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/pg-proxy';

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
vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...actual,
    configService: {
      ...actual.configService,
      get: async () => 'USD',
      getBoolean: async () => false,
    },
  };
});
vi.mock('@haive/shared/stats-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/stats-server')>()),
  resolveCostDisplay: async () => ({ currency: 'USD', rate: 1 }),
}));
vi.mock('../src/routes/tasks/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/routes/tasks/_helpers.js')>()),
  findQueuedInvocationStepIds: async () => new Set<string>(),
  enrichStepsWithCliPreferences: async (_db: unknown, _f: unknown, _u: unknown, rows: unknown[]) =>
    rows,
  enrichStepsWithSkipFlag: async (_db: unknown, _f: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithActiveRole: async (_db: unknown, _f: unknown, _id: unknown, rows: unknown[]) =>
    rows,
  enrichStepsWithAgentCounts: async (_db: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithCliUsage: (_flags: unknown, rows: unknown[]) => rows,
  findActiveCliInvocation: async () => null,
  loadFinishedRunsRevision: async () => '',
  sumTaskProviderBreakdown: async () => [],
  buildUpcomingCliSteps: async () => [],
}));
vi.mock('../src/routes/tasks/_call-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/routes/tasks/_call-log.js')>()),
  loadLoggedCallCount: async () => ({ logged: 0, running: 0 }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const FOREIGN = '00000000-0000-4000-8000-000000000002';
const names = ['used', 'unused', 'live', 'pending', 'used-again'];
const rowId = (name: string) =>
  `00000000-0000-4000-8000-${String(names.indexOf(name) + 10).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 26, 12, minute));
const stamp = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);

// Execute the count/panel's standard SQL against an in-memory store. The other
// task-detail enrichments are unrelated and faked above. This exercises JOIN,
// timestamp predicates and GROUP BY without a server or a hand-written evaluator.
function setup() {
  const fake = createFakeDb({
    tasks: schema.tasks,
    cliProviders: schema.cliProviders,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    taskCheckRuns: schema.taskCheckRuns,
    stepCatalog: schema.stepCatalog,
    taskTypeDefinitions: schema.taskTypeDefinitions,
  });
  fake.insert(schema.tasks, { id: TASK, userId: USER, type: 'workflow', status: 'running' });
  fake.insert(schema.tasks, {
    id: FOREIGN,
    userId: '00000000-0000-4000-8000-000000000099',
    type: 'workflow',
  });
  const windows = [
    { id: 'used', stepId: 'used', startedAt: at(1), endedAt: at(3) },
    { id: 'unused', stepId: 'unused', startedAt: at(4), endedAt: at(5) },
    { id: 'live', stepId: 'live', startedAt: at(6), endedAt: null },
    { id: 'pending', stepId: 'pending', startedAt: null, endedAt: null },
    // Same logical step in a later round must have its own count.
    { id: 'used-again', stepId: 'used', startedAt: at(7), endedAt: at(8) },
  ];
  for (const [stepIndex, row] of windows.entries())
    fake.insert(schema.taskSteps, {
      ...row,
      id: rowId(row.id),
      taskId: TASK,
      stepIndex,
      round: stepIndex === 4 ? 1 : 0,
    });
  const store = new DatabaseSync(':memory:');
  store.exec(`create table task_steps (id text, task_id text, started_at text, ended_at text);
    create table rag_query_log (id text, task_id text, query text, top_k integer,
      usage_assessment text, hit_count integer, kb_hits integer, code_hits integer,
      runbook_hits integer, learning_hits integer, max_rrf real, max_dense real, created_at text);`);
  const insertStep = store.prepare('insert into task_steps values (?, ?, ?, ?)');
  for (const row of windows)
    insertStep.run(
      rowId(row.id),
      TASK,
      row.startedAt && stamp(row.startedAt),
      row.endedAt && stamp(row.endedAt),
    );
  const insertQuery = store.prepare(
    `insert into rag_query_log (id, task_id, query, hit_count, created_at) values (?, ?, ?, 0, ?)`,
  );
  for (const minute of [0, 1, 2, 3, 5.5, 6, 7, 8, 9, 11]) {
    const time = new Date(at(0).getTime() + minute * 60_000);
    insertQuery.run(`q${minute}`, TASK, 'query', stamp(time));
  }
  insertQuery.run('foreign', FOREIGN, 'other task', stamp(at(2)));
  const statements: string[] = [];
  const sqlDb = drizzle(async (query, params) => {
    statements.push(query);
    const statement = store.prepare(query.replace(/\$\d+/g, '?'));
    const rows = statement.all(
      ...(params.map((p) =>
        typeof p === 'string' ? p.replace('T', ' ').replace(/Z$/, '') : p,
      ) as SQLInputValue[]),
    );
    return { rows: rows.map((r) => Object.values(r)) };
  });
  const select = fake.db.select.bind(fake.db);
  const queryTasks = fake.db.query.tasks!;
  h.db = {
    ...fake.db,
    query: {
      ...fake.db.query,
      tasks: {
        findMany: queryTasks.findMany,
        findFirst: (opts: Record<string, unknown>) => {
          const { with: _with, ...plain } = opts;
          return queryTasks.findFirst(plain);
        },
      },
    },
    select: (fields?: Record<string, unknown>) => {
      if (fields && ('ragQueryCount' in fields || 'query' in fields))
        return sqlDb.select(fields as never);
      // Keep the existing CLI aggregate empty, independent of RAG telemetry.
      if (fields && 'attemptCount' in fields) {
        const chain = {
          from: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          groupBy: async () => [],
        };
        return chain;
      }
      return select(fields as never);
    },
  };
  return { store, statements };
}

afterEach(() => vi.useRealTimers());

describe('step RAG query counts', () => {
  it.each(['', '/steps'])(
    'returns panel-attributed counts in the existing task%s request with one grouped query',
    async (suffix) => {
      vi.useFakeTimers();
      vi.setSystemTime(at(10));
      const { store, statements } = setup();
      try {
        const response = await app.request(`/${TASK}${suffix}`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { steps: { id: string; ragQueryCount: number }[] };
        expect(
          Object.fromEntries(
            body.steps.map((s) => [names.find((name) => rowId(name) === s.id), s.ragQueryCount]),
          ),
        ).toEqual({
          used: 3,
          unused: 0,
          live: 4,
          pending: 0,
          'used-again': 2,
        });
        expect(statements).toHaveLength(1);
        expect(statements[0]).toContain('group by');
        expect(statements[0]).toContain('"task_steps"."id"');
        for (const id of ['used', 'unused', 'live', 'pending']) {
          const panel = await app.request(`/${TASK}/steps/${id}/rag-queries`);
          expect(panel.status).toBe(200);
          const { queries } = (await panel.json()) as { queries: unknown[] };
          expect(body.steps.find((s) => s.id === rowId(id))!.ragQueryCount).toBe(queries.length);
        }
      } finally {
        store.close();
      }
    },
  );

  it.each(['', '/steps'])('keeps task%s counts owner-scoped', async (suffix) => {
    const { store, statements } = setup();
    try {
      expect((await app.request(`/${FOREIGN}${suffix}`)).status).toBe(404);
      expect(statements).toEqual([]);
    } finally {
      store.close();
    }
  });
});

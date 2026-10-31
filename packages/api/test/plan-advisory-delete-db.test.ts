import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.PLAN_ADVISORY_DELETE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/plan_advisory_delete_test'))
  throw new Error(
    'Use a dedicated plan_advisory_delete_test database for the plan advisory delete tests',
  );

const USER = '00000000-0000-4000-8000-0000000003b1';
const NODE = '00000000-0000-4000-8000-0000000003b2';
const CLI = '00000000-0000-4000-8000-0000000003b3';
const BLIND_INDEX = 'plan-advisory-delete-test-user';
const REQUEST_HEADER = 'x-test-request';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  queued: [] as { name: string; payload: unknown }[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => {
  const queue = () => ({
    add: async (name: string, payload: unknown) => {
      h.queued.push({ name, payload });
    },
  });
  return { getTaskQueue: queue, getRepoQueue: queue };
});
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const shared = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...shared,
    configService: {
      get: async (key: string) => (key === shared.CONFIG_KEYS.PLAN_CANVAS_ENABLED ? 'true' : null),
      getBoolean: async () => false,
      getFresh: async (key: string) =>
        key === shared.CONFIG_KEYS.MAINTENANCE_STATE ? 'normal' : null,
      set: async () => undefined,
    },
  };
});

import { Hono } from 'hono';
import {
  createDatabase,
  hasPgCode,
  isLockNotAvailable,
  schema,
  type Database,
} from '@haive/database';
import { TASK_JOB_NAMES } from '@haive/shared';
import { repoRoutes } from '../src/routes/repos.js';
import { planRoutes } from '../src/routes/plan.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { HttpError, type AppEnv } from '../src/context.js';

// Every error a route throws passes through here before the real handler turns it into an answer,
// so a request that was aborted (a deadlock answers 500) is told apart from one that was refused.
const thrown: { request: string; error: unknown }[] = [];

const app = new Hono<AppEnv>();
app.route('/repos', repoRoutes);
app.route('/repositories', planRoutes);
app.onError((error, c) => {
  thrown.push({ request: c.req.header(REQUEST_HEADER) ?? 'unlabelled request', error });
  return errorHandler(error, c);
});

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Answer = { status: number; body: Record<string, unknown> };
type InFlight = { done: Promise<Outcome<Answer>>; state: { ended: boolean } };
type Waiting = { pid: number; event: string };

const BLOCKED_WITHIN_MS = 10_000;

const settle = <T>(run: Promise<T>): Promise<Outcome<T>> =>
  run.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const describeError = (error: unknown): string =>
  hasPgCode(error, '40P01') ? 'deadlock detected (40P01)' : String(error);

const describeOutcome = (outcome: Outcome<Answer>): string =>
  outcome.ok ? `answered ${outcome.value.status}` : `failed: ${String(outcome.error)}`;

const describeWait = (wait: Waiting | 'answered'): string =>
  wait === 'answered' ? 'nothing (it answered first)' : `the ${wait.event} lock`;

const backendPid = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return row!.pid;
};

// A repository delete locks the repository row and then cascades into its plan nodes. A plan advisory
// click locks a plan node and then inserts a task, whose foreign key check needs the repository row.
// Opposite orders deadlock unless both queue on the repository's task-creation key before either row.
describe.skipIf(!url)('a repository delete beside a plan advisory click, on Postgres', () => {
  let db: Database;
  let gate: Database;
  let observer: Database;
  let repositoryId: string;
  let releaseGate: (() => void) | undefined;
  let requests: Promise<unknown>[] = [];

  beforeAll(() => {
    db = createDatabase(url as string);
    gate = createDatabase(url as string);
    observer = createDatabase(url as string);
    h.db = db;
  });

  afterAll(async () => {
    await Promise.all([db, gate, observer].map((handle) => handle.$client.end({ timeout: 5 })));
  });

  const reset = async () => {
    await observer.delete(schema.repoCleanups).where(eq(schema.repoCleanups.userId, USER));
    await observer.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
  };

  beforeEach(async () => {
    h.queued = [];
    thrown.length = 0;
    requests = [];
    await reset();
    await observer.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'plan-advisory-delete-test@test.local',
      emailBlindIndex: BLIND_INDEX,
      passwordHash: 'not-a-real-hash',
      role: 'user',
    });
    const [repository] = await observer
      .insert(schema.repositories)
      .values({ userId: USER, name: 'plan advisory delete', source: 'local_path' })
      .returning({ id: schema.repositories.id });
    repositoryId = repository!.id;
    await observer.insert(schema.cliProviders).values({
      id: CLI,
      userId: USER,
      name: 'claude-code',
      label: 'claude-code',
      enabled: true,
    });
    await observer.insert(schema.planNodes).values({
      id: NODE,
      repositoryId,
      parentId: null,
      path: `/${NODE}/`,
      title: 'Root',
      ordinal: 0,
      kind: 'component',
      status: 'todo',
      version: 1,
    });
  });

  afterEach(async () => {
    // A test that failed before it let the gate go must not leave its transaction open.
    releaseGate?.();
    releaseGate = undefined;
    await Promise.allSettled(requests);
    await reset();
  });

  const send = (
    request: string,
    method: 'DELETE' | 'POST',
    path: string,
    body?: unknown,
  ): InFlight => {
    const run = (async (): Promise<Answer> => {
      const res = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json', [REQUEST_HEADER]: request },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    })();
    requests.push(run);
    const state = { ended: false };
    const done = settle(run);
    void done.then(() => (state.ended = true));
    return { done, state };
  };
  const deleteRepository = () => send('repository delete', 'DELETE', `/repos/${repositoryId}`);
  const clickAdvisory = () =>
    send(
      'plan advisory click',
      'POST',
      `/repositories/${repositoryId}/plan/nodes/${NODE}/advisory`,
      { question: 'Which queue?' },
    );

  const userTasks = () => observer.select().from(schema.tasks).where(eq(schema.tasks.userId, USER));
  const startedTasks = () =>
    h.queued
      .filter((job) => job.name === TASK_JOB_NAMES.START)
      .map((job) => (job.payload as { taskId: string }).taskId);
  const repositoryExists = async () =>
    (
      await observer
        .select({ id: schema.repositories.id })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, repositoryId))
    ).length === 1;
  const nodeExists = async () =>
    (
      await observer
        .select({ id: schema.planNodes.id })
        .from(schema.planNodes)
        .where(eq(schema.planNodes.id, NODE))
    ).length === 1;

  /** True while another transaction holds the plan node row. */
  const nodeIsHeld = (): Promise<boolean> =>
    observer
      .transaction((tx) =>
        tx
          .select({ id: schema.planNodes.id })
          .from(schema.planNodes)
          .where(eq(schema.planNodes.id, NODE))
          .for('update', { noWait: true }),
      )
      .then(
        () => false,
        (error: unknown) => {
          if (!isLockNotAvailable(error)) throw error;
          return true;
        },
      );

  /** The gate: its own connection locks the repository row for update, the lock a delete's first
   *  statement waits for, and keeps its transaction open until `release`. */
  async function holdRepositoryRow() {
    let release!: () => void;
    const releasing = new Promise<void>((resolve) => (release = resolve));
    let holds!: (pid: number) => void;
    const holding = new Promise<number>((resolve) => (holds = resolve));
    const done = settle(
      gate.transaction(async (tx) => {
        const pid = await backendPid(tx);
        await tx
          .select({ id: schema.repositories.id })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, repositoryId))
          .for('update');
        holds(pid);
        await releasing;
      }),
    );
    releaseGate = release;
    const pid = await Promise.race([
      holding,
      done.then(() => {
        throw new Error('the gate transaction ended before it held the repository row');
      }),
    ]);
    return { pid, release, done };
  }

  const backendsBlockedBy = (blockerPid: number): Promise<Waiting[]> =>
    observer.execute<Waiting>(sql`
      select pid, wait_event as event from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and ${blockerPid}::int = any (pg_blocking_pids(pid))`);

  /** The backend of `request` once it waits for a lock one of `holders` has or is queued behind;
   *  `answered` when the request ended first. `except` is a backend that is not the request's. */
  async function untilBlocked(
    holders: number[],
    request: InFlight,
    except = 0,
  ): Promise<Waiting | 'answered'> {
    const deadline = Date.now() + BLOCKED_WITHIN_MS;
    for (;;) {
      if (request.state.ended) return 'answered';
      for (const holder of holders) {
        const [waiting] = (await backendsBlockedBy(holder)).filter((w) => w.pid !== except);
        if (waiting) return waiting;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `no backend was blocked by backends ${holders.join(', ')} within ${BLOCKED_WITHIN_MS} ms`,
        );
      }
      await pause(20);
    }
  }

  /** The gate holds the repository row. The delete is fired and waits for it; the click is fired
   *  and waits behind it or answers; then the gate lets go and both run on. */
  async function overlap() {
    const held = await holdRepositoryRow();
    const deleteRun = deleteRepository();
    let clickRun: InFlight | undefined;
    let deleteWait: Waiting | 'answered' = 'answered';
    let clickWait: Waiting | 'answered' = 'answered';
    let clickHoldsTheNode = false;
    try {
      deleteWait = await untilBlocked([held.pid], deleteRun);
      if (deleteWait === 'answered') {
        throw new Error(
          'the delete answered without waiting for the gate that holds the repository row',
        );
      }
      clickRun = clickAdvisory();
      clickWait = await untilBlocked([held.pid, deleteWait.pid], clickRun, deleteWait.pid);
      if (clickWait !== 'answered') clickHoldsTheNode = await nodeIsHeld();
    } finally {
      held.release();
      releaseGate = undefined;
    }
    const [deleted, clicked] = await Promise.all([deleteRun.done, clickRun!.done]);
    await held.done;
    return {
      deleted,
      clicked,
      summary:
        `the delete waited on ${describeWait(deleteWait)} and ${describeOutcome(deleted)}; ` +
        `the click waited on ${describeWait(clickWait)} while ${clickHoldsTheNode ? 'holding' : 'not holding'} the plan node, ` +
        describeOutcome(clicked),
    };
  }

  it('lets a repository delete and a plan advisory click that overlap both finish: the delete wins and the click finds no plan node', async () => {
    const { deleted, clicked, summary } = await overlap();

    const failures = thrown
      .filter(({ error }) => !(error instanceof HttpError))
      .map(({ request, error }) => `${request}: ${describeError(error)}`);
    expect(
      failures,
      `requests that failed instead of answering: ${failures.join(', ') || 'none'}; ${summary}`,
    ).toEqual([]);
    expect(deleted).toMatchObject({
      ok: true,
      value: { status: 200, body: { ok: true, cancelledTasks: 0 } },
    });
    expect(clicked).toMatchObject({ ok: true, value: { status: 404 } });
    expect(await repositoryExists(), 'the repository still exists').toBe(false);
    expect(await nodeExists(), 'the plan node still exists').toBe(false);
    expect(await userTasks(), 'tasks the click created').toEqual([]);
    expect(startedTasks()).toEqual([]);
  }, 30_000);

  it('queues one advisory task for a click on a plan node of a repository that exists', async () => {
    const clicked = await clickAdvisory().done;

    const tasks = await userTasks();
    expect(tasks).toMatchObject([
      { type: 'advisory', status: 'queued', repositoryId, metadata: { planNodeId: NODE } },
    ]);
    expect(clicked).toMatchObject({
      ok: true,
      value: { status: 201, body: { taskId: tasks[0]!.id } },
    });
    expect(startedTasks()).toEqual([tasks[0]!.id]);
    expect(thrown).toEqual([]);
  }, 30_000);
});

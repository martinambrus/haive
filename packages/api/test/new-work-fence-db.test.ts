import { and, eq, ne, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, lockRepositoryRow, schema, type Database } from '@haive/database';

const url = process.env.NEW_WORK_FENCE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/new_work_fence_test'))
  throw new Error('Use a dedicated new_work_fence_test database for the new-work fence tests');

const USER = '00000000-0000-4000-8000-0000000000f6';
const BLIND_INDEX = 'new-work-fence-test-user';
const FENCE = 'haive-new-work-fence';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  state: 'normal',
  reads: [] as string[],
  queued: [] as string[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => {
  const queue = () => ({
    add: async (name: string) => {
      h.queued.push(name);
    },
  });
  return {
    getTaskQueue: queue,
    getRepoQueue: queue,
    getBundleQueue: queue,
    getCliExecQueue: queue,
    getUsagePollQueue: queue,
  };
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
      get: async () => null,
      getBoolean: async () => false,
      getFresh: async (key: string) => {
        if (key !== shared.CONFIG_KEYS.MAINTENANCE_STATE) return null;
        h.reads.push(h.state);
        return h.state;
      },
      set: async (key: string, value: string) => {
        if (key === shared.CONFIG_KEYS.MAINTENANCE_STATE) h.state = value;
      },
    },
  };
});

import { Hono } from 'hono';
import {
  BUNDLE_JOB_NAMES,
  CLI_EXEC_JOB_NAMES,
  lockNewWorkFenceShared,
  REPO_JOB_NAMES,
  TASK_JOB_NAMES,
} from '@haive/shared';
import { bundleRoutes } from '../src/routes/bundles.js';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { repoRoutes } from '../src/routes/repos.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { retryTaskAtStep } from '../src/routes/tasks/steps.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REFUSAL =
  'Haive is preparing for maintenance, so new work is not being started. Work already running will finish.';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.route('/repositories', repoRoutes);
app.route('/bundles', bundleRoutes);
app.route('/cli-providers', cliProviderRoutes);
app.route('/admin/maintenance', maintenanceRoutes);
app.onError(errorHandler);

describe.skipIf(!url)('the new-work fence on Postgres', () => {
  let db: Database;
  let updater: Database;
  let session: Awaited<ReturnType<Database['$client']['reserve']>> | undefined;
  let repositoryId: string;
  let requests: Promise<Response>[] = [];

  const post = (path: string, body: unknown) => {
    const request = Promise.resolve(
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    requests.push(request);
    return request;
  };
  const put = (path: string, body: unknown) => {
    const request = Promise.resolve(
      app.request(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    requests.push(request);
    return request;
  };
  const answered = async (request: Promise<Response>) => {
    const res = await request;
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const tasks = () => db.select().from(schema.tasks).where(eq(schema.tasks.userId, USER));

  /** The updater's side of a transition: its session holds the fence exclusively. */
  const holdFence = async () => {
    session = await updater.$client.reserve();
    await session`select pg_advisory_lock(hashtextextended(${FENCE}, 0))`;
  };
  const holdFenceShared = async () => {
    session = await updater.$client.reserve();
    await session`select pg_advisory_lock_shared(hashtextextended(${FENCE}, 0))`;
  };
  const releaseFence = async () => {
    if (!session) return;
    await session`select pg_advisory_unlock_all()`;
    session.release();
    session = undefined;
  };
  /** The fence is taken in the request's own transaction, so a held one shows as a waiting lock. */
  const untilBlocked = async (mode: 'ShareLock' | 'ExclusiveLock' = 'ShareLock') => {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const [row] = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_locks
             where locktype = 'advisory' and not granted and mode = ${mode}`,
      );
      if (row && row.n > 0) return;
      if (Date.now() > deadline) throw new Error('the request never waited for the new-work fence');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  /** The advisory locks held by the backend that waits for the fence, which nobody holding the fence can take. */
  const lockedWhileWaitingForTheFence = async () => {
    const [row] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_locks
           where locktype = 'advisory' and granted
             and pid in (select pid from pg_locks
                          where locktype = 'advisory' and not granted and mode = 'ShareLock')`,
    );
    return row?.n;
  };
  /** The updater writes the new state while it holds the fence, then lets go. */
  const drain = async () => {
    h.state = 'draining';
    await releaseFence();
  };

  const failedTask = async () => {
    const [row] = await db
      .insert(schema.tasks)
      .values({
        userId: USER,
        type: 'workflow',
        title: 'fence-failed',
        status: 'failed',
        errorMessage: 'boom',
        completedAt: new Date(),
      })
      .returning();
    return row!;
  };
  const createdTask = async () => {
    const [row] = await db
      .insert(schema.tasks)
      .values({ userId: USER, type: 'workflow', title: 'fence-created', status: 'created' })
      .returning();
    return row!;
  };
  const statusOf = async (id: string) =>
    (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, id) }))?.status;

  /** The tasks clause of the updater's live-work count (liveWorkCount, packages/updater/src/run.ts), for this user. */
  const liveTasks = async () => {
    const [row] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from tasks
           where user_id = ${USER} and dead_at is null
             and status in ('queued', 'running', 'paused', 'waiting_user', 'waiting_pr')`,
    );
    return row?.n;
  };

  const STEP = '11d-skill-sync';
  const ANSWERS = [
    { route: 'submit' as const, body: { values: { choice: 'yes' } } },
    { route: 'clarify' as const, body: { answer: 'Keep the incoming change.' } },
  ];
  const parkedFailedTask = async (over: Partial<typeof schema.tasks.$inferInsert> = {}) => {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId: USER,
        type: 'workflow',
        title: 'fence-parked',
        status: 'failed',
        errorMessage: 'boom',
        completedAt: new Date(),
        currentStepId: STEP,
        ...over,
      })
      .returning();
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: STEP,
        stepIndex: 1,
        runSeq: 1,
        round: 0,
        title: 'a step',
        status: 'waiting_form',
        waitingStartedAt: new Date(Date.now() - 60_000),
      })
      .returning();
    return { task: task!, step: step! };
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    updater = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'new-work-fence-test@test.local',
      emailBlindIndex: BLIND_INDEX,
      passwordHash: 'not-real',
      role: 'user',
    });
    const [repository] = await db
      .insert(schema.repositories)
      .values({ userId: USER, name: 'fence repo', source: 'local_path' })
      .returning({ id: schema.repositories.id });
    repositoryId = repository!.id;
  });

  beforeEach(async () => {
    h.state = 'normal';
    h.reads = [];
    h.queued = [];
    requests = [];
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
    await db.delete(schema.customBundles).where(eq(schema.customBundles.userId, USER));
    await db.delete(schema.cliProviders).where(eq(schema.cliProviders.userId, USER));
    await db
      .delete(schema.repositories)
      .where(and(eq(schema.repositories.userId, USER), ne(schema.repositories.id, repositoryId)));
  });

  afterEach(async () => {
    await releaseFence();
    await Promise.allSettled(requests);
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.$client.end({ timeout: 5 });
    await updater.$client.end({ timeout: 5 });
  });

  describe.each([
    { type: 'run_app', extra: {} },
    { type: 'workflow', extra: { description: 'do it' } },
    { type: 'onboarding', extra: {} },
  ])('POST /tasks of a $type task', ({ type, extra }) => {
    const create = () => post('/tasks', { type, title: `fence-${type}`, repositoryId, ...extra });

    it('creates the task while the state is normal and nothing holds the fence', async () => {
      expect(await answered(create())).toMatchObject({ status: 201 });

      expect(await tasks()).toHaveLength(1);
      expect(h.queued).toEqual([TASK_JOB_NAMES.START]);
    });

    it('does not wait for another admission, which holds the fence shared', async () => {
      await holdFenceShared();

      expect(await answered(create())).toMatchObject({ status: 201 });
      expect(await tasks()).toHaveLength(1);
    });

    it('waits for the fence, and creates the task when the state is still normal after it', async () => {
      await holdFence();
      const request = create();
      await untilBlocked();
      expect(await tasks()).toHaveLength(0);

      await releaseFence();

      expect(await answered(request)).toMatchObject({ status: 201 });
      expect(await tasks()).toHaveLength(1);
    });

    it('answers 503 and creates no task when the state turned draining while it waited for the fence', async () => {
      await holdFence();
      const request = create();
      await untilBlocked();

      await drain();

      expect(await answered(request)).toEqual({
        status: 503,
        body: { error: REFUSAL, code: null },
      });
      expect(await tasks()).toHaveLength(0);
      expect(h.queued).toEqual([]);
      expect(h.reads).toEqual(['normal', 'draining']);
    });

    it('holds no repository lock while it waits for a drain queued behind an admission, and is refused after it', async () => {
      await holdFenceShared();
      const write = put('/admin/maintenance', { state: 'draining' });
      await untilBlocked('ExclusiveLock');
      const request = create();
      await untilBlocked();

      expect(await lockedWhileWaitingForTheFence()).toBe(0);

      await releaseFence();
      expect(await answered(write)).toMatchObject({ status: 200 });
      expect(await answered(request)).toEqual({
        status: 503,
        body: { error: REFUSAL, code: null },
      });
      expect(await tasks()).toHaveLength(0);
    });

    it('lets a revival that holds the fence shared take the repository lock, with a drain queued between them', async () => {
      let proceed!: () => void;
      const go = new Promise<void>((resolve) => (proceed = resolve));
      let holding!: () => void;
      const holds = new Promise<void>((resolve) => (holding = resolve));
      const revival = db.transaction(async (tx) => {
        await lockNewWorkFenceShared(tx);
        holding();
        await go;
        await tx.execute(sql`set local lock_timeout = '300ms'`);
        await lockRepositoryRow(tx, repositoryId);
      });
      try {
        await holds;
        const write = put('/admin/maintenance', { state: 'draining' });
        await untilBlocked('ExclusiveLock');
        const request = create();
        await untilBlocked();

        proceed();

        await expect(revival).resolves.toBeUndefined();
        expect(await answered(write)).toMatchObject({ status: 200 });
        expect(await answered(request)).toEqual({
          status: 503,
          body: { error: REFUSAL, code: null },
        });
        expect(await tasks()).toHaveLength(0);
      } finally {
        proceed();
        await revival.catch(() => undefined);
      }
    });
  });

  it('still refuses at once, without waiting for the fence, when it is draining at the early check', async () => {
    h.state = 'draining';
    await holdFence();

    const res = await answered(
      post('/tasks', { type: 'run_app', title: 'fence-early', repositoryId }),
    );

    expect(res).toEqual({ status: 503, body: { error: REFUSAL, code: null } });
    expect(h.reads).toEqual(['draining']);
  });

  describe.each([
    {
      name: 'POST /repositories',
      prepare: async () => ({
        path: '/repositories',
        body: { source: 'blank', name: 'fence-repo' },
      }),
      status: 201,
      job: REPO_JOB_NAMES.INIT,
    },
    {
      name: 'POST /bundles/:id/sync',
      prepare: async () => {
        const [bundle] = await db
          .insert(schema.customBundles)
          .values({
            userId: USER,
            repositoryId,
            name: 'fence-bundle',
            sourceType: 'git',
            gitUrl: 'https://example.com/kit.git',
            storageRoot: '/bundles/fence',
          })
          .returning();
        return { path: `/bundles/${bundle!.id}/sync`, body: {} };
      },
      status: 200,
      job: BUNDLE_JOB_NAMES.RESYNC_GIT,
    },
    {
      name: 'POST /cli-providers/:id/sandbox-image/build',
      prepare: async () => {
        const [provider] = await db
          .insert(schema.cliProviders)
          .values({ userId: USER, name: 'claude-code', label: 'fence-provider' })
          .returning();
        return { path: `/cli-providers/${provider!.id}/sandbox-image/build`, body: {} };
      },
      status: 202,
      job: CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE,
    },
  ])('$name, which starts a background job', ({ prepare, status, job }) => {
    /** The rows the updater's live-work count reads from the tables these routes write, for this user. */
    const inProgress = async () => {
      const [row] = await db.execute<{ n: number }>(
        sql`select (
              (select count(*) from repositories where user_id = ${USER} and status = 'cloning')
              + (select count(*) from custom_bundles where user_id = ${USER} and status = 'syncing')
              + (select count(*) from cli_providers where user_id = ${USER}
                  and (sandbox_image_build_status = 'building'
                       or model_provision_status = 'provisioning'))
            )::int as n`,
      );
      return row?.n;
    };
    const rows = async () => [
      await db.select().from(schema.repositories).where(eq(schema.repositories.userId, USER)),
      await db.select().from(schema.customBundles).where(eq(schema.customBundles.userId, USER)),
      await db.select().from(schema.cliProviders).where(eq(schema.cliProviders.userId, USER)),
    ];

    it('starts the job and leaves the row the drain counts while the state is normal', async () => {
      const { path, body } = await prepare();

      expect(await answered(post(path, body))).toMatchObject({ status });

      expect(await inProgress()).toBe(1);
      expect(h.queued).toEqual([job]);
    });

    it('waits for the fence, and starts the job when the state is still normal after it', async () => {
      const { path, body } = await prepare();
      await holdFence();
      const request = post(path, body);
      await untilBlocked();
      expect(await inProgress()).toBe(0);

      await releaseFence();

      expect(await answered(request)).toMatchObject({ status });
      expect(await inProgress()).toBe(1);
    });

    it('answers 503 and writes and queues nothing when the state turned draining while it waited for the fence', async () => {
      const { path, body } = await prepare();
      const before = await rows();
      await holdFence();
      const request = post(path, body);
      await untilBlocked();

      await drain();

      expect(await answered(request)).toEqual({
        status: 503,
        body: { error: REFUSAL, code: null },
      });
      expect(await rows()).toEqual(before);
      expect(h.queued).toEqual([]);
      expect(h.reads).toEqual(['normal', 'draining']);
    });
  });

  describe('POST /tasks/:id/action retry of a failed task', () => {
    const retry = (id: string) => post(`/tasks/${id}/action`, { action: 'retry' });

    it('queues the task while the state is normal', async () => {
      const task = await failedTask();

      expect(await answered(retry(task.id))).toMatchObject({ status: 200 });
      expect(await statusOf(task.id)).toBe('queued');
    });

    it('answers 503 and leaves the task failed when the state turned draining while it waited', async () => {
      const task = await failedTask();
      await holdFence();
      const request = retry(task.id);
      await untilBlocked();

      await drain();

      expect(await answered(request)).toEqual({
        status: 503,
        body: { error: REFUSAL, code: null },
      });
      expect(await statusOf(task.id)).toBe('failed');
      expect(h.queued).toEqual([]);
    });
  });

  describe('POST /tasks/:id/action start of a created task', () => {
    const start = (id: string) => post(`/tasks/${id}/action`, { action: 'start' });

    it('queues the task while the state is normal', async () => {
      const task = await createdTask();

      expect(await answered(start(task.id))).toMatchObject({ status: 200 });
      expect(await statusOf(task.id)).toBe('queued');
    });

    it('answers 503 and leaves the task created when the state turned draining while it waited', async () => {
      const task = await createdTask();
      await holdFence();
      const request = start(task.id);
      await untilBlocked();

      await drain();

      expect(await answered(request)).toEqual({
        status: 503,
        body: { error: REFUSAL, code: null },
      });
      expect(await statusOf(task.id)).toBe('created');
      expect(h.queued).toEqual([]);
    });
  });

  describe('PUT /admin/maintenance', () => {
    const setState = (state: string) => put('/admin/maintenance', { state });

    it('writes the state at once while no admission holds the fence', async () => {
      expect(await answered(setState('draining'))).toMatchObject({ status: 200 });
      expect(h.state).toBe('draining');
    });

    it('waits for an admission already holding the fence, and writes the state once it lets go', async () => {
      await holdFenceShared();
      const request = setState('draining');
      await untilBlocked('ExclusiveLock');
      expect(h.state).toBe('normal');

      await releaseFence();

      expect(await answered(request)).toMatchObject({ status: 200 });
      expect(h.state).toBe('draining');
    });

    it('refuses an admission that asks for the fence after it, though that admission read normal first', async () => {
      await holdFenceShared();
      const write = setState('draining');
      await untilBlocked('ExclusiveLock');
      const create = post('/tasks', { type: 'run_app', title: 'fence-late', repositoryId });
      await untilBlocked('ShareLock');
      expect(h.state).toBe('normal');
      expect(await tasks()).toHaveLength(0);

      await releaseFence();

      expect(await answered(write)).toMatchObject({ status: 200 });
      expect(await answered(create)).toEqual({
        status: 503,
        body: { error: REFUSAL, code: null },
      });
      expect(await tasks()).toHaveLength(0);
      expect(h.queued).toEqual([]);
      expect(h.reads).toEqual(['normal', 'normal', 'draining']);
    });
  });

  describe('a Retry racing an answer to the same failed task', () => {
    const ROW_LOCK =
      /^(update "(tasks|task_steps)" |select [\s\S]* from "(tasks|task_steps)" [\s\S]* for (no key )?update)/;
    type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
    type Session = {
      prepareQuery: (
        query: { sql: string },
        ...rest: unknown[]
      ) => { execute: (...args: unknown[]) => Promise<unknown> };
    };
    interface Side {
      pid: number | undefined;
      reached: boolean;
      aborted: string | undefined;
      release: () => void;
      released: Promise<void>;
    }

    const side = (): Side => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { pid: undefined, reached: false, aborted: undefined, release, released };
    };
    const errorCode = (err: unknown) => {
      const { code, cause } = err as { code?: string; cause?: { code?: string } };
      return cause?.code ?? code ?? String(err);
    };
    /** Its transactions hold the first task or step row they lock until the side is released. */
    const holdingItsFirstRowLock = (who: Side): Database =>
      new Proxy(db, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop, target);
          if (prop !== 'transaction') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (fn: (tx: Tx) => Promise<unknown>) =>
            target
              .transaction(async (tx) => {
                const [backend] = await tx.execute<{ pid: number }>(
                  sql`select pg_backend_pid() as pid`,
                );
                who.pid = backend?.pid;
                const session = (tx as unknown as { session: Session }).session;
                const prepare = session.prepareQuery.bind(session);
                session.prepareQuery = (query, ...rest) => {
                  const prepared = prepare(query, ...rest);
                  const execute = prepared.execute.bind(prepared);
                  prepared.execute = async (...args) => {
                    const result = await execute(...args);
                    if (!who.reached && ROW_LOCK.test(query.sql)) {
                      who.reached = true;
                      await who.released;
                    }
                    return result;
                  };
                  return prepared;
                };
                return fn(tx);
              })
              .catch((err: unknown) => {
                who.aborted = errorCode(err);
                throw err;
              });
        },
      });
    const waitsForALock = async (who: Side) => {
      if (who.pid === undefined) return false;
      const [row] = await db.execute<{ waits: boolean }>(
        sql`select cardinality(pg_blocking_pids(${who.pid}::int)) > 0 as waits`,
      );
      return row?.waits === true;
    };
    const until = (done: () => boolean | Promise<boolean>) =>
      vi.waitFor(async () => expect(await done()).toBe(true), { timeout: 5_000, interval: 20 });

    /** The Retry holds its first lock; the answer holds one or waits for it; then both go on. */
    const race = async (route: 'submit' | 'clarify', body: unknown) => {
      const { task, step } = await parkedFailedTask();
      const retrier = side();
      const answerer = side();
      const retry = retryTaskAtStep(holdingItsFirstRowLock(retrier), task.id, USER, step).then(
        () => 'committed',
        (err: unknown) => errorCode(err),
      );
      try {
        await until(() => retrier.reached);
        h.db = holdingItsFirstRowLock(answerer);
        const answer = post(`/tasks/${task.id}/steps/${STEP}/${route}`, body);
        await until(async () => answerer.reached || (await waitsForALock(answerer)));
        retrier.release();
        answerer.release();
        const status = (await answer).status;
        return { task, retry: await retry, answer: answerer.aborted ?? status };
      } finally {
        retrier.release();
        answerer.release();
        await retry;
        await Promise.allSettled(requests);
        h.db = db;
      }
    };

    describe.each(ANSWERS)('$route', ({ route, body }) => {
      it('commits both, whichever of them waits for the other', async () => {
        const { task, retry, answer } = await race(route, body);

        expect({ retry, answer }).toEqual({ retry: 'committed', answer: 200 });
        expect(await statusOf(task.id)).toBe('running');
      }, 20_000);
    });

    /** The answer holds its first lock; the Retry waits for it or holds one; then both go on. */
    const raceAnswerFirst = async (route: 'submit' | 'clarify', body: unknown) => {
      const { task, step } = await parkedFailedTask({ repositoryId });
      const retrier = side();
      const answerer = side();
      h.db = holdingItsFirstRowLock(answerer);
      const answer = post(`/tasks/${task.id}/steps/${STEP}/${route}`, body);
      let retry: Promise<string> | undefined;
      try {
        await until(() => answerer.reached);
        retry = retryTaskAtStep(holdingItsFirstRowLock(retrier), task.id, USER, step).then(
          () => 'committed',
          (err: unknown) => errorCode(err),
        );
        await until(async () => retrier.reached || (await waitsForALock(retrier)));
        answerer.release();
        retrier.release();
        const status = (await answer).status;
        return { retry: await retry, answer: answerer.aborted ?? status };
      } finally {
        answerer.release();
        retrier.release();
        await retry;
        await Promise.allSettled(requests);
        h.db = db;
      }
    };

    describe.each(ANSWERS)(
      '$route, arriving first on a task of a repository',
      ({ route, body }) => {
        it('holds the Retry back at the repository lock instead of crossing it', async () => {
          const { retry, answer } = await raceAnswerFirst(route, body);

          expect({ answer, retryDeadlocked: retry === '40P01' }).toEqual({
            answer: 200,
            retryDeadlocked: false,
          });
        }, 20_000);
      },
    );
  });

  describe.each(ANSWERS)(
    'POST /tasks/:id/steps/:stepId/$route of a failed task',
    ({ route, body }) => {
      const answer = (id: string) => post(`/tasks/${id}/steps/${STEP}/${route}`, body);
      /** An upgrade of the repository goes live after the route's early checks, before its transaction. */
      const overtakenByAnUpgrade = (): Database => {
        let overtaken = false;
        return new Proxy(db, {
          get(target, prop) {
            const value: unknown = Reflect.get(target, prop, target);
            if (prop !== 'transaction') {
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return async (fn: Parameters<Database['transaction']>[0]) => {
              if (!overtaken) {
                overtaken = true;
                await target.insert(schema.tasks).values({
                  userId: USER,
                  repositoryId,
                  type: 'onboarding_upgrade',
                  title: 'fence-overtaking-upgrade',
                  status: 'running',
                });
              }
              return target.transaction(fn);
            };
          },
        });
      };

      it('commits the task running, so the drain taking the fence right after it counts it live', async () => {
        const { task } = await parkedFailedTask();

        expect(await answered(answer(task.id))).toMatchObject({ status: 200 });
        await holdFence();

        expect(await liveTasks()).toBe(1);
        expect(await statusOf(task.id)).toBe('running');
      });

      it('answers 409 and writes nothing when an upgrade of the repository goes live before the revival', async () => {
        await db.insert(schema.tasks).values({
          userId: USER,
          repositoryId,
          type: 'onboarding',
          title: 'fence-onboarded',
          status: 'completed',
          completedAt: new Date(Date.now() - 60_000),
        });
        const { task, step } = await parkedFailedTask({ type: 'onboarding_upgrade', repositoryId });
        h.db = overtakenByAnUpgrade();
        let res: Awaited<ReturnType<typeof answered>>;
        try {
          res = await answered(answer(task.id));
        } finally {
          h.db = db;
        }

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: expect.stringContaining('already in progress') });
        expect(await statusOf(task.id)).toBe('failed');
        expect(
          await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, step.id) }),
        ).toEqual(step);
        expect(
          await db.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, task.id)),
        ).toEqual([]);
        expect(h.queued).toEqual([]);
      });
    },
  );
});

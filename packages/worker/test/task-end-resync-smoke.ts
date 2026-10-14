/**
 * An onboarding or upgrade that ends re-syncs Haive's project files at once, and a dead task holds
 * no checkout, against a database and real git repositories. Throwaway user and temp directory,
 * removed after. The task functions are called directly, and the sweep never runs for an ending
 * under test.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  TASK_JOB_NAMES,
  configService,
  logger,
  secretsService,
  userSecretsService,
  type RepoJobPayload,
  type WorkflowType,
} from '@haive/shared';
import {
  RTK_ENABLED_UNIT,
  conflictSide,
  readRenderContextColumn,
} from '@haive/shared/project-state';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { initDatabase } from '../src/db.js';
import { closeRedis, initRedis } from '../src/redis.js';
import {
  handleResult,
  markTaskCompleted,
  markTaskDeadFromJob,
  markTaskFailed,
  processTaskJob,
  setContainerCleanupRunner,
} from '../src/queues/task-queue.js';
import { reconcileDeadTasks } from '../src/queues/dead-task-boot.js';
import { pull } from '../src/queues/plan-mirror-queue.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';
import { handleClone } from '../src/repo/clone.js';
import { checkoutHoldingTasks, handleRefresh } from '../src/repo/refresh.js';
import { sweepDirtyProjectStates } from '../src/project-state/refresh.js';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import { ProjectStateMovedError, writeProjectStateColumn } from '../src/project-state/write.js';
import { stepRegistry } from '../src/step-engine/registry.js';

const log = logger.child({ module: 'task-end-resync-smoke' });

for (const k of ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

/** A throw inside one control fails that control, and the ones after it still run. */
async function section(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    check(`${name}: ran to the end`, false, { err: String(err) });
  }
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'gc.auto=0', ...args], { cwd, env: gitEnv, encoding: 'utf8' }).trim();

const GONE = 'module.gone.x';
const SCOPE_REL = '.haive-data/state/settings/scope-exclude-globs.json';
const GLOBS = ['vendor', 'web/core'];
const SCOPE_TEXT = '[\n  "vendor",\n  "web/core"\n]\n';

const column = () => ({
  projectInfo: { name: 'task-end-resync-smoke' },
  framework: null,
  acceptedAgentIds: ['a'],
  customAgentSpecs: [],
  lspLanguages: [],
  rtkChoiceRecorded: true,
});

function stub(id: string, index: number) {
  stepRegistry.register({
    metadata: {
      id,
      workflowType: 'onboarding' as WorkflowType,
      index,
      title: id,
      description: 'task-end-resync-smoke stub',
      requiresCli: false,
    },
    async detect() {
      return {};
    },
    form() {
      return { title: id, fields: [{ id: 'note', label: 'note', type: 'text' }] };
    },
    async apply() {
      return {};
    },
  });
}

interface Scenario {
  repositoryId: string;
  repoPath: string;
}

async function main(): Promise<void> {
  initRedis(process.env.REDIS_URL!);
  await configService.initialize(process.env.REDIS_URL!);
  const db = initDatabase(process.env.DATABASE_URL!);
  await secretsService.initialize(db);
  await userSecretsService.initialize(db, await secretsService.getMasterKek());
  setContainerCleanupRunner(async () => 0);
  stub('tend-a', 90);
  stub('tend-b', 91);

  const tmp = await mkdtemp(path.join(tmpdir(), 'task-end-resync-smoke-'));
  const userId = randomUUID();
  const now = new Date();

  const job = (name: string, data: Record<string, unknown>) =>
    ({
      id: randomBytes(4).toString('hex'),
      name,
      data,
      timestamp: Date.now(),
      moveToDelayed: async () => undefined,
    }) as unknown as Parameters<typeof processTaskJob>[0];

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'task-end-resync-smoke@test.local',
      emailBlindIndex: `task-end-resync-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const pending = async (repositoryId: string): Promise<void> => {
      await db
        .update(schema.repositories)
        .set({ scopeExcludeGlobs: GLOBS })
        .where(eq(schema.repositories.id, repositoryId));
      await markProjectStateDirty(db, repositoryId);
    };
    const scenario = async (): Promise<Scenario> => {
      const repoPath = await mkdtemp(path.join(tmp, 'checkout-'));
      git(repoPath, 'init', '-q', '-b', 'main');
      const [repo] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'task-end-resync-smoke',
          source: 'local_path',
          localPath: repoPath,
          storagePath: repoPath,
          status: 'ready',
          renderContext: column(),
        })
        .returning({ id: schema.repositories.id });
      const repositoryId = repo!.id;
      await writeProjectStateColumn(db, { repositoryId, repoPath, column: column() });
      git(repoPath, 'add', '-A');
      git(repoPath, 'commit', '-q', '-m', 'record');
      await pending(repositoryId);
      return { repositoryId, repoPath };
    };

    const task = async (
      repositoryId: string | null,
      over: Partial<typeof schema.tasks.$inferInsert> = {},
    ): Promise<string> => {
      const [row] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId,
          type: 'onboarding',
          title: 'task-end-resync-smoke',
          status: 'running',
          autoContinue: false,
          ...over,
        })
        .returning({ id: schema.tasks.id });
      return row!.id;
    };
    const markDead = (taskId: string) =>
      db
        .update(schema.tasks)
        .set({ deadAt: new Date(), deadReason: 'smoke' })
        .where(eq(schema.tasks.id, taskId));
    const taskView = async (taskId: string) =>
      (await db.query.tasks.findFirst({
        where: eq(schema.tasks.id, taskId),
        columns: { status: true, deadAt: true },
      }))!;

    const scopeOnDisk = (s: Scenario) =>
      readFile(path.join(s.repoPath, SCOPE_REL), 'utf8').then(
        (text) => text,
        () => null,
      );
    const outbox = async (s: Scenario) =>
      (await db.query.projectStateOutbox.findFirst({
        where: eq(schema.projectStateOutbox.repositoryId, s.repositoryId),
      }))!;
    const outboxClean = async (s: Scenario) => {
      const row = await outbox(s);
      return row.writtenRevision >= row.revision;
    };
    const syncOutcome = async (s: Scenario) => (await syncProjectStateFromCheckout(db, s)).outcome;

    const startsDeferred = async (label: string, s: Scenario): Promise<void> => {
      check(
        `${label}: while the task holds the checkout the sync defers and the pending state is not on disk`,
        (await syncOutcome(s)) === 'deferred' &&
          (await scopeOnDisk(s)) === null &&
          !(await outboxClean(s)),
        { disk: await scopeOnDisk(s), outbox: await outbox(s) },
      );
    };
    const writtenAtOnce = async (label: string, s: Scenario): Promise<void> => {
      const disk = await scopeOnDisk(s);
      check(`${label}: the pending state is on disk at once, with no sweep`, disk === SCOPE_TEXT, {
        disk,
      });
      check(`${label}: and the outbox is clean`, await outboxClean(s), await outbox(s));
    };

    for (const type of ['onboarding', 'onboarding_upgrade'] as const) {
      const label = `T1 ${type} completes`;
      await section(label, async () => {
        const s = await scenario();
        const id = await task(s.repositoryId, { type });
        await startsDeferred(label, s);
        await markTaskCompleted(db, id, { epoch: 0 });
        check(`${label}: the task is completed`, (await taskView(id)).status === 'completed');
        await writtenAtOnce(label, s);
      });
    }

    await section('T2 onboarding fails', async () => {
      const s = await scenario();
      const id = await task(s.repositoryId);
      await startsDeferred('T2 onboarding fails', s);
      const failed = await markTaskFailed(db, id, 'smoke failure', 0);
      check(
        'T2 onboarding fails: the task is failed',
        failed && (await taskView(id)).status === 'failed',
      );
      await writtenAtOnce('T2 onboarding fails', s);
    });

    await section('T3 onboarding is cancelled', async () => {
      const s = await scenario();
      const id = await task(s.repositoryId);
      await startsDeferred('T3 onboarding is cancelled', s);
      let threw: unknown = null;
      await processTaskJob(job(TASK_JOB_NAMES.CANCEL, { taskId: id, userId })).catch(
        (err: unknown) => (threw = err),
      );
      check(
        'T3 onboarding is cancelled: the task is cancelled and the job finished',
        (await taskView(id)).status === 'cancelled' && threw === null,
        { threw: String(threw) },
      );
      await writtenAtOnce('T3 onboarding is cancelled', s);
    });

    const deadEnding = async (
      label: string,
      over: Partial<typeof schema.tasks.$inferInsert>,
      end: (s: Scenario, taskId: string) => Promise<unknown>,
    ): Promise<void> =>
      section(label, async () => {
        const s = await scenario();
        const id = await task(s.repositoryId, over);
        await startsDeferred(label, s);
        const before = await taskView(id);
        await end(s, id);
        const after = await taskView(id);
        check(
          `${label}: the task is dead and keeps its status`,
          after.deadAt !== null && after.status === before.status,
          { before, after },
        );
        await writtenAtOnce(label, s);
        const outcome = await syncOutcome(s);
        check(`${label}: the sync is not deferred by the dead task`, outcome !== 'deferred', {
          outcome,
        });
      });
    await deadEnding(
      'T4 dead at START',
      { status: 'queued', runListSnapshot: [GONE] },
      async (_s, id) => {
        await processTaskJob(job(TASK_JOB_NAMES.START, { taskId: id, userId }));
      },
    );
    await deadEnding('T4 dead from a job, on its step row', {}, async (_s, id) => {
      await db.insert(schema.taskSteps).values({
        taskId: id,
        stepId: 'tend-a',
        stepIndex: 1,
        round: 0,
        title: 'tend-a',
        status: 'running',
      });
      await markTaskDeadFromJob(db, id, 'gone', {
        epoch: 0,
        unresolved: [GONE],
        stepId: 'tend-a',
        round: 0,
      });
    });
    await deadEnding('T4 dead from a job, with no step row', {}, async (_s, id) => {
      await markTaskDeadFromJob(db, id, 'gone', { epoch: 0, unresolved: [GONE] });
    });
    await deadEnding(
      'T4 dead on a hand-off',
      { runListSnapshot: ['tend-b'], currentStepId: 'tend-a' },
      async (s, id) => {
        const [row] = await db
          .insert(schema.taskSteps)
          .values({
            taskId: id,
            stepId: 'tend-a',
            stepIndex: 1,
            round: 0,
            title: 'tend-a',
            status: 'done',
          })
          .returning();
        const ctx: ResolvedTaskContext = {
          taskId: id,
          userId,
          workflowType: 'onboarding',
          repoPath: s.repoPath,
          workspacePath: s.repoPath,
          cliProviderId: null,
          ignoreSavedStepClis: false,
          executionPath: null,
          metadata: null,
          orchestrationEpoch: 0,
          currentStepId: 'tend-a',
          currentRound: 0,
          status: 'running',
          completedAt: null,
          runListStrategy: 'static',
          runListSnapshot: ['tend-b'],
          fixLoop: null,
        };
        await handleResult(db, ctx, 'tend-a', { status: 'done', row: row!, output: {} });
      },
    );
    await deadEnding(
      'T4 dead at boot',
      { runListSnapshot: [GONE], currentStepId: GONE },
      async () => {
        await reconcileDeadTasks(db, {
          enqueueStart: async () => undefined,
          enqueueAdvance: async () => undefined,
        });
      },
    );

    await section('T5 count and sync', async () => {
      const s = await scenario();
      const id = await task(s.repositoryId);
      check(
        'T5 control: a live root task is counted as holding the checkout',
        (await checkoutHoldingTasks(db, s.repositoryId)) === 1 &&
          (await checkoutHoldingTasks(db, s.repositoryId, { rootOnly: true })) === 1,
      );
      check('T5 control: and the sync defers for it', (await syncOutcome(s)) === 'deferred');
      await markDead(id);
      const counts = [
        await checkoutHoldingTasks(db, s.repositoryId),
        await checkoutHoldingTasks(db, s.repositoryId, { rootOnly: true }),
      ];
      check(
        'T5 a dead root task is counted as holding nothing',
        counts.every((n) => n === 0),
        {
          counts,
        },
      );
      const outcome = await syncOutcome(s);
      check('T5 the sync is not deferred by a dead task', outcome !== 'deferred', { outcome });
    });
    await section('T5 pull', async () => {
      const s = await scenario();
      const id = await task(s.repositoryId);
      const pulled = () =>
        pull({ repositoryId: s.repositoryId, userId }).then(
          () => null,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        );
      const live = await pulled();
      check(
        'T5 control: a live root task makes a Pull busy',
        live?.includes('task in flight') === true,
        {
          live,
        },
      );
      await markDead(id);
      const dead = await pulled();
      check('T5 a dead task does not make a Pull busy', dead?.includes('task in flight') !== true, {
        dead,
      });
    });
    await section('T5 conflict answer', async () => {
      const s = await scenario();
      const id = await task(s.repositoryId);
      const [conflict] = await db
        .insert(schema.projectStateConflicts)
        .values({
          repositoryId: s.repositoryId,
          unit: RTK_ENABLED_UNIT,
          base: conflictSide(true),
          local: conflictSide(true),
          incoming: conflictSide(false),
        })
        .returning({ id: schema.projectStateConflicts.id });
      const answer = () =>
        resolveProjectStateConflict(db, {
          repositoryId: s.repositoryId,
          userId,
          conflictId: conflict!.id,
          answer: 'keep_mine',
        });
      check('T5 control: a live onboarding makes an answer busy', (await answer()).kind === 'busy');
      await markDead(id);
      const answered = await answer();
      check('T5 a dead onboarding does not: the answer is taken', answered.kind === 'resolved', {
        answered,
      });
    });
    await section('T5 released write', async () => {
      const s = await scenario();
      const id = await task(s.repositoryId);
      const write = async () => {
        const current = (await db.query.repositories.findFirst({
          where: eq(schema.repositories.id, s.repositoryId),
          columns: { renderContext: true },
        }))!.renderContext;
        const read = readRenderContextColumn(current);
        if (read.kind !== 'column') throw new Error('the smoke repository has no render context');
        await writeProjectStateColumn(db, {
          repositoryId: s.repositoryId,
          repoPath: s.repoPath,
          column: read.column,
          expectedColumns: [current],
          holdingTaskId: id,
        });
      };
      let liveError: unknown = null;
      await write().catch((err: unknown) => (liveError = err));
      check('T5 control: a live task writes its record', liveError === null, {
        liveError: String(liveError),
      });
      await markDead(id);
      let deadError: unknown = null;
      await write().catch((err: unknown) => (deadError = err));
      check(
        'T5 a dead task is a released one: its write is refused',
        deadError instanceof ProjectStateMovedError,
        { deadError: String(deadError) },
      );
    });

    await section('T6 onboarding created between a move and its re-sync', async () => {
      const storage = path.join(tmp, 'storage');
      await mkdir(storage);
      const origin = path.join(tmp, 'origin.git');
      git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
      const seed = path.join(tmp, 'seed');
      git(tmp, 'clone', '-q', `file://${origin}`, seed);
      await writeFile(path.join(seed, 'README.md'), 'seed\n');
      git(seed, 'add', 'README.md');
      git(seed, 'commit', '-q', '-m', 'seed');
      git(seed, 'push', '-q', 'origin', 'HEAD:main');

      const remoteUrl = `file://${origin}`;
      const [repo] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'task-end-resync-smoke',
          source: 'git_https',
          remoteUrl,
          branch: 'main',
        })
        .returning({ id: schema.repositories.id });
      const payload: RepoJobPayload = {
        repositoryId: repo!.id,
        userId,
        source: 'git_https',
        remoteUrl,
        branch: 'main',
      };
      await handleClone(payload, db, storage);
      const s: Scenario = {
        repositoryId: repo!.id,
        repoPath: path.join(storage, userId, repo!.id),
      };
      await db
        .update(schema.repositories)
        .set({ renderContext: column() })
        .where(eq(schema.repositories.id, s.repositoryId));
      await writeProjectStateColumn(db, { ...s, column: column() });
      git(s.repoPath, 'add', '-A');
      git(s.repoPath, 'commit', '-q', '-m', 'record');
      git(s.repoPath, 'push', '-q', 'origin', 'HEAD:main');
      git(seed, 'pull', '-q', '--ff-only', 'origin', 'main');
      await pending(s.repositoryId);
      await sweepDirtyProjectStates(db);
      check(
        'T6 setup: the sweep wrote the pending state, so the move has a file to set aside',
        (await scopeOnDisk(s)) === SCOPE_TEXT && (await outboxClean(s)),
        { disk: await scopeOnDisk(s), outbox: await outbox(s) },
      );

      await writeFile(path.join(seed, 'upstream.txt'), 'from upstream\n');
      git(seed, 'add', 'upstream.txt');
      git(seed, 'commit', '-q', '-m', 'upstream');
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      const upstream = git(seed, 'rev-parse', 'HEAD');

      const headBefore = git(s.repoPath, 'rev-parse', 'HEAD');
      let onboardingId: string | null = null;
      // The first transaction to end after the head moved is the move's own.
      const racing = new Proxy(db, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop, target);
          if (prop !== 'transaction') {
            return typeof value === 'function'
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          }
          return async (...args: unknown[]) => {
            const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            if (onboardingId === null && git(s.repoPath, 'rev-parse', 'HEAD') !== headBefore) {
              onboardingId = await task(s.repositoryId);
            }
            return out;
          };
        },
      });
      await handleRefresh(payload, racing, storage);
      check(
        'T6 the refresh moved the checkout and an onboarding was created right after the move',
        git(s.repoPath, 'rev-parse', 'HEAD') === upstream && onboardingId !== null,
        { head: git(s.repoPath, 'rev-parse', 'HEAD'), upstream, onboardingId },
      );
      check(
        'T6 the re-sync deferred: the pending state is not on disk and the outbox is dirty',
        (await scopeOnDisk(s)) === null && !(await outboxClean(s)),
        { disk: await scopeOnDisk(s), outbox: await outbox(s) },
      );
      await markTaskCompleted(db, onboardingId!, { epoch: 0 });
      await writtenAtOnce('T6 the onboarding ends', s);
    });

    await section('T7 workflow tasks', async () => {
      const s = await scenario();
      const done = await task(s.repositoryId, { type: 'workflow' });
      await markTaskCompleted(db, done, { epoch: 0 });
      const failed = await task(s.repositoryId, { type: 'workflow' });
      await markTaskFailed(db, failed, 'smoke failure', 0);
      check(
        'T7 the end of a workflow task, completed or failed, writes nothing',
        (await scopeOnDisk(s)) === null && !(await outboxClean(s)),
        { disk: await scopeOnDisk(s), outbox: await outbox(s) },
      );
      const onboarding = await task(s.repositoryId);
      await markTaskCompleted(db, onboarding, { epoch: 0 });
      await writtenAtOnce('T7 control: an onboarding ending after them', s);
    });
    await section('T7 onboarding with no repository', async () => {
      const orphan = await task(null);
      let threw: unknown = null;
      await markTaskCompleted(db, orphan, { epoch: 0 }).catch((err: unknown) => (threw = err));
      check(
        'T7 an onboarding with no repository ends without an error',
        threw === null && (await taskView(orphan)).status === 'completed',
        { threw: String(threw) },
      );
    });
    await section('T7 merge open', async () => {
      const s = await scenario();
      const mergeHead = path.join(s.repoPath, '.git', 'MERGE_HEAD');
      await writeFile(mergeHead, `${git(s.repoPath, 'rev-parse', 'HEAD')}\n`);
      const first = await task(s.repositoryId);
      await markTaskCompleted(db, first, { epoch: 0 });
      check(
        'T7 an onboarding ending while a merge is open writes nothing',
        (await scopeOnDisk(s)) === null && !(await outboxClean(s)),
        { disk: await scopeOnDisk(s), outbox: await outbox(s) },
      );
      await rm(mergeHead);
      const second = await task(s.repositoryId);
      await markTaskCompleted(db, second, { epoch: 0 });
      await writtenAtOnce('T7 control: the next ending, once the merge is over', s);
    });
  } finally {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.repositories).where(eq(schema.repositories.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await rm(tmp, { recursive: true, force: true });
    await closeRedis();
  }
}

main()
  .then(() => {
    if (failures > 0) {
      log.error({ checks, failures }, 'smoke FAILED');
      process.exit(1);
    }
    console.log(JSON.stringify({ smoke: 'TASK_END_RESYNC_OK', checks }));
    process.exit(0);
  })
  .catch((err) => {
    log.error({ err }, 'task end resync smoke crashed');
    process.exit(1);
  });

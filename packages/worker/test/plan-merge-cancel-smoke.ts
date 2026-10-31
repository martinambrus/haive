import { fixtureBase, networkGitArgs } from './support/smoke-git-http.js';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  configService,
  secretsService,
  userSecretsService,
  QUEUE_NAMES,
  TASK_JOB_NAMES,
  type TaskJobPayload,
} from '@haive/shared';
import { Queue } from 'bullmq';
import { initDatabase } from '../src/db.js';
import { initRedis, getBullRedis, closeRedis } from '../src/redis.js';
import {
  closeTaskQueue,
  setContainerCleanupRunner,
  startTaskWorker,
} from '../src/queues/task-queue.js';
import { divergence, ensurePlanMergeWorktree, mergeOriginInto } from '../src/plan/merge.js';

const exec = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const git = async (dir: string, args: string[]): Promise<string> =>
  (await exec('git', networkGitArgs(args), { cwd: dir, env: ENV })).stdout.toString();

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function main(): Promise<void> {
  let exitCode = 0;
  const root = await mkdtemp(path.join(fixtureBase, 'plan-merge-cancel-smoke-'));
  const remote = path.join(root, 'remote');
  const local = path.join(root, 'local');
  initRedis(process.env.REDIS_URL!);
  await configService.initialize(process.env.REDIS_URL!);
  const db = initDatabase(process.env.DATABASE_URL!);
  await secretsService.initialize(db);
  await userSecretsService.initialize(db, await secretsService.getMasterKek());
  setContainerCleanupRunner(async () => 0);
  const userId = randomUUID();
  const now = new Date();
  await db.insert(schema.users).values({
    id: userId,
    emailEncrypted: 'plan-merge-cancel@test.local',
    emailBlindIndex: `pmc-${randomBytes(4).toString('hex')}`,
    passwordHash: 'smoke-not-real',
    role: 'user',
    status: 'active',
    tokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  });
  const worker = startTaskWorker();
  const queue = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, { connection: getBullRedis() });
  const taskIds: string[] = [];
  let repoId: string | undefined;
  const cancel = async (taskId: string): Promise<void> => {
    await queue.add(TASK_JOB_NAMES.CANCEL, { taskId, userId });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const done = await db
        .select({ id: schema.taskEvents.id })
        .from(schema.taskEvents)
        .where(
          and(
            eq(schema.taskEvents.taskId, taskId),
            eq(schema.taskEvents.eventType, 'task.cancel_finished'),
          ),
        );
      if (done.length > 0) return;
      if (Date.now() > deadline) throw new Error('timeout waiting for task.cancel_finished');
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const taskRow = async (taskId: string) => {
    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    return row!;
  };
  const eventsOfType = (taskId: string, eventType: string) =>
    db
      .select({ id: schema.taskEvents.id })
      .from(schema.taskEvents)
      .where(and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, eventType)));
  /** The job has ended (completed), which a task with no finish record to wait for needs. */
  const jobCompleted = async (jobId: string): Promise<void> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if ((await (await queue.getJob(jobId))?.getState()) === 'completed') return;
      if (Date.now() > deadline) throw new Error('timeout waiting for the CANCEL job to complete');
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const registered = async (wt: string): Promise<boolean> =>
    (await git(local, ['worktree', 'list', '--porcelain'])).includes(`worktree ${wt}`);
  try {
    for (const [dir, readme] of [
      [remote, 'from the forge\n'],
      [local, 'from Haive\n'],
    ] as const) {
      await exec('mkdir', ['-p', dir]);
      await git(dir, ['init', '-b', 'main']);
      await git(dir, ['config', 'gc.auto', '0']);
      await writeFile(path.join(dir, 'README.md'), readme);
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'initial']);
    }
    await git(local, ['remote', 'add', 'origin', remote]);
    await git(local, ['fetch', 'origin', 'main']);

    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'plan-merge-cancel-smoke',
        source: 'blank',
        status: 'ready',
        storagePath: local,
      })
      .returning();
    repoId = repo!.id;
    const mk = async (status: 'waiting_user' | 'running'): Promise<string> => {
      const [t] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: repoId!,
          type: 'plan_merge',
          title: 'plan merge cancel smoke',
          status,
        })
        .returning();
      taskIds.push(t!.id);
      return t!.id;
    };
    const openMergeInScratch = async (): Promise<string> => {
      const wt = await ensurePlanMergeWorktree(local);
      const gap = await divergence(local, 'main');
      const attempt = await mergeOriginInto(wt, 'main', gap.unrelated, {
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@haive.local',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@haive.local',
      });
      if (attempt.clean) throw new Error('fixture merge did not conflict');
      return wt;
    };

    // 1. A cancelled conversation with an open scratch merge, no other live one.
    const first = await mk('waiting_user');
    const wt = await openMergeInScratch();
    await cancel(first);
    const out: Record<string, unknown> = {
      worktreeRegistered: await registered(wt),
      worktreeDirExists: await exists(wt),
    };

    // 2. Another live conversation of the repository holds the merge.
    const second = await mk('waiting_user');
    const holder = await mk('running');
    const wt2 = await openMergeInScratch();
    await cancel(second);
    const events = await db
      .select({ type: schema.taskEvents.eventType, payload: schema.taskEvents.payload })
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, second));
    out.heldWorktreeRegistered = await registered(wt2);
    out.skippedEvent = events.find((e) => e.type === 'plan_merge.discard_skipped')?.payload ?? null;
    out.holder = holder;

    // 3. A failed conversation opened after the cancelled one may be Retried onto the merge: kept.
    const setStatus = (id: string, status: 'completed' | 'failed') =>
      db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, id));
    await setStatus(holder, 'completed');
    const third = await mk('waiting_user');
    const newerFailed = await mk('running');
    await setStatus(newerFailed, 'failed');
    await cancel(third);
    out.newerFailedKept = await registered(wt2);

    // 4. A failed conversation older than the cancelled one does not hold it: discarded.
    const fourth = await mk('waiting_user');
    await cancel(fourth);
    out.olderFailedDiscarded = !(await registered(wt2));

    // 5. The api commits the cancel before it queues the job, so the job finds the task cancelled: it
    //    keeps the api's stamps, writes its own event and still discards the worktree.
    const apiCancelledAt = new Date('2026-01-15T10:00:00.000Z');
    const fifth = await mk('running');
    await db
      .update(schema.tasks)
      .set({ status: 'cancelled', completedAt: apiCancelledAt, orchestrationEpoch: 1 })
      .where(eq(schema.tasks.id, fifth));
    await db
      .insert(schema.taskEvents)
      .values({ taskId: fifth, eventType: 'task.cancelled', payload: { by: userId } });
    const wt5 = await openMergeInScratch();
    await cancel(fifth);
    const fifthRow = await taskRow(fifth);
    out.apiCancelledDiscarded = !(await registered(wt5));
    out.apiCancelledStampsKept =
      fifthRow.status === 'cancelled' &&
      fifthRow.completedAt?.getTime() === apiCancelledAt.getTime() &&
      fifthRow.orchestrationEpoch === 1;
    out.apiCancelledEvents = (await eventsOfType(fifth, 'task.cancelled')).length;

    // 6. A CANCEL that lands after the merge completed leaves it completed and its worktree alone.
    const sixth = await mk('running');
    await db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: apiCancelledAt })
      .where(eq(schema.tasks.id, sixth));
    const wt6 = await openMergeInScratch();
    const stray = await queue.add(TASK_JOB_NAMES.CANCEL, { taskId: sixth, userId });
    await jobCompleted(stray.id!);
    const sixthRow = await taskRow(sixth);
    out.completedLeftAlone =
      sixthRow.status === 'completed' &&
      sixthRow.completedAt?.getTime() === apiCancelledAt.getTime() &&
      (await eventsOfType(sixth, 'task.cancelled')).length === 0 &&
      (await eventsOfType(sixth, 'task.cancel_finished')).length === 0;
    out.completedKeptItsWorktree = await registered(wt6);
    console.log(JSON.stringify(out, null, 2));
    if (out.worktreeRegistered || out.worktreeDirExists) {
      throw new Error('the cancelled conversation left its scratch worktree behind');
    }
    if (!out.heldWorktreeRegistered || !out.skippedEvent) {
      throw new Error('a worktree another live conversation holds was discarded or unreported');
    }
    if (!out.newerFailedKept || !out.olderFailedDiscarded) {
      throw new Error('a newer failed conversation lost its worktree, or an older one kept it');
    }
    if (!out.apiCancelledDiscarded || !out.apiCancelledStampsKept || out.apiCancelledEvents !== 2) {
      throw new Error(
        'a conversation the api had cancelled kept its worktree, lost its stamps, or lacks the job event',
      );
    }
    if (!out.completedLeftAlone || !out.completedKeptItsWorktree) {
      throw new Error('a CANCEL for a completed conversation changed it or discarded its worktree');
    }
    console.log('PLAN_MERGE_CANCEL_OK');
  } catch (err) {
    exitCode = 1;
    console.error('[smoke] FAILED:', err);
  } finally {
    setContainerCleanupRunner(null);
    for (const id of taskIds) {
      await db.delete(schema.taskEvents).where(eq(schema.taskEvents.taskId, id));
      await db.delete(schema.taskSteps).where(eq(schema.taskSteps.taskId, id));
      await db.delete(schema.tasks).where(eq(schema.tasks.id, id));
    }
    if (repoId) await db.delete(schema.repositories).where(eq(schema.repositories.id, repoId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await rm(root, { recursive: true, force: true });
    await worker.close().catch(() => {});
    await queue.close().catch(() => {});
    await closeTaskQueue().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();

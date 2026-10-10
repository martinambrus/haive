import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { captureFixBaseline } from '../src/step-engine/git-merge.js';

const exec = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const git = async (dir: string, args: string[]): Promise<void> => {
  await exec('git', args, { cwd: dir, env: ENV });
};

async function main(): Promise<void> {
  let exitCode = 0;
  const dir = await mkdtemp(path.join(tmpdir(), 'cancel-merge-smoke-'));
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
    emailEncrypted: 'cancel-merge@test.local',
    emailBlindIndex: `cm-${randomBytes(4).toString('hex')}`,
    passwordHash: 'smoke-not-real',
    role: 'user',
    status: 'active',
    tokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  });
  const worker = startTaskWorker();
  const queue = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, { connection: getBullRedis() });
  let taskId: string | undefined;
  try {
    await git(dir, ['init', '-b', 'main']);
    await git(dir, ['config', 'gc.auto', '0']);
    await writeFile(path.join(dir, 'base.txt'), 'base\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await git(dir, ['checkout', '-b', 'feature/x']);
    await writeFile(path.join(dir, 'base.txt'), 'feature\n');
    await git(dir, ['commit', '-am', 'feature']);
    await git(dir, ['checkout', 'main']);
    await writeFile(path.join(dir, 'base.txt'), 'main\n');
    await git(dir, ['commit', '-am', 'main']);
    await git(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']).catch(() => undefined);
    const fixBaseline = await captureFixBaseline(dir, async () => null);
    await writeFile(path.join(dir, 'stray.txt'), 'fixer scratch\n');

    const [task] = await db
      .insert(schema.tasks)
      .values({ userId, type: 'workflow', title: 'cancel merge smoke', status: 'running' })
      .returning();
    taskId = task!.id;
    const [row] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: '12-worktree-cleanup',
        stepIndex: 12,
        title: 'cleanup',
        status: 'waiting_cli',
        mergeResolveState: {
          mode: 'same-branch',
          phase: 'resolving',
          baseBranch: 'main',
          featureBranch: 'feature/x',
          mergeDir: dir,
          sandboxMergeDir: dir,
          fixInvocationId: 'inv-smoke',
          conflictRetries: 1,
          pendingQuestion: null,
          pushAfterMerge: false,
          merged: false,
          skipReason: null,
          pushed: false,
          fixBaseline,
        },
      })
      .returning();
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
      if (done.length > 0) break;
      if (Date.now() > deadline) throw new Error('timeout waiting for task.cancel_finished');
      await new Promise((r) => setTimeout(r, 200));
    }
    const mergeHead = await exec('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
      cwd: dir,
      env: ENV,
    }).then(
      () => 'present',
      () => 'gone',
    );
    const moved = await readFile(
      path.join(dir, '.haive/merge-leftovers', taskId, 'inv-smoke/files/stray.txt'),
      'utf8',
    );
    const events = await db
      .select({ type: schema.taskEvents.eventType, payload: schema.taskEvents.payload })
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, taskId));
    const leftovers = events.find((e) => e.type === 'merge.fixer_leftovers');
    const after = await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, row!.id) });
    const out = {
      mergeHead,
      movedContent: moved,
      baseTxt: await readFile(path.join(dir, 'base.txt'), 'utf8'),
      leftoversEvent: leftovers?.payload,
      abortFailed: events.some((e) => e.type === 'merge.abort_failed'),
      baselineCleared: (after?.mergeResolveState as { fixBaseline?: unknown })?.fixBaseline ?? null,
    };
    console.log(JSON.stringify(out, null, 2));
    if (mergeHead !== 'gone' || moved !== 'fixer scratch\n' || !leftovers || out.abortFailed) {
      throw new Error('cancel did not settle the merge');
    }
    console.log('CANCEL_MERGE_OK');
  } catch (err) {
    exitCode = 1;
    console.error('[smoke] FAILED:', err);
  } finally {
    setContainerCleanupRunner(null);
    if (taskId) {
      await db.delete(schema.taskEvents).where(eq(schema.taskEvents.taskId, taskId));
      await db.delete(schema.taskSteps).where(eq(schema.taskSteps.taskId, taskId));
      await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId));
    }
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await rm(dir, { recursive: true, force: true });
    await worker.close().catch(() => {});
    await queue.close().catch(() => {});
    await closeTaskQueue().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();

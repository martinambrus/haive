import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  configService,
  logger,
  QUEUE_NAMES,
  secretsService,
  TASK_JOB_NAMES,
  userSecretsService,
} from '@haive/shared';
import { Queue } from 'bullmq';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, getBullRedis, closeRedis } from '../src/redis.js';
import {
  closeTaskQueue,
  setContainerCleanupRunner,
  startTaskWorker,
} from '../src/queues/task-queue.js';
import { captureFixBaseline } from '../src/step-engine/git-merge.js';

process.env.HAIVE_TEST_BYPASS_LLM = '1';

const log = logger.child({ module: 'left-open-merge-smoke' });

for (const k of ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

const OPEN = 'merge.left_open';
const SETTLED = 'merge.left_open_settled';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function gitTry(dir: string, ...args: string[]): void {
  try {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  } catch {
    // a conflicted merge exits non-zero by design
  }
}

/** A repository with a merge of `feat/a` into `main` left open on a conflict in conflict.txt. */
async function conflictedRepo(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'user.email', 'smoke@test.local');
  git(dir, 'config', 'user.name', 'smoke');
  await writeFile(path.join(dir, 'conflict.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/a');
  await writeFile(path.join(dir, 'conflict.txt'), 'feature\n');
  git(dir, 'commit', '-q', '-am', 'feature');
  git(dir, 'checkout', '-q', 'main');
  await writeFile(path.join(dir, 'conflict.txt'), 'main\n');
  git(dir, 'commit', '-q', '-am', 'main');
  gitTry(dir, 'merge', '--no-ff', 'feat/a');
  if (!existsSync(path.join(dir, '.git', 'MERGE_HEAD'))) throw new Error('fixture merge not open');
  return dir;
}

const mergeOpen = (dir: string): boolean => existsSync(path.join(dir, '.git', 'MERGE_HEAD'));

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  label: string,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val !== null) return val;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function events(db: Database, taskId: string, type: string) {
  return db
    .select()
    .from(schema.taskEvents)
    .where(and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, type)))
    .orderBy(asc(schema.taskEvents.createdAt));
}

async function main(): Promise<void> {
  let exitCode = 0;
  const taskIds: string[] = [];
  let userId: string | undefined;
  let tmp: string | undefined;
  let worker: ReturnType<typeof startTaskWorker> | undefined;
  let queue: Queue | undefined;
  try {
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    await userSecretsService.initialize(db, await secretsService.getMasterKek());
    setContainerCleanupRunner(async () => 0);
    tmp = await mkdtemp(path.join(tmpdir(), 'haive-left-open-'));

    const now = new Date();
    userId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'left-open@test.local',
      emailBlindIndex: `left-open-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const uid = userId;

    /** A running task whose merge step holds `dir` with a fixer in flight, a recorded baseline. */
    async function fixerTask(title: string, dir: string, phase = 'resolving') {
      const [task] = await db
        .insert(schema.tasks)
        .values({ userId: uid, type: 'workflow', title, status: 'running' })
        .returning();
      taskIds.push(task!.id);
      const baseline = await captureFixBaseline(dir, async () => null);
      const [step] = await db
        .insert(schema.taskSteps)
        .values({
          taskId: task!.id,
          stepId: '12-worktree-cleanup',
          stepIndex: 0,
          title: 'merge',
          status: 'waiting_cli',
          mergeResolveState: {
            mode: 'same-branch',
            phase,
            baseBranch: 'main',
            featureBranch: 'feat/a',
            mergeDir: dir,
            sandboxMergeDir: dir,
            fixInvocationId: randomUUID(),
            conflictRetries: 1,
            pendingQuestion: null,
            pushAfterMerge: false,
            merged: false,
            skipReason: null,
            pushed: false,
            fixBaseline: baseline,
          },
        } as typeof schema.taskSteps.$inferInsert)
        .returning();
      await db
        .insert(schema.mergeDirClaims)
        .values({ mergeDir: dir, taskId: task!.id, taskStepId: step!.id });
      return { task: task!, step: step! };
    }

    worker = startTaskWorker();
    queue = new Queue(QUEUE_NAMES.TASK, { connection: getBullRedis() });
    const q = queue;
    const cancel = async (taskId: string, expectFinished: number) => {
      await q.add(TASK_JOB_NAMES.CANCEL, { taskId, userId: uid });
      await pollUntil(
        async () =>
          (await events(db, taskId, 'task.cancel_finished')).length >= expectFinished ? true : null,
        `cancel_finished #${expectFinished}`,
      );
    };

    // 1. A cancel with a fixer in flight and the merge open writes the event, once.
    const dirA = await conflictedRepo(tmp, 'a');
    const headA = git(dirA, 'rev-parse', 'HEAD');
    const mergeHeadA = git(dirA, 'rev-parse', 'MERGE_HEAD');
    const a = await fixerTask('left open A', dirA);
    await writeFile(path.join(dirA, 'stray.txt'), 'the fixer wrote this\n');
    await cancel(a.task.id, 1);
    const opened = await events(db, a.task.id, OPEN);
    assert(opened.length === 1, `expected one ${OPEN} event, got ${opened.length}`);
    assert(
      JSON.stringify(opened[0]!.payload) ===
        JSON.stringify({ dir: dirA, ref: 'feat/a', head: headA, mergeHead: mergeHeadA }),
      `unexpected ${OPEN} payload ${JSON.stringify(opened[0]!.payload)}`,
    );
    assert(mergeOpen(dirA), 'the cancel must leave the merge open');
    await cancel(a.task.id, 2);
    assert(
      (await events(db, a.task.id, OPEN)).length === 1,
      'a re-driven cancel must not write the event twice',
    );

    // 1b. A merge step already past its merge reports nothing, even beside a merge a person opened.
    const dirDone = await conflictedRepo(tmp, 'done');
    const done = await fixerTask('left open done', dirDone, 'done');
    await cancel(done.task.id, 1);
    assert(
      (await events(db, done.task.id, OPEN)).length === 0,
      'a finished merge phase must not be reported',
    );

    // 2. The abort job: matching state -> aborted, the stray file moved aside, settled written.
    await q.add(TASK_JOB_NAMES.ABORT_LEFT_MERGE, { taskId: a.task.id, userId: uid, dir: dirA });
    const settledA = await pollUntil(async () => {
      const rows = await events(db, a.task.id, SETTLED);
      return rows.length > 0 ? rows : null;
    }, 'settled event for A');
    const payloadA = settledA[0]!.payload as { outcome: string; dir: string; mergeHead: string };
    assert(payloadA.outcome === 'aborted', `expected aborted, got ${JSON.stringify(payloadA)}`);
    assert(payloadA.dir === dirA && payloadA.mergeHead === mergeHeadA, 'settled keys the event');
    assert(!mergeOpen(dirA), 'the merge must be aborted');
    assert(!existsSync(path.join(dirA, 'stray.txt')), 'the fixer file must be moved aside');
    const folder = path.join(dirA, '.haive/merge-leftovers', a.task.id);
    assert((await readdir(folder)).length > 0, 'the fixer leftovers must be recorded');
    assert(
      (await events(db, a.task.id, 'merge.fixer_leftovers')).length === 1,
      'the relocation must be reported as an event',
    );
    await q.add(TASK_JOB_NAMES.ABORT_LEFT_MERGE, { taskId: a.task.id, userId: uid, dir: dirA });
    await new Promise((r) => setTimeout(r, 1500));
    assert(
      (await events(db, a.task.id, SETTLED)).length === 1,
      'a settled merge is not settled twice',
    );

    // 3. HEAD moved since the event -> 'moved', the merge a person reopened is left alone.
    const dirB = await conflictedRepo(tmp, 'b');
    const b = await fixerTask('left open B', dirB);
    await cancel(b.task.id, 1);
    git(dirB, 'merge', '--abort');
    await writeFile(path.join(dirB, 'other.txt'), 'later\n');
    git(dirB, 'add', 'other.txt');
    git(dirB, 'commit', '-q', '-m', 'later');
    gitTry(dirB, 'merge', '--no-ff', 'feat/a');
    assert(mergeOpen(dirB), 'the reopened merge must be open');
    await q.add(TASK_JOB_NAMES.ABORT_LEFT_MERGE, { taskId: b.task.id, userId: uid, dir: dirB });
    const settledB = await pollUntil(async () => {
      const rows = await events(db, b.task.id, SETTLED);
      return rows.length > 0 ? rows : null;
    }, 'settled event for B');
    assert(
      (settledB[0]!.payload as { outcome: string }).outcome === 'moved',
      `expected moved, got ${JSON.stringify(settledB[0]!.payload)}`,
    );
    assert(mergeOpen(dirB), 'a merge that changed since must not be aborted');

    // 4. A live task's claim on the dir -> refused, the merge stays open.
    const dirC = await conflictedRepo(tmp, 'c');
    const c = await fixerTask('left open C', dirC);
    await cancel(c.task.id, 1);
    const [holder] = await db
      .insert(schema.tasks)
      .values({ userId: uid, type: 'workflow', title: 'live holder', status: 'running' })
      .returning();
    taskIds.push(holder!.id);
    const [holderStep] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: holder!.id,
        stepId: '12-worktree-cleanup',
        stepIndex: 0,
        title: 'merge',
        status: 'running',
      })
      .returning();
    await db
      .insert(schema.mergeDirClaims)
      .values({ mergeDir: dirC, taskId: holder!.id, taskStepId: holderStep!.id });
    await q.add(TASK_JOB_NAMES.ABORT_LEFT_MERGE, { taskId: c.task.id, userId: uid, dir: dirC });
    const settledC = await pollUntil(async () => {
      const rows = await events(db, c.task.id, SETTLED);
      return rows.length > 0 ? rows : null;
    }, 'settled event for C');
    assert(
      (settledC[0]!.payload as { outcome: string }).outcome === 'refused',
      `expected refused, got ${JSON.stringify(settledC[0]!.payload)}`,
    );
    assert(mergeOpen(dirC), 'a merge another live task holds must not be aborted');
    // A refusal leaves the report open: once the holder lets go, a second request aborts it.
    await db.delete(schema.mergeDirClaims).where(eq(schema.mergeDirClaims.mergeDir, dirC));
    await q.add(TASK_JOB_NAMES.ABORT_LEFT_MERGE, { taskId: c.task.id, userId: uid, dir: dirC });
    const retriedC = await pollUntil(async () => {
      const rows = await events(db, c.task.id, SETTLED);
      return rows.length > 1 ? rows : null;
    }, 'second settled event for C');
    assert(
      (retriedC[1]!.payload as { outcome: string }).outcome === 'aborted',
      `expected the retry to abort, got ${JSON.stringify(retriedC[1]!.payload)}`,
    );
    assert(!mergeOpen(dirC), 'the retried abort must clear the merge');

    // 5. The next resolver clearing the stale merge settles it and warns on its step.
    const { peekOpenMerge, noteAbortedByNext } =
      await import('../src/step-engine/left-open-merge.js');
    const { abortMerge } = await import('../src/step-engine/git-merge.js');
    const dirD = await conflictedRepo(tmp, 'd');
    const d = await fixerTask('left open D', dirD);
    await cancel(d.task.id, 1);
    const next = await fixerTask('next resolver', await conflictedRepo(tmp, 'e'));
    const before = await peekOpenMerge(dirD);
    assert(before !== null, 'peek must see the open merge');
    assert((await abortMerge(dirD)).ok, 'fixture abort failed');
    const row = await noteAbortedByNext(db, next.step as never, next.task.id, dirD, before);
    assert(row.warningMessage?.includes('left open D'), 'the step warning must name the task');
    const settledD = await events(db, d.task.id, SETTLED);
    assert(
      settledD.length === 1 &&
        (settledD[0]!.payload as { outcome: string }).outcome === 'aborted-by-next',
      `expected aborted-by-next, got ${JSON.stringify(settledD.map((e) => e.payload))}`,
    );
    const quiet = await noteAbortedByNext(db, row, next.task.id, dirD, {
      head: 'nope',
      mergeHead: 'nope',
    });
    assert(
      quiet.warningMessage === row.warningMessage,
      'a merge no event names must add no warning',
    );

    console.log(JSON.stringify({ smoke: 'LEFT_OPEN_MERGE_OK' }));
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    setContainerCleanupRunner(null);
    try {
      const db = getDb();
      if (taskIds.length > 0) {
        await db
          .delete(schema.mergeDirClaims)
          .where(inArray(schema.mergeDirClaims.taskId, taskIds));
        await db.delete(schema.taskEvents).where(inArray(schema.taskEvents.taskId, taskIds));
        await db.delete(schema.tasks).where(inArray(schema.tasks.id, taskIds));
      }
      if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup db rows failed');
    }
    if (tmp) await rm(tmp, { recursive: true, force: true });
    if (worker) await worker.close().catch(() => {});
    if (queue) await queue.close().catch(() => {});
    await closeTaskQueue().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();

/**
 * The merge-dir claim against a database: who may take a dir, when a claim is stale, that a cancel's
 * release waits for a section in flight and every later section is refused, that a Retry-shaped
 * write order does not deadlock with a section, and that waiters hold no pooled connection.
 * Throwaway users, tasks and steps, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import {
  claimMergeDir,
  inMergeDirLock,
  releaseMergeDir,
  releaseTaskMergeClaims,
  withMergeDirSection,
} from '../src/step-engine/merge-dir-claim.js';
import { StepSupersededError } from '../src/step-engine/step-ownership.js';

const log = logger.child({ module: 'merge-dir-claim-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const outcome = (err: unknown) =>
  err instanceof StepSupersededError ? 'superseded' : `error: ${err}`;

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const userId = randomUUID();
  const now = new Date();
  const dirs = (label: string) => `/smoke/${randomBytes(4).toString('hex')}/${label}--base`;

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'merge-dir-claim-smoke',
      emailBlindIndex: `merge-dir-claim-smoke-${randomBytes(6).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const makeTask = async (title: string, epoch = 3) => {
      const [task] = await db
        .insert(schema.tasks)
        .values({ userId, type: 'workflow', title, status: 'running', orchestrationEpoch: epoch })
        .returning({ id: schema.tasks.id });
      const [step] = await db
        .insert(schema.taskSteps)
        .values({
          taskId: task!.id,
          stepId: '12-worktree-cleanup',
          stepIndex: 0,
          title: 'merge',
          status: 'running',
        })
        .returning({ id: schema.taskSteps.id });
      const [later] = await db
        .insert(schema.taskSteps)
        .values({
          taskId: task!.id,
          stepId: '13-later',
          stepIndex: 1,
          title: 'later',
          status: 'pending',
        })
        .returning({ id: schema.taskSteps.id });
      return { taskId: task!.id, stepId: step!.id, laterStepId: later!.id, epoch };
    };
    const owner = (t: Awaited<ReturnType<typeof makeTask>>, mergeDir: string) => ({
      mergeDir,
      stepId: t.stepId,
      taskId: t.taskId,
      epoch: t.epoch,
    });
    const setTask = (taskId: string, status: 'completed' | 'failed' | 'cancelled' | 'running') =>
      db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, taskId));
    const claimRow = async (mergeDir: string) =>
      (
        await db
          .select()
          .from(schema.mergeDirClaims)
          .where(eq(schema.mergeDirClaims.mergeDir, mergeDir))
      )[0];

    const a = await makeTask('smoke A');
    const b = await makeTask('smoke B');

    // --- who may take a dir ---
    let dir = dirs('claim');
    check('a free dir is claimed', (await claimMergeDir(db, owner(a, dir))).kind === 'claimed');
    const held = await claimMergeDir(db, owner(b, dir));
    check(
      "another task's claim holds, and names its task",
      held.kind === 'held' && held.holder.id === a.taskId && held.holder.title === 'smoke A',
      held,
    );
    check(
      'the same step claims again',
      (await claimMergeDir(db, owner(a, dir))).kind === 'claimed',
    );
    const later = { ...owner(a, dir), stepId: a.laterStepId };
    check(
      'the same task claims from another step',
      (await claimMergeDir(db, later)).kind === 'claimed',
    );
    check(
      "...and the claim is now that step's",
      (await claimRow(dir))?.taskStepId === a.laterStepId,
    );
    check(
      '...so the earlier step no longer has it',
      (await withMergeDirSection(db, owner(a, dir), async () => 'ran').catch(outcome)) ===
        'superseded',
    );
    await claimMergeDir(db, owner(a, dir));

    // --- when a claim is stale ---
    await setTask(a.taskId, 'failed');
    check('a failed task keeps holding', (await claimMergeDir(db, owner(b, dir))).kind === 'held');
    await setTask(a.taskId, 'cancelled');
    check(
      'a cancelled task holds until its teardown released it',
      (await claimMergeDir(db, owner(b, dir))).kind === 'held',
    );
    await releaseTaskMergeClaims(db, a.taskId);
    check("a cancel's release frees the dir", (await claimRow(dir)) === undefined);
    check('...for another task', (await claimMergeDir(db, owner(b, dir))).kind === 'claimed');
    await setTask(a.taskId, 'running');

    dir = dirs('late-claim');
    const late = await makeTask('smoke late');
    await claimMergeDir(db, owner(late, dir));
    await setTask(late.taskId, 'cancelled');
    check(
      'a cancelled task without task.cancel_finished still holds',
      (await claimMergeDir(db, owner(b, dir))).kind === 'held',
    );
    await db.insert(schema.taskEvents).values({
      taskId: late.taskId,
      eventType: 'task.cancel_finished',
      payload: { source: 'worker' },
    });
    check(
      'a cancelled task with task.cancel_finished is stale: its dir is taken over',
      (await claimMergeDir(db, owner(b, dir))).kind === 'claimed',
    );
    check("...and the claim is the new owner's", (await claimRow(dir))?.taskId === b.taskId);
    dir = dirs('event-only');
    const evt = await makeTask('smoke event only');
    await claimMergeDir(db, owner(evt, dir));
    await db.insert(schema.taskEvents).values({
      taskId: evt.taskId,
      eventType: 'task.cancel_finished',
      payload: { source: 'worker' },
    });
    check(
      'a running task with the event (a stale one) still holds',
      (await claimMergeDir(db, owner(b, dir))).kind === 'held',
    );

    dir = dirs('completed');
    await claimMergeDir(db, owner(a, dir));
    await setTask(a.taskId, 'completed');
    check(
      'a completed task is stale: its dir is taken over',
      (await claimMergeDir(db, owner(b, dir))).kind === 'claimed',
    );
    check("...and the claim is the new owner's", (await claimRow(dir))?.taskId === b.taskId);
    await setTask(a.taskId, 'running');

    dir = dirs('skipped');
    await claimMergeDir(db, owner(a, dir));
    await db
      .update(schema.taskSteps)
      .set({ status: 'skipped' })
      .where(eq(schema.taskSteps.id, a.stepId));
    check(
      'a skipped step is stale: its dir is taken over',
      (await claimMergeDir(db, owner(b, dir))).kind === 'claimed',
    );
    await db
      .update(schema.taskSteps)
      .set({ status: 'running' })
      .where(eq(schema.taskSteps.id, a.stepId));

    dir = dirs('cascade');
    await claimMergeDir(db, owner(a, dir));
    const gone = await makeTask('smoke gone');
    const goneDir = dirs('gone');
    await claimMergeDir(db, owner(gone, goneDir));
    await db.delete(schema.tasks).where(eq(schema.tasks.id, gone.taskId));
    check('deleting the task deletes its claim', (await claimRow(goneDir)) === undefined);

    // --- a section ---
    dir = dirs('section');
    await claimMergeDir(db, owner(a, dir));
    let ran = false;
    const refused = await withMergeDirSection(db, owner(b, dir), async () => {
      ran = true;
    }).catch(outcome);
    check(
      'a section of a step that does not hold the claim is refused',
      refused === 'superseded' && !ran,
      refused,
    );
    const behind = await withMergeDirSection(
      db,
      { ...owner(a, dir), epoch: a.epoch - 1 },
      async () => {
        ran = true;
      },
    ).catch(outcome);
    check(
      'a section at an epoch the task has left is refused',
      behind === 'superseded' && !ran,
      behind,
    );
    const wrote = await withMergeDirSection(db, owner(a, dir), async (tx) => {
      await tx
        .update(schema.taskSteps)
        .set({ statusMessage: 'in section' })
        .where(eq(schema.taskSteps.id, a.stepId));
      return 'ran';
    });
    check("the holder's section runs, writing through its transaction", wrote === 'ran');
    const rolledBack = await withMergeDirSection(db, owner(a, dir), async (tx) => {
      await tx
        .update(schema.taskSteps)
        .set({ statusMessage: 'rolled back' })
        .where(eq(schema.taskSteps.id, a.stepId));
      throw new Error('boom');
    }).catch((err: unknown) => String(err));
    const msg = (
      await db
        .select({ m: schema.taskSteps.statusMessage })
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.id, a.stepId))
    )[0]?.m;
    check(
      'a section that throws rolls its writes back',
      rolledBack.includes('boom') && msg === 'in section',
      { rolledBack, msg },
    );

    await withMergeDirSection(db, owner(a, dir), (tx) => releaseMergeDir(tx, owner(a, dir)));
    check('release inside a section deletes the claim', (await claimRow(dir)) === undefined);

    // --- a cancel's release waits for a section in flight; later sections are refused ---
    dir = dirs('cancel');
    await claimMergeDir(db, owner(a, dir));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const open = withMergeDirSection(db, owner(a, dir), async () => {
      entered();
      await gate;
    });
    await inside;
    const cancelWrite = db
      .update(schema.tasks)
      .set({ status: 'cancelled', orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1` })
      .where(eq(schema.tasks.id, a.taskId))
      .then(() => 'written');
    check(
      'the task row is written while a section is in flight',
      (await Promise.race([cancelWrite, sleep(3000).then(() => 'blocked')])) === 'written',
    );
    let releaseSettled = false;
    const releasing = releaseTaskMergeClaims(db, a.taskId).finally(() => {
      releaseSettled = true;
    });
    void releasing.catch(() => undefined);
    await sleep(600);
    check("a cancel's release waits behind a section in flight", !releaseSettled);
    check('...and the claim is still there', (await claimRow(dir)) !== undefined);
    release();
    await open;
    await releasing;
    check('...and lands once the section commits', releaseSettled);
    check('...deleting the claim', (await claimRow(dir)) === undefined);
    check(
      'a section after the cancel is refused (epoch moved)',
      (await withMergeDirSection(
        db,
        { ...owner(a, dir), epoch: a.epoch + 1 },
        async () => 'ran',
      ).catch(outcome)) === 'superseded',
    );
    check(
      'a claim after the cancel is refused',
      (await claimMergeDir(db, { ...owner(a, dirs('after')), epoch: a.epoch + 1 }).catch(
        outcome,
      )) === 'superseded',
    );

    // --- the release also waits for any holder of the dir's lock ---
    const g = await makeTask('smoke G');
    dir = dirs('release-lock');
    await claimMergeDir(db, owner(g, dir));
    let lockOff!: () => void;
    const lockHeld = new Promise<void>((resolve) => (lockOff = resolve));
    let lockOn!: () => void;
    const lockIsOn = new Promise<void>((resolve) => (lockOn = resolve));
    const holdsLock = inMergeDirLock(db, dir, async () => {
      lockOn();
      await lockHeld;
    });
    await lockIsOn;
    let gReleased = false;
    const gRelease = releaseTaskMergeClaims(db, g.taskId).finally(() => {
      gReleased = true;
    });
    await sleep(600);
    check("a cancel's release waits for the dir's lock", !gReleased);
    lockOff();
    await holdsLock;
    await gRelease;
    check('...and releases once the lock is free', (await claimRow(dir)) === undefined);

    // --- a section started after the task is cancelled, or its epoch moved, is refused ---
    const e = await makeTask('smoke E');
    dir = dirs('refused');
    await claimMergeDir(db, owner(e, dir));
    await db
      .update(schema.tasks)
      .set({ orchestrationEpoch: e.epoch + 1 })
      .where(eq(schema.tasks.id, e.taskId));
    ran = false;
    const moved = await withMergeDirSection(db, owner(e, dir), async () => {
      ran = true;
    }).catch(outcome);
    check('a section after the epoch moved is refused', moved === 'superseded' && !ran, moved);
    await setTask(e.taskId, 'cancelled');
    const cancelled = await withMergeDirSection(
      db,
      { ...owner(e, dir), epoch: e.epoch + 1 },
      async () => {
        ran = true;
      },
    ).catch(outcome);
    check(
      'a section after the task is cancelled is refused',
      cancelled === 'superseded' && !ran,
      cancelled,
    );
    const unfenced = await withMergeDirSection(
      db,
      { mergeDir: dir, stepId: e.stepId, taskId: e.taskId },
      async () => {
        ran = true;
      },
    ).catch(outcome);
    check(
      'an unfenced section on a cancelled task is refused',
      unfenced === 'superseded' && !ran,
      unfenced,
    );

    // --- a pass waiting on the dir's lock is refused if the cancel landed meanwhile ---
    const c = await makeTask('smoke C');
    dir = dirs('waiting');
    await claimMergeDir(db, owner(c, dir));
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => (releaseLock = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const lockHolder = inMergeDirLock(db, dir, async () => {
      locked();
      await lockGate;
    });
    await lockTaken;
    let waitingRan = false;
    const waiting = withMergeDirSection(db, owner(c, dir), async () => {
      waitingRan = true;
    }).catch(outcome);
    await sleep(300);
    await db
      .update(schema.tasks)
      .set({ status: 'cancelled', orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1` })
      .where(eq(schema.tasks.id, c.taskId));
    releaseLock();
    await lockHolder;
    check(
      'a section queued on the lock is refused once the cancel landed',
      (await waiting) === 'superseded' && !waitingRan,
      { waitingRan },
    );

    // --- a Retry (step row, then task row) and a section writing its step row do not deadlock ---
    const d = await makeTask('smoke D');
    dir = dirs('retry');
    await claimMergeDir(db, owner(d, dir));
    let retryHoldsStep!: () => void;
    const stepHeld = new Promise<void>((resolve) => (retryHoldsStep = resolve));
    let sectionEntered!: () => void;
    const sectionIn = new Promise<void>((resolve) => (sectionEntered = resolve));
    const section = withMergeDirSection(db, owner(d, dir), async (tx) => {
      sectionEntered();
      await stepHeld;
      await tx
        .update(schema.taskSteps)
        .set({ statusMessage: 'section write' })
        .where(eq(schema.taskSteps.id, d.stepId));
    });
    const retry = (async () => {
      await sectionIn;
      await db.transaction(async (tx) => {
        await tx
          .update(schema.taskSteps)
          .set({ status: 'pending', statusMessage: 'retry write' })
          .where(eq(schema.taskSteps.id, d.stepId));
        retryHoldsStep();
        await sleep(400);
        await tx
          .update(schema.tasks)
          .set({ orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1` })
          .where(eq(schema.tasks.id, d.taskId));
      });
    })();
    const both = await Promise.allSettled([section, retry]);
    const deadlocked = both.some(
      (r) =>
        r.status === 'rejected' &&
        String((r.reason as { code?: unknown })?.code ?? r.reason).includes('40P01'),
    );
    check(
      'a Retry and a section writing its step row both complete, with no deadlock',
      both.every((r) => r.status === 'fulfilled') && !deadlocked,
      both.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok')),
    );

    // --- waiters hold no pooled connection: 12 on one dir with a pool of 10 all complete ---
    const f = await makeTask('smoke F');
    dir = dirs('pool');
    await claimMergeDir(db, owner(f, dir));
    let poolRelease!: () => void;
    const poolGate = new Promise<void>((resolve) => (poolRelease = resolve));
    let holding!: () => void;
    const poolHeld = new Promise<void>((resolve) => (holding = resolve));
    const holder = withMergeDirSection(db, owner(f, dir), async () => {
      holding();
      await poolGate;
      await db.select({ id: schema.users.id }).from(schema.users).limit(1);
    });
    await poolHeld;
    const waiters = Array.from({ length: 11 }, () =>
      withMergeDirSection(db, owner(f, dir), async () => 'ran'),
    );
    waiters.push(claimMergeDir(db, owner(f, dir)).then((c) => c.kind));
    await sleep(500);
    poolRelease();
    const pooled = await Promise.race([
      Promise.allSettled([holder, ...waiters]),
      sleep(20_000).then(() => 'timed out' as const),
    ]);
    check(
      '12 waiters on one dir with a pool of 10 all complete',
      pooled !== 'timed out' && pooled.every((r) => r.status === 'fulfilled'),
      pooled === 'timed out' ? pooled : pooled.map((r) => r.status),
    );
    if (pooled === 'timed out') process.exit(1);
  } catch (err) {
    failures += 1;
    log.error({ err }, 'smoke threw');
  } finally {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    process.exit(failures === 0 ? 0 : 1);
  }
}

void main();

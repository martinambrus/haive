/**
 * The epoch-fenced claim against a database: a claim racing a reset's epoch bump waits for it and
 * is then refused, leaving the row pending. One throwaway user and task, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import {
  StepSupersededError,
  insertOwnedRun,
  openPendingStep,
} from '../src/step-engine/step-ownership.js';

const log = logger.child({ module: 'claim-fence-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const userId = randomUUID();
  const now = new Date();

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'claim-fence-smoke',
      emailBlindIndex: `claim-fence-smoke-${randomBytes(6).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'workflow',
        title: 'claim-fence-smoke',
        status: 'running',
        orchestrationEpoch: 3,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.tasks.id });
    const step = (stepId: string, stepIndex: number) => ({
      taskId: task!.id,
      stepId,
      stepIndex,
      title: stepId,
      status: 'pending' as const,
    });
    const [atEpoch, racing, onFailed] = await db
      .insert(schema.taskSteps)
      .values([step('at-epoch', 0), step('racing', 1), step('on-failed', 2)])
      .returning({ id: schema.taskSteps.id });
    const statusOf = async (id: string) =>
      (
        await db
          .select({ status: schema.taskSteps.status })
          .from(schema.taskSteps)
          .where(eq(schema.taskSteps.id, id))
      )[0]?.status;
    const claimPatch = { status: 'running' as const, startedAt: now };

    const claimed = await openPendingStep(db, task!.id, 3, atEpoch!.id, claimPatch);
    check('a claim at the task epoch lands', claimed?.status === 'running');
    check('the row it claimed reads running', (await statusOf(atEpoch!.id)) === 'running');

    // A reset's bump, held uncommitted the way a Retry's transaction holds it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let bumped!: () => void;
    const bumpWritten = new Promise<void>((resolve) => (bumped = resolve));
    const reset = db.transaction(async (tx) => {
      await tx
        .update(schema.tasks)
        .set({ orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1` })
        .where(eq(schema.tasks.id, task!.id));
      bumped();
      await gate;
    });
    await bumpWritten;
    let settled = false;
    const claim = openPendingStep(db, task!.id, 3, racing!.id, claimPatch).finally(() => {
      settled = true;
    });
    await sleep(500);
    check('the claim waits behind the uncommitted bump', !settled);
    release();
    await reset;
    check('the claim is refused once the bump commits', (await claim) === null);
    check('the refused claim leaves its row pending', (await statusOf(racing!.id)) === 'pending');

    // A pass records a run while a Retry, in its own order, supersedes the step's live run and then
    // resets the row. The record's insert waits on that run's index entry until the Retry commits.
    const [owned] = await db
      .insert(schema.taskSteps)
      .values({ ...step('owned', 3), status: 'running' as const })
      .returning({ id: schema.taskSteps.id });
    const [live] = await db
      .insert(schema.cliInvocations)
      .values({ taskId: task!.id, taskStepId: owned!.id, mode: 'cli', prompt: 'live' })
      .returning({ id: schema.cliInvocations.id });
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => (releaseRetry = resolve));
    let supersededLive!: () => void;
    const supersedeWritten = new Promise<void>((resolve) => (supersededLive = resolve));
    const outcome = (err: unknown) => {
      const e = err as { code?: string; cause?: { code?: string } };
      return `error: ${e.cause?.code ?? e.code ?? String(err)}`;
    };
    const retry = db
      .transaction(async (tx) => {
        await tx
          .update(schema.cliInvocations)
          .set({ supersededAt: new Date() })
          .where(eq(schema.cliInvocations.id, live!.id));
        supersededLive();
        await retryGate;
        await tx
          .update(schema.taskSteps)
          .set({ status: 'pending' })
          .where(eq(schema.taskSteps.id, owned!.id));
      })
      .then(() => 'committed', outcome);
    await supersedeWritten;
    const recorded = insertOwnedRun(db, owned!.id, {
      taskId: task!.id,
      taskStepId: owned!.id,
      mode: 'cli',
      prompt: 'late',
    }).then(
      () => 'recorded',
      (err: unknown) => (err instanceof StepSupersededError ? 'refused' : outcome(err)),
    );
    await sleep(500);
    releaseRetry();
    const retried = await retry;
    check('a Retry beside a pass recording a run commits', retried === 'committed', retried);
    const record = await recorded;
    check('the pass whose row the Retry took records no run', record === 'refused', record);
    const runsLeft = await db
      .select({ id: schema.cliInvocations.id })
      .from(schema.cliInvocations)
      .where(eq(schema.cliInvocations.taskStepId, owned!.id));
    check(
      'only the superseded run is left on the row',
      runsLeft.length === 1 && runsLeft[0]!.id === live!.id,
      runsLeft,
    );

    // A Stop fails the task without moving the epoch.
    await db.update(schema.tasks).set({ status: 'failed' }).where(eq(schema.tasks.id, task!.id));
    const stopped = await openPendingStep(db, task!.id, 4, onFailed!.id, claimPatch);
    check('a claim on a failed task is refused', stopped === null);
    check('that row stays pending', (await statusOf(onFailed!.id)) === 'pending');
  } finally {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  }
}

main()
  .then(() => {
    log.info({ checks, failures }, failures === 0 ? 'claim fence smoke passed' : 'FAILED');
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    log.error({ err }, 'claim fence smoke crashed');
    process.exit(1);
  });

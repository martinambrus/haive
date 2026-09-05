/**
 * Re-advance a plan-sequence step that died between apply() and its end-of-pass
 * review, WITHOUT throwing away the agents that already answered.
 *
 * The step's own fan-out is the expensive thing in a plan build — up to
 * SEQUENCE_AGENTS_PER_PASS runs, hours of wall clock — and both UI recoveries
 * spend it again: Retry calls resetRowsForRerun, which DELETES every
 * task_step_agent_minings row, and Resume refuses a step with no failed agent
 * and no iterations ("Resume is only available for a multi-iteration step").
 * So a step whose agents all SUCCEEDED and then hit a bug on the way to the
 * review form has no cheap way back. This is that way back: clear the cached
 * detect/form so advanceStep recomputes them, and hand the step to the worker.
 *
 * Safe to re-run. The guard is the step's own status, not the error text — a
 * message column is display copy and outlives what it describes, so keying on
 * it would make this fire on a step it should not touch. A step that is not
 * `failed` is left exactly as it is.
 *
 * Usage (run inside the worker container):
 *   docker exec haive-worker pnpm --filter @haive/worker exec \
 *     tsx scripts/resume-plan-sequence-review.ts <taskId>
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDatabase, schema } from '@haive/database';
import { QUEUE_NAMES, TASK_JOB_NAMES, type TaskJobPayload } from '@haive/shared';

/** Both ids the one step definition is registered under — plan_build's and the
 *  standalone plan_sequence workflow's. A literal here would silently match
 *  nothing for whichever one it is not. */
const SEQUENCE_STEP_IDS = ['03-plan-sequence', '00-plan-sequence'];

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error('usage: tsx scripts/resume-plan-sequence-review.ts <taskId>');
    process.exit(1);
  }

  const db = createDatabase(process.env.DATABASE_URL!);

  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
  if (!task) {
    console.error(`no such task: ${taskId}`);
    process.exit(1);
  }

  const steps = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(eq(schema.taskSteps.taskId, taskId), inArray(schema.taskSteps.stepId, SEQUENCE_STEP_IDS)),
    );
  const step = steps[0];
  if (!step) {
    console.error(`task ${taskId} has no plan-sequence step`);
    process.exit(1);
  }
  if (step.status !== 'failed') {
    console.log(`nothing to do: ${step.stepId} is ${step.status}, not failed`);
    process.exit(0);
  }

  const minings = await db
    .select({ status: schema.taskStepAgentMinings.status })
    .from(schema.taskStepAgentMinings)
    .where(eq(schema.taskStepAgentMinings.taskStepId, step.id));
  const live = minings.filter((m) => m.status === 'pending' || m.status === 'running').length;
  const done = minings.filter((m) => m.status === 'done').length;
  if (live > 0) {
    console.error(`${live} agent(s) still pending/running — let the fan-out finish first`);
    process.exit(1);
  }
  if (done === 0) {
    console.error('no agent answers to preserve — use the step Retry button instead');
    process.exit(1);
  }

  const now = new Date();
  let epoch = task.orchestrationEpoch;
  await db.transaction(async (tx) => {
    // Clearing detectOutput + formSchema is the whole point: advanceStep reuses
    // both when they are set, and the review form only exists once detect() has
    // re-read the agents' answers. formValues goes with them — the stored one is
    // the answer to the BUDGET form, and it would be replayed against the review
    // schema that replaces it.
    await tx
      .update(schema.taskSteps)
      .set({
        status: 'pending',
        detectOutput: null,
        formSchema: null,
        formValues: null,
        statusMessage: null,
        errorMessage: null,
        errorHint: null,
        endedAt: null,
        updatedAt: now,
      })
      .where(eq(schema.taskSteps.id, step.id));
    const bumped = await tx
      .update(schema.tasks)
      .set({
        status: 'running',
        errorMessage: null,
        // A failure stamped this; leaving it set freezes the task-level UI timers.
        completedAt: null,
        currentStepId: step.stepId,
        currentStepIndex: step.runSeq ?? step.stepIndex,
        orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1`,
        updatedAt: now,
      })
      .where(eq(schema.tasks.id, taskId))
      .returning({ epoch: schema.tasks.orchestrationEpoch });
    epoch = bumped[0]?.epoch ?? epoch;
    await tx.insert(schema.taskEvents).values({
      taskId,
      taskStepId: step.id,
      eventType: 'step.resume',
      payload: { stepId: step.stepId, round: step.round, preservedAgents: done, source: 'script' },
    });
  });

  const connection = new IORedis(process.env.REDIS_URL ?? 'redis://redis:6379', {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(QUEUE_NAMES.TASK, { connection });
  await queue.add(
    TASK_JOB_NAMES.ADVANCE_STEP,
    {
      taskId,
      userId: task.userId,
      stepId: step.stepId,
      round: step.round,
      epoch,
    } satisfies TaskJobPayload,
    { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100 },
  );
  await queue.close();
  await connection.quit();

  console.log(`re-advanced ${step.stepId} at epoch ${epoch}, keeping ${done} agent answer(s)`);
  process.exit(0);
}

void main();

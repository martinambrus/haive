/**
 * Integration smoke for the allowance auto-resume against a real Postgres.
 *
 * `autoResumeFailedStep` is what the usage poller calls when a provider that failed
 * a task comes back. Its whole promise is RESUME rather than reset — keep what
 * finished, redo only what the outage killed — and every part of that promise is a
 * SQL predicate, so nothing but a real database can check it: which invocation rows
 * the supersede sweep touches (superseded ones vanish from the api's per-step panel
 * and from every cost rollup), and which mining rows come back marked for the
 * fan-out barrier's user-requested arm.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { autoResumeFailedStep } from '../src/queues/_step-reset.js';
import { PROVIDER_FATAL_HEADLINES } from '../src/queues/cli-exec/failure-class.js';

const log = logger.child({ module: 'auto-resume-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}

const failures: string[] = [];

function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    log.info({ label }, 'ok');
    return;
  }
  failures.push(label);
  log.error({ label, detail }, 'FAILED');
}

interface State {
  userId?: string;
  outageTaskId?: string;
  goodOutputTaskId?: string;
}
const state: State = {};

// The message a rate-limited agent row actually carries, built from the shared headline
// rather than a copy of today's wording — the same string isFatalProviderFailure keys on.
const RATE_LIMIT_MESSAGE = `${PROVIDER_FATAL_HEADLINES.rate_limit} — the provider's usage limit or quota is exhausted; retry this task once it resets.`;
// A failure that has nothing to do with the outage. Taken from a real armed task, where 39 of
// the 47 dead terminals looked like this and only 8 were the rate limit.
const OVERSIZED_PROMPT_MESSAGE =
  'Reading prompt from stdin...\nError: turn/start: turn/start failed: Input exceeds the maximum length of 1048576';

async function seedTask(
  db: ReturnType<typeof getDb>,
  userId: string,
  stepId: string,
): Promise<{ taskId: string; taskStepId: string }> {
  const taskId = randomUUID();
  await db.insert(schema.tasks).values({
    id: taskId,
    userId,
    type: 'plan_build',
    title: 'auto-resume smoke',
    status: 'failed',
    currentStepId: stepId,
    currentRound: 0,
    completedAt: new Date(),
    errorMessage: RATE_LIMIT_MESSAGE,
    awaitingAllowanceProviderId: null,
    awaitingProviderReason: 'rate_limit',
    awaitingProviderSince: new Date(),
  });
  const taskStepId = randomUUID();
  await db.insert(schema.taskSteps).values({
    id: taskStepId,
    taskId,
    stepId,
    stepIndex: 2,
    round: 0,
    title: 'Plan coverage',
    status: 'failed',
    output: { kept: 'output from the passes that finished' },
    iterations: [{ iteration: 0 }],
    iterationCount: 1,
    detectOutput: { kept: 'detect' },
    errorMessage: RATE_LIMIT_MESSAGE,
    endedAt: new Date(),
  });
  return { taskId, taskStepId };
}

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();

  const userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    emailEncrypted: 'auto-resume-smoke@test.local',
    emailBlindIndex: `auto-resume-${randomBytes(4).toString('hex')}`,
    passwordHash: 'smoke-not-real',
    role: 'user',
    status: 'active',
    tokenVersion: 0,
  });
  state.userId = userId;

  /* ---------------- Scenario 1: a fan-out step killed by the outage ---------------- */

  const outage = await seedTask(db, userId, '02-plan-coverage');
  state.outageTaskId = outage.taskId;

  // Two mining terminals that FINISHED and one that died on the outage, each with the
  // invocation row the task panel and the cost rollups read.
  const doneInvocationId = randomUUID();
  const failedInvocationId = randomUUID();
  const blockerInvocationId = randomUUID();
  await db.insert(schema.cliInvocations).values([
    {
      id: doneInvocationId,
      taskId: outage.taskId,
      taskStepId: outage.taskStepId,
      mode: 'agent_mining',
      prompt: 'expand node A',
      exitCode: 0,
      endedAt: new Date(),
      createdAt: new Date(Date.now() - 3 * 60_000),
    },
    {
      id: failedInvocationId,
      taskId: outage.taskId,
      taskStepId: outage.taskStepId,
      mode: 'agent_mining',
      prompt: 'expand node B',
      exitCode: 1,
      errorMessage: RATE_LIMIT_MESSAGE,
      endedAt: new Date(),
      createdAt: new Date(Date.now() - 2 * 60_000),
    },
    // The step's own trailing non-mining run, failed: this is the one blocker resolveLlmPhase
    // would otherwise replay, and the only row the supersede may touch.
    {
      id: blockerInvocationId,
      taskId: outage.taskId,
      taskStepId: outage.taskStepId,
      mode: 'cli',
      prompt: 'coverage scan',
      exitCode: 1,
      errorMessage: RATE_LIMIT_MESSAGE,
      endedAt: new Date(),
      createdAt: new Date(Date.now() - 60_000),
    },
  ]);

  const doneAgentId = randomUUID();
  const outageAgentId = randomUUID();
  const otherFailureAgentId = randomUUID();
  await db.insert(schema.taskStepAgentMinings).values([
    {
      id: doneAgentId,
      taskStepId: outage.taskStepId,
      agentId: 'plan-expand-done',
      status: 'done',
      cliInvocationId: doneInvocationId,
      output: { nodes: 3 },
    },
    {
      id: outageAgentId,
      taskStepId: outage.taskStepId,
      agentId: 'plan-expand-rate-limited',
      status: 'failed',
      cliInvocationId: failedInvocationId,
      errorMessage: RATE_LIMIT_MESSAGE,
    },
    {
      id: otherFailureAgentId,
      taskStepId: outage.taskStepId,
      agentId: 'plan-expand-oversized',
      status: 'failed',
      errorMessage: OVERSIZED_PROMPT_MESSAGE,
    },
  ]);

  const resumed = await autoResumeFailedStep(db, {
    taskId: outage.taskId,
    stepId: '02-plan-coverage',
    round: 0,
    providerId: null,
    via: 'smoke',
  });
  check('a failed task is auto-resumed', resumed === true, resumed);

  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, outage.taskId));
  check('task flips back to running', task?.status === 'running', task?.status);
  check(
    'the anti-thrash counter climbs',
    task?.allowanceAutoResumeCount === 1,
    task?.allowanceAutoResumeCount,
  );
  check('the auto-resumed marker is stamped', task?.allowanceAutoResumedAt != null);
  check(
    'the watch is cleared',
    task?.awaitingProviderReason === null,
    task?.awaitingProviderReason,
  );
  check('the stale completedAt is cleared', task?.completedAt === null, task?.completedAt);

  const [step] = await db
    .select()
    .from(schema.taskSteps)
    .where(eq(schema.taskSteps.id, outage.taskStepId));
  check('step flips back to running', step?.status === 'running', step?.status);
  check('the failed pass output is KEPT', step?.output != null, step?.output);
  check('the iteration count is KEPT', step?.iterationCount === 1, step?.iterationCount);
  check('detect is KEPT (resume, not reset)', step?.detectOutput != null, step?.detectOutput);

  const invocations = await db
    .select()
    .from(schema.cliInvocations)
    .where(eq(schema.cliInvocations.taskStepId, outage.taskStepId));
  const byId = new Map(invocations.map((i) => [i.id, i]));
  check(
    'the terminal that SUCCEEDED stays visible',
    byId.get(doneInvocationId)?.supersededAt == null,
    byId.get(doneInvocationId)?.supersededAt,
  );
  check(
    'the terminal that failed stays visible too',
    byId.get(failedInvocationId)?.supersededAt == null,
    byId.get(failedInvocationId)?.supersededAt,
  );
  check(
    'the failed non-mining blocker IS superseded',
    byId.get(blockerInvocationId)?.supersededAt != null,
  );

  const minings = await db
    .select()
    .from(schema.taskStepAgentMinings)
    .where(eq(schema.taskStepAgentMinings.taskStepId, outage.taskStepId));
  const agentById = new Map(minings.map((m) => [m.id, m]));
  check(
    'the outage terminal is marked for re-dispatch',
    agentById.get(outageAgentId)?.userRetryRequestedAt != null,
  );
  check(
    'a failure that was NOT the outage is left alone',
    agentById.get(otherFailureAgentId)?.userRetryRequestedAt == null,
    agentById.get(otherFailureAgentId)?.userRetryRequestedAt,
  );
  check(
    'a terminal that finished is never re-dispatched',
    agentById.get(doneAgentId)?.userRetryRequestedAt == null &&
      agentById.get(doneAgentId)?.status === 'done',
  );

  // Second call: the task is no longer `failed`, so the guarded flip must match no row —
  // the same no-op a concurrent MANUAL resume produces.
  const again = await autoResumeFailedStep(db, {
    taskId: outage.taskId,
    stepId: '02-plan-coverage',
    round: 0,
    providerId: null,
    via: 'smoke',
  });
  const [taskAfter] = await db
    .select({ count: schema.tasks.allowanceAutoResumeCount })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, outage.taskId));
  check('a task that is no longer failed is a no-op', again === false, again);
  check('the no-op writes nothing', taskAfter?.count === 1, taskAfter?.count);

  /* -------- Scenario 2: a step whose llm SUCCEEDED and whose fan-out then died -------- */
  // 03-phase-0a-discovery and 09_5-skill-generation own both an llm and a fan-out, so the
  // trailing non-mining invocation can be a run that worked. Superseding it would discard
  // good output and buy a fresh CLI call for nothing.

  const goodOutput = await seedTask(db, userId, '03-phase-0a-discovery');
  state.goodOutputTaskId = goodOutput.taskId;
  const goodLlmInvocationId = randomUUID();
  await db.insert(schema.cliInvocations).values({
    id: goodLlmInvocationId,
    taskId: goodOutput.taskId,
    taskStepId: goodOutput.taskStepId,
    mode: 'cli',
    prompt: 'discovery',
    exitCode: 0,
    endedAt: new Date(),
    createdAt: new Date(Date.now() - 60_000),
  });

  const resumedGood = await autoResumeFailedStep(db, {
    taskId: goodOutput.taskId,
    stepId: '03-phase-0a-discovery',
    round: 0,
    providerId: null,
    via: 'smoke',
  });
  check('the second task resumes too', resumedGood === true, resumedGood);
  const [goodInvocation] = await db
    .select({ supersededAt: schema.cliInvocations.supersededAt })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.id, goodLlmInvocationId),
        eq(schema.cliInvocations.taskStepId, goodOutput.taskStepId),
      ),
    );
  check(
    'an llm run that SUCCEEDED is never superseded',
    goodInvocation?.supersededAt == null,
    goodInvocation?.supersededAt,
  );
}

main()
  .then(() => {
    if (failures.length > 0) {
      log.error({ failures }, `[smoke] ${failures.length} check(s) failed`);
      process.exitCode = 1;
      return;
    }
    log.info('[smoke] auto-resume smoke passed');
  })
  .catch((err) => {
    log.error({ err }, '[smoke] auto-resume smoke threw');
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const db = getDb();
      // task_steps, cli_invocations and the mining rows all cascade from the task row.
      for (const id of [state.outageTaskId, state.goodOutputTaskId]) {
        if (id) await db.delete(schema.tasks).where(eq(schema.tasks.id, id));
      }
      if (state.userId) await db.delete(schema.users).where(eq(schema.users.id, state.userId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'db cleanup failed');
    }
    process.exit(process.exitCode ?? 0);
  });

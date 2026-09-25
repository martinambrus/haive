import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, secretsService, userSecretsService, logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { closeQueues, getTaskQueue } from '../src/queues.js';
import { createApiApp } from '../src/index.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';

const log = logger.child({ module: 'step-retry-skip-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

interface State {
  userId?: string;
  taskId?: string;
  stepIds?: string[];
  paused?: boolean;
}

function assertStatus(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected status ${expected}, got ${actual}`);
  }
}

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  try {
    log.info('bootstrapping');
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);

    // Every action below enqueues a real advance-step job. Against a live stack a running
    // worker picks it up within milliseconds, fails the throwaway task (no repo, no real
    // step) and the assertions below race it. Pause the queue for the duration; the jobs
    // are dropped and the queue resumed in the finally block.
    await getTaskQueue().pause();
    state.paused = true;
    log.info('task queue paused for the smoke');

    const app = createApiApp('http://localhost:3000');

    const userId = randomUUID();
    state.userId = userId;
    const now = new Date();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'retry-smoke@test.local',
      emailBlindIndex: `retry-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const token = await signAccessToken({ sub: userId, role: 'user', tv: 0 });
    const cookie = `${ACCESS_COOKIE}=${token}`;

    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'workflow',
        title: 'retry skip smoke',
        status: 'failed',
        errorMessage: 'simulated failure',
      })
      .returning();
    if (!task) throw new Error('task insert failed');
    state.taskId = task.id;

    const [failedStep, middleStep, lastStep] = await db
      .insert(schema.taskSteps)
      .values([
        {
          taskId: task.id,
          // A REAL id from SKIPPABLE_STEP_IDS: part 2 below exercises the Skip action, and
          // the api refuses it on any step whose StepDefinition does not set allowSkip. The
          // fake id this used to carry made that half 409 from the day the allow-list landed.
          stepId: '03b-business-requirements',
          stepIndex: 0,
          title: 'Failing step',
          status: 'failed',
          errorMessage: 'kaboom',
          endedAt: now,
        },
        {
          taskId: task.id,
          stepId: 'middle-step',
          stepIndex: 1,
          title: 'Middle step',
          status: 'pending',
        },
        {
          taskId: task.id,
          stepId: 'last-step',
          stepIndex: 2,
          title: 'Last step',
          // A downstream loop step that already ran. Retrying an upstream step
          // must clear its loop counter/iterations, not carry them forward.
          status: 'done',
          iterationCount: 3,
          iterations: [
            {
              iteration: 0,
              llmOutput: null,
              applyOutput: { source: 'stub' },
              continueRequested: true,
              recordedAt: now.toISOString(),
            },
            {
              iteration: 1,
              llmOutput: null,
              applyOutput: { source: 'stub' },
              continueRequested: true,
              recordedAt: now.toISOString(),
            },
            {
              iteration: 2,
              llmOutput: null,
              applyOutput: { source: 'stub' },
              continueRequested: true,
              recordedAt: now.toISOString(),
            },
          ],
          endedAt: now,
        },
      ])
      .returning();
    if (!failedStep || !middleStep || !lastStep) throw new Error('step insert failed');
    state.stepIds = [failedStep.id, middleStep.id, lastStep.id];

    // 1. Retry the failed step
    await db.update(schema.tasks).set({ currentRound: 1 }).where(eq(schema.tasks.id, task.id));
    const retryRes = await app.request(`/tasks/${task.id}/steps/03b-business-requirements/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry', note: 'manual retry' }),
    });
    assertStatus('POST /retry', retryRes.status, 200);

    const afterRetry = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, failedStep.id),
    });
    if (!afterRetry) throw new Error('failed step vanished after retry');
    if (afterRetry.status !== 'pending') {
      throw new Error(`expected retry to reset step to pending, got ${afterRetry.status}`);
    }
    if (afterRetry.errorMessage !== null) {
      throw new Error('retry should clear errorMessage');
    }

    const taskAfterRetry = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, task.id),
    });
    if (taskAfterRetry?.status !== 'running') {
      throw new Error(`expected task running after retry, got ${taskAfterRetry?.status}`);
    }
    if (taskAfterRetry.currentStepId !== '03b-business-requirements') {
      throw new Error(
        `expected currentStepId=03b-business-requirements, got ${taskAfterRetry.currentStepId}`,
      );
    }
    if (taskAfterRetry.currentRound !== 0) {
      throw new Error(
        `expected currentRound=0 for the retried row, got ${taskAfterRetry.currentRound}`,
      );
    }

    // Retrying an upstream step must reset downstream loop state, not carry it
    // forward. last-step ran 3 loop passes; after the cascade it must be a clean
    // pending step (iterationCount 0, empty iterations) so its loop starts fresh.
    const lastAfterRetry = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, lastStep.id),
    });
    if (lastAfterRetry?.status !== 'pending') {
      throw new Error(`expected downstream reset to pending, got ${lastAfterRetry?.status}`);
    }
    if (lastAfterRetry.iterationCount !== 0) {
      throw new Error(`expected downstream iterationCount 0, got ${lastAfterRetry.iterationCount}`);
    }
    if (lastAfterRetry.iterations.length !== 0) {
      throw new Error(
        `expected downstream iterations cleared, got ${lastAfterRetry.iterations.length}`,
      );
    }

    // 1b. A retry leaves no other row active. A later round's step still parked on its CLI is
    //     work the task has left: kept active, the worker's other-step guard refuses every
    //     advance the retry queues and the task stops with nothing running.
    const [laterRound] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task.id,
        stepId: 'later-round-step',
        stepIndex: 3,
        round: 1,
        title: 'Later round',
        status: 'waiting_cli',
        startedAt: now,
      })
      .returning();
    if (!laterRound) throw new Error('later-round step insert failed');
    const [liveRun] = await db
      .insert(schema.cliInvocations)
      .values({ taskId: task.id, taskStepId: laterRound.id, mode: 'cli', prompt: 'smoke' })
      .returning();
    if (!liveRun) throw new Error('live invocation insert failed');
    const retryAgain = await app.request(
      `/tasks/${task.id}/steps/03b-business-requirements/action`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'retry', round: 0 }),
      },
    );
    assertStatus('POST /retry with a later round active', retryAgain.status, 200);
    const laterAfter = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, laterRound.id),
    });
    if (laterAfter?.status !== 'pending') {
      throw new Error(
        `expected the later round's step reset to pending, got ${laterAfter?.status}`,
      );
    }
    const runAfter = await db.query.cliInvocations.findFirst({
      where: eq(schema.cliInvocations.id, liveRun.id),
    });
    if (!runAfter?.supersededAt) {
      throw new Error("expected the later round's live invocation superseded");
    }

    // 1c. Re-running a fan-out's failed agents moves the task the same way, so it too leaves no
    //     other row active.
    await db
      .update(schema.taskSteps)
      .set({ status: 'failed', errorMessage: 'one agent failed', endedAt: now })
      .where(eq(schema.taskSteps.id, failedStep.id));
    await db
      .insert(schema.taskStepAgentMinings)
      .values({ taskStepId: failedStep.id, agentId: 'smoke-reviewer', status: 'failed' });
    await db
      .update(schema.taskSteps)
      .set({ status: 'waiting_cli' })
      .where(eq(schema.taskSteps.id, laterRound.id));
    const [secondRun] = await db
      .insert(schema.cliInvocations)
      .values({ taskId: task.id, taskStepId: laterRound.id, mode: 'cli', prompt: 'smoke' })
      .returning();
    if (!secondRun) throw new Error('second live invocation insert failed');
    const resumeRes = await app.request(
      `/tasks/${task.id}/steps/03b-business-requirements/action`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resume', round: 0 }),
      },
    );
    assertStatus('POST /resume with a later round active', resumeRes.status, 200);
    const laterAfterResume = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, laterRound.id),
    });
    if (laterAfterResume?.status !== 'pending') {
      throw new Error(
        `expected resume to reset the later round's step to pending, got ${laterAfterResume?.status}`,
      );
    }
    const secondAfter = await db.query.cliInvocations.findFirst({
      where: eq(schema.cliInvocations.id, secondRun.id),
    });
    if (!secondAfter?.supersededAt) {
      throw new Error("expected resume to supersede the later round's live invocation");
    }
    const taskAfterFanoutResume = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, task.id),
    });
    if (taskAfterFanoutResume?.currentRound !== 0) {
      throw new Error(
        `expected currentRound=0 for the resumed row, got ${taskAfterFanoutResume?.currentRound}`,
      );
    }

    // Every other action that moves the task back to a step resets what it leaves active in the
    // same way, and queues its advance at the epoch it moved the task to.
    const leaveLaterRoundActive = async () => {
      await db
        .update(schema.taskSteps)
        .set({ status: 'waiting_cli' })
        .where(eq(schema.taskSteps.id, laterRound.id));
      const [run] = await db
        .insert(schema.cliInvocations)
        .values({ taskId: task.id, taskStepId: laterRound.id, mode: 'cli', prompt: 'smoke' })
        .returning();
      if (!run) throw new Error('live invocation insert failed');
      return run;
    };
    const taskEpoch = async () =>
      (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, task.id) }))!.orchestrationEpoch;
    const queuedEpochs = async (forStepId: string) =>
      (await getTaskQueue().getJobs(['wait', 'prioritized', 'delayed']))
        .map((j) => j.data as { taskId?: string; stepId?: string; epoch?: number })
        .filter((d) => d.taskId === task.id && d.stepId === forStepId)
        .map((d) => d.epoch);
    const assertMovedTask = async (label: string, run: { id: string }, epochBefore: number) => {
      const later = await db.query.taskSteps.findFirst({
        where: eq(schema.taskSteps.id, laterRound.id),
      });
      if (later?.status !== 'pending') {
        throw new Error(`${label}: expected the later round's step reset, got ${later?.status}`);
      }
      const runAfterAction = await db.query.cliInvocations.findFirst({
        where: eq(schema.cliInvocations.id, run.id),
      });
      if (!runAfterAction?.supersededAt) {
        throw new Error(`${label}: expected the later round's live invocation superseded`);
      }
      const epochAfter = await taskEpoch();
      if (epochAfter !== epochBefore + 1) {
        throw new Error(
          `${label}: expected the epoch bumped once, ${epochBefore} -> ${epochAfter}`,
        );
      }
      return epochAfter;
    };
    // Exactly once: the pre-bump reset and the post-bump sweep must not both report one row.
    const leftActiveOnce = (payload: unknown, stepId: string): boolean =>
      (
        (payload as { leftActive?: { stepId?: string; round?: number }[] } | null)?.leftActive ?? []
      ).filter((r) => r.stepId === stepId).length === 1;

    // 1d. A loop step resumed from its failed pass.
    const [loopStep] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task.id,
        stepId: 'loop-step',
        stepIndex: 4,
        title: 'Loop step',
        status: 'failed',
        iterationCount: 1,
        endedAt: now,
      })
      .returning();
    if (!loopStep) throw new Error('loop step insert failed');

    // Resume it from round 0, keeping its completed iteration. Moves the task the same
    // way retry does: what it leaves active elsewhere is reset, and the epoch bumps once.
    await db.update(schema.tasks).set({ currentRound: 1 }).where(eq(schema.tasks.id, task.id));
    const epochBefore1d = await taskEpoch();
    const run1d = await leaveLaterRoundActive();
    const resumeLoopRes = await app.request(`/tasks/${task.id}/steps/loop-step/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume', round: 0 }),
    });
    assertStatus('POST /resume on loop-step', resumeLoopRes.status, 200);
    const epochAfter1d = await assertMovedTask('resume loop-step', run1d, epochBefore1d);
    const loopAfterResume = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, loopStep.id),
    });
    if (loopAfterResume?.status !== 'running') {
      throw new Error(`expected loop-step running after resume, got ${loopAfterResume?.status}`);
    }
    const taskAfter1d = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, task.id) });
    if (taskAfter1d?.currentRound !== 0) {
      throw new Error(`expected currentRound=0 for loop-step, got ${taskAfter1d?.currentRound}`);
    }
    if (taskAfter1d?.currentStepId !== 'loop-step') {
      throw new Error(`expected currentStepId=loop-step, got ${taskAfter1d?.currentStepId}`);
    }
    const loopEpochs1d = await queuedEpochs('loop-step');
    if (!loopEpochs1d.includes(epochAfter1d)) {
      throw new Error(
        `expected a queued job for loop-step carrying epoch ${epochAfter1d}, got ${JSON.stringify(loopEpochs1d)}`,
      );
    }
    const resumeLoopEvents = await db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, task.id));
    const resumeLoopEvent = resumeLoopEvents.find((e) => {
      if (e.eventType !== 'step.resume') return false;
      const payload = e.payload as { fromIteration?: number };
      return payload.fromIteration !== undefined && leftActiveOnce(e.payload, 'later-round-step');
    });
    if (!resumeLoopEvent) {
      throw new Error('expected a step.resume event with fromIteration listing later-round-step');
    }

    // 1e. retry_ai on the same loop step from a fresh failure: same reset shape, a
    //     different event type.
    await db
      .update(schema.taskSteps)
      .set({ status: 'failed', errorMessage: 'loop kaboom again' })
      .where(eq(schema.taskSteps.id, loopStep.id));
    const epochBefore1e = await taskEpoch();
    const run1e = await leaveLaterRoundActive();
    const retryAiRes = await app.request(`/tasks/${task.id}/steps/loop-step/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry_ai', round: 0 }),
    });
    assertStatus('POST /retry_ai on loop-step', retryAiRes.status, 200);
    const epochAfter1e = await assertMovedTask('retry_ai loop-step', run1e, epochBefore1e);
    const loopAfterRetryAi = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, loopStep.id),
    });
    if (loopAfterRetryAi?.status !== 'running') {
      throw new Error(`expected loop-step running after retry_ai, got ${loopAfterRetryAi?.status}`);
    }
    const loopEpochs1e = await queuedEpochs('loop-step');
    if (!loopEpochs1e.includes(epochAfter1e)) {
      throw new Error(
        `expected a queued job for loop-step carrying epoch ${epochAfter1e}, got ${JSON.stringify(loopEpochs1e)}`,
      );
    }
    const retryAiEvents = await db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, task.id));
    const retryAiEvent = retryAiEvents.find(
      (e) => e.eventType === 'step.retry_ai' && leftActiveOnce(e.payload, 'later-round-step'),
    );
    if (!retryAiEvent) {
      throw new Error('expected a step.retry_ai event listing later-round-step in leftActive');
    }

    // 1f. A loop Resume or retry_ai must not revive a task that has already ended.
    await db
      .update(schema.taskSteps)
      .set({ status: 'failed', errorMessage: 'loop kaboom once more' })
      .where(eq(schema.taskSteps.id, loopStep.id));
    await db.update(schema.tasks).set({ status: 'cancelled' }).where(eq(schema.tasks.id, task.id));
    const epochBefore1f = await taskEpoch();
    const resumeOnEndedRes = await app.request(`/tasks/${task.id}/steps/loop-step/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume', round: 0 }),
    });
    assertStatus('POST /resume on a cancelled task', resumeOnEndedRes.status, 409);
    const taskAfterResumeOnEnded = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, task.id),
    });
    if (taskAfterResumeOnEnded?.status !== 'cancelled') {
      throw new Error(`expected the task to stay cancelled, got ${taskAfterResumeOnEnded?.status}`);
    }
    const loopAfterResumeOnEnded = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, loopStep.id),
    });
    if (loopAfterResumeOnEnded?.status !== 'failed') {
      throw new Error(`expected loop-step to stay failed, got ${loopAfterResumeOnEnded?.status}`);
    }
    if ((await taskEpoch()) !== epochBefore1f) {
      throw new Error('expected the epoch unchanged after resume on a cancelled task');
    }

    const retryAiOnEndedRes = await app.request(`/tasks/${task.id}/steps/loop-step/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry_ai', round: 0 }),
    });
    assertStatus('POST /retry_ai on a cancelled task', retryAiOnEndedRes.status, 409);
    const taskAfterRetryAiOnEnded = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, task.id),
    });
    if (taskAfterRetryAiOnEnded?.status !== 'cancelled') {
      throw new Error(
        `expected the task to stay cancelled, got ${taskAfterRetryAiOnEnded?.status}`,
      );
    }
    const loopAfterRetryAiOnEnded = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, loopStep.id),
    });
    if (loopAfterRetryAiOnEnded?.status !== 'failed') {
      throw new Error(`expected loop-step to stay failed, got ${loopAfterRetryAiOnEnded?.status}`);
    }
    if ((await taskEpoch()) !== epochBefore1f) {
      throw new Error('expected the epoch unchanged after retry_ai on a cancelled task');
    }

    // Restore for the scenarios that follow.
    await db.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, task.id));

    // 2. Mark 03b-business-requirements failed again, then skip it
    await db
      .update(schema.taskSteps)
      .set({ status: 'failed', errorMessage: 'kaboom again' })
      .where(eq(schema.taskSteps.id, failedStep.id));

    const epochBefore2 = await taskEpoch();
    const run2 = await leaveLaterRoundActive();
    const skipRes = await app.request(`/tasks/${task.id}/steps/03b-business-requirements/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'skip', note: 'skip during smoke' }),
    });
    assertStatus('POST /skip', skipRes.status, 200);
    const skipBody = (await skipRes.json()) as { status: string; nextStepId: string | null };
    if (skipBody.status !== 'skipped') throw new Error(`expected skipped, got ${skipBody.status}`);
    // nextStepId is always null now: the api cannot see unmaterialized future steps, so it
    // enqueues an advance for the SKIPPED step and lets the worker pick the next one off the
    // registry run list. This used to expect the api to compute it.
    if (skipBody.nextStepId !== null) {
      throw new Error(`expected next=null (worker computes it), got ${skipBody.nextStepId}`);
    }

    const afterSkip = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, failedStep.id),
    });
    if (afterSkip?.status !== 'skipped') {
      throw new Error(`expected step skipped, got ${afterSkip?.status}`);
    }

    const taskAfterSkip = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, task.id),
    });
    // Skip hands the task back to the worker, so the api only puts it back in `running` and
    // clears the failure — advancing currentStepId is the worker's job (no worker here).
    if (taskAfterSkip?.status !== 'running') {
      throw new Error(`expected task running after skip, got ${taskAfterSkip?.status}`);
    }
    if (taskAfterSkip.errorMessage !== null) {
      throw new Error('skip should clear the task errorMessage');
    }
    const epochAfter2 = await assertMovedTask('skip 03b-business-requirements', run2, epochBefore2);
    const skipEpochs = await queuedEpochs('03b-business-requirements');
    if (!skipEpochs.includes(epochAfter2)) {
      throw new Error(
        `expected a queued job for 03b-business-requirements carrying epoch ${epochAfter2}, got ${JSON.stringify(skipEpochs)}`,
      );
    }
    const skipLeftActiveEvent = (
      await db.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, task.id))
    ).find((e) => e.eventType === 'step.skip' && leftActiveOnce(e.payload, 'later-round-step'));
    if (!skipLeftActiveEvent) {
      throw new Error('expected a step.skip event listing later-round-step in leftActive');
    }

    // 3. Retry is allowed on any status by design (see steps.ts: "Any status is
    //    retryable"). Retrying a pending step is a no-op-shaped reset back to
    //    pending, not a 409.
    const retryPending = await app.request(`/tasks/${task.id}/steps/middle-step/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    });
    assertStatus('POST /retry on pending', retryPending.status, 200);

    // 4. Unknown action rejected at schema level
    const badAction = await app.request(`/tasks/${task.id}/steps/middle-step/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'restart' }),
    });
    if (badAction.status < 400) {
      throw new Error(`expected 4xx for unknown action, got ${badAction.status}`);
    }

    // 6. A CLI switch on a failed step moves the task exactly like retry/resume/skip do.
    await db
      .update(schema.taskSteps)
      .set({ status: 'failed', errorMessage: 'middle kaboom' })
      .where(eq(schema.taskSteps.id, middleStep.id));
    const epochBefore6 = await taskEpoch();
    const run6 = await leaveLaterRoundActive();
    const cliProviderRes6 = await app.request(`/tasks/${task.id}/steps/middle-step/cli-provider`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ cliProviderId: null, round: 0 }),
    });
    assertStatus('PATCH cli-provider on failed step', cliProviderRes6.status, 200);
    const epochAfter6 = await assertMovedTask(
      'cli-provider on failed middle-step',
      run6,
      epochBefore6,
    );
    const middleAfter6 = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, middleStep.id),
    });
    if (middleAfter6?.status !== 'pending') {
      throw new Error(
        `expected middle-step pending after cli-provider switch, got ${middleAfter6?.status}`,
      );
    }
    const middleEpochs6 = await queuedEpochs('middle-step');
    if (!middleEpochs6.includes(epochAfter6)) {
      throw new Error(
        `expected a queued job for middle-step carrying epoch ${epochAfter6}, got ${JSON.stringify(middleEpochs6)}`,
      );
    }

    // 6b. The same change on a pending step only invalidates it: nothing else is reset, the epoch
    //     stays, a failed task stays failed and no advance is queued for it.
    await db.update(schema.tasks).set({ status: 'failed' }).where(eq(schema.tasks.id, task.id));
    const epochBefore6b = await taskEpoch();
    const run6b = await leaveLaterRoundActive();
    const queuedBefore6b = await queuedEpochs('middle-step');
    const cliProviderRes6b = await app.request(`/tasks/${task.id}/steps/middle-step/cli-provider`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ cliProviderId: null, round: 0 }),
    });
    assertStatus('PATCH cli-provider on pending step', cliProviderRes6b.status, 200);
    const laterAfter6b = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, laterRound.id),
    });
    if (laterAfter6b?.status !== 'waiting_cli') {
      throw new Error(
        `expected the later round's step untouched by a pending-step CLI switch, got ${laterAfter6b?.status}`,
      );
    }
    const run6bAfter = await db.query.cliInvocations.findFirst({
      where: eq(schema.cliInvocations.id, run6b.id),
    });
    if (run6bAfter?.supersededAt) {
      throw new Error(
        "expected the later round's live invocation NOT superseded by a pending-step CLI switch",
      );
    }
    const epochAfter6b = await taskEpoch();
    if (epochAfter6b !== epochBefore6b) {
      throw new Error(`expected the epoch unchanged, ${epochBefore6b} -> ${epochAfter6b}`);
    }
    const taskAfter6b = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, task.id) });
    if (taskAfter6b?.status !== 'failed') {
      throw new Error(`expected the task to stay failed, got ${taskAfter6b?.status}`);
    }
    const queuedAfter6b = await queuedEpochs('middle-step');
    if (queuedAfter6b.length !== queuedBefore6b.length) {
      throw new Error(
        `expected no new queued job for middle-step, had ${queuedBefore6b.length}, now ${queuedAfter6b.length}`,
      );
    }

    // 5. Task events recorded
    const events = await db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, task.id));
    const retryEvent = events.find((e) => e.eventType === 'step.retry');
    // Compared by field: jsonb stores an object's keys in its own order, not the one written.
    const leftActiveEvent = events.find((e) => {
      if (e.eventType !== 'step.retry') return false;
      const left = (e.payload as { leftActive?: { stepId?: string; round?: number }[] }).leftActive;
      return left?.length === 1 && left[0]?.stepId === 'later-round-step' && left[0]?.round === 1;
    });
    if (!leftActiveEvent) throw new Error('step.retry did not record the row it left active');
    const skipEvent = events.find((e) => e.eventType === 'step.skip');
    if (!retryEvent) throw new Error('missing step.retry event');
    if (!skipEvent) throw new Error('missing step.skip event');

    log.info(
      {
        retries: events.filter((e) => e.eventType === 'step.retry').length,
        skips: events.filter((e) => e.eventType === 'step.skip').length,
      },
      'retry/skip wiring verified',
    );

    console.log(
      JSON.stringify({
        smoke: 'STEP_RETRY_SKIP_OK',
        taskStatusAfterRetry: taskAfterRetry.status,
        taskStatusAfterSkip: taskAfterSkip?.status,
      }),
    );
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    try {
      const db = getDb();
      if (state.taskId) {
        for (const job of await getTaskQueue().getJobs(['wait', 'delayed', 'prioritized'])) {
          if ((job.data as { taskId?: string })?.taskId === state.taskId) {
            await job.remove().catch(() => {});
          }
        }
        await db.delete(schema.taskEvents).where(eq(schema.taskEvents.taskId, state.taskId));
        await db
          .delete(schema.cliInvocations)
          .where(eq(schema.cliInvocations.taskId, state.taskId));
        await db.delete(schema.taskSteps).where(eq(schema.taskSteps.taskId, state.taskId));
        await db.delete(schema.tasks).where(eq(schema.tasks.id, state.taskId));
      }
      if (state.userId) {
        await db.delete(schema.users).where(eq(schema.users.id, state.userId));
      }
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    if (state.paused) {
      await getTaskQueue()
        .resume()
        .catch((err) => log.error({ err }, 'FAILED TO RESUME THE TASK QUEUE — resume it manually'));
    }
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();

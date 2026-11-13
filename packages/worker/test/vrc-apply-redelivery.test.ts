import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { eq } from 'drizzle-orm';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { redriveStalledTasks } from '../src/queues/stalled-redrive.js';
import { createBuildImageStep } from '../src/step-engine/steps/env-replicate/03-build-image.js';
import { dbMigrateStep } from '../src/step-engine/steps/workflow/06a-db-migrate.js';
import { saveDatabaseStep } from '../src/step-engine/steps/workflow/11g-save-database.js';
import { fakeDockerRunner } from './fake-docker-runner.js';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';

const h = vi.hoisted(() => ({ exec: vi.fn(), snapshot: vi.fn(), ensure: vi.fn() }));
vi.mock('../src/step-engine/steps/workflow/_app-runtime.js', () => ({
  ensureDdevWithProgress: h.ensure,
  withDdevProgress: async (_ctx: unknown, _label: string, fn: (line: () => void) => unknown) =>
    fn(() => {}),
}));
vi.mock('../src/sandbox/ddev-runner.js', async (original) => ({
  ...(await original<typeof import('../src/sandbox/ddev-runner.js')>()),
  ddevExec: h.exec,
  ddevSnapshot: h.snapshot,
}));

function context(): StepContext {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    envTemplates: schema.envTemplates,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
  });
  fake.insert(schema.tasks, {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'running',
    orchestrationEpoch: 3,
  });
  fake.insert(schema.taskSteps, {
    id: '22222222-2222-4222-8222-222222222222',
    taskId: '11111111-1111-4111-8111-111111111111',
    stepId: dbMigrateStep.metadata.id,
    stepIndex: 1,
    round: 0,
    status: 'running',
  });
  return {
    taskId: '11111111-1111-4111-8111-111111111111',
    taskStepId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    repoPath: '',
    workspacePath: '',
    sandboxWorkdir: '/workspace',
    cliProviderId: null,
    db: fake.db as unknown as Database,
    logger: logger.child({ test: 'vrc-apply-redelivery' }),
    round: 0,
    signal: new AbortController().signal,
    emitProgress: async () => {},
    throwIfCancelled() {},
  };
}

/** Simulate loss of a handler after its external effect, before its done write. The real
 * stalled sweep receives the stale running-row candidate and queues its successor. SQL
 * selection/fencing is the seam here (covered by stalled-redrive-running-db.test.ts).
 * The enqueue seam delivers the cached apply arguments, as step-runner.ts:2953 does.
 */
async function redeliver(ctx: StepContext, stepId: string, apply: () => Promise<unknown>) {
  const candidate = {
    taskId: ctx.taskId,
    userId: ctx.userId,
    stepId,
    round: 0,
    epoch: 3,
    taskStatus: 'running',
    rowId: ctx.taskStepId,
    rowStatus: 'running',
    rowWaitingStartedAt: null,
    rowError: null,
  };
  const db = {
    select: () => ({
      from: () => ({
        leftJoin: () => ({ where: async () => [candidate] }),
        innerJoin: () => ({ where: async () => [] }),
        where: async () => [],
      }),
    }),
    transaction: async () => ({ epoch: 4 }),
  } as unknown as Database;
  const delivered: number[] = [];
  const count = await redriveStalledTasks(
    db,
    {
      enqueueAdvance: async (_task, _user, _step, _round, epoch) => {
        delivered.push(epoch);
        await apply();
      },
      failTask: async () => false,
      enqueueStart: async () => {},
      queuedTaskJobs: async () => ({ steps: new Set(), starts: new Set() }),
      queuedInvocationIds: async () => new Set(),
      stepHeld: () => false,
      redriveRetryDelaysMs: [],
    },
    { staleMs: 300_000 },
  );
  expect(count).toBe(1);
  expect(delivered).toEqual([4]);
}

describe('deterministic apply redelivery', () => {
  beforeEach(() => {
    h.snapshot.mockResolvedValue({ exitCode: 0, output: '' });
    h.ensure.mockResolvedValue({ container: 'vrc-fake', projectDir: '/workspace' });
  });
  afterEach(() => vi.resetAllMocks());

  it('does not rebuild an image whose first build completed before the lost done write', async () => {
    const build = vi.fn(
      async (_opts: import('../src/sandbox/docker-runner.js').DockerBuildOpts) => ({
        exitCode: 0,
        imageTag: 'vrc-probe:latest',
        imageId: 'sha256:vrc',
        durationMs: 0,
        stderr: '',
        timedOut: false,
      }),
    );
    const step = createBuildImageStep(
      fakeDockerRunner({
        build,
        inspect: async () => ({
          exists: true,
          imageId: 'sha256:vrc',
          labels: build.mock.calls[0]?.[0]?.labels,
        }),
      }),
    );
    const ctx = context();
    const args = {
      detected: {
        envTemplateId: '66666666-6666-4666-8666-666666666666',
        name: 'vrc',
        baseImage: 'scratch',
        dockerfile: 'FROM scratch',
        currentImageId: null,
        status: 'pending',
      },
      formValues: { imageTag: 'vrc-probe:latest', forceRebuild: false },
      iteration: 0,
      previousIterations: [],
    };
    const apply = () => step.apply(ctx, args);
    await apply();
    await redeliver(ctx, step.metadata.id, apply);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'reconciles Docker completion before metadata was written (force=%s)',
    async (forceRebuild) => {
      let labels: Record<string, string> | undefined;
      const build = vi.fn(
        async (opts: import('../src/sandbox/docker-runner.js').DockerBuildOpts) => {
          labels = opts.labels;
          throw new Error('worker lost after Docker committed the image');
        },
      );
      const step = createBuildImageStep(
        fakeDockerRunner({
          build,
          inspect: async () => ({ exists: true, imageId: 'sha256:completed', labels }),
        }),
      );
      const ctx = context();
      const args = {
        detected: {
          envTemplateId: '66666666-6666-4666-8666-666666666666',
          name: 'image',
          baseImage: 'scratch',
          dockerfile: 'FROM scratch',
          currentImageId: null,
          status: 'pending',
        },
        formValues: { imageTag: 'recovery:latest', forceRebuild },
        iteration: 0,
        previousIterations: [],
      };
      await expect(step.apply(ctx, args)).rejects.toThrow('worker lost');
      await redeliver(ctx, step.metadata.id, async () => {
        await expect(step.apply(ctx, args)).resolves.toMatchObject({
          imageId: 'sha256:completed',
          skipped: true,
        });
      });
      expect(build).toHaveBeenCalledTimes(1);
    },
  );

  it('rebuilds instead of adopting an image bearing another apply identity', async () => {
    const build = vi.fn().mockRejectedValueOnce(new Error('build interrupted')).mockResolvedValue({
      exitCode: 0,
      imageTag: 'foreign:latest',
      imageId: 'sha256:ours',
      durationMs: 0,
      stderr: '',
      timedOut: false,
    });
    const inspect = vi.fn(async () => ({
      exists: true,
      imageId: 'sha256:foreign',
      labels: { 'haive.apply-id': 'another-run' },
    }));
    const step = createBuildImageStep(fakeDockerRunner({ build, inspect }));
    const ctx = context();
    const args = {
      detected: {
        envTemplateId: '66666666-6666-4666-8666-666666666666',
        name: 'image',
        baseImage: 'scratch',
        dockerfile: 'FROM scratch',
        currentImageId: null,
        status: 'pending',
      },
      formValues: { imageTag: 'foreign:latest', forceRebuild: false },
      iteration: 0,
      previousIterations: [],
    };
    await expect(step.apply(ctx, args)).rejects.toThrow('build interrupted');
    await expect(step.apply(ctx, args)).resolves.toMatchObject({
      imageId: 'sha256:ours',
      skipped: false,
    });
    expect(inspect).toHaveBeenCalledWith('foreign:latest');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('does not repeat an approved custom migration after its external effect succeeded', async () => {
    let appliedDataChanges = 0;
    h.exec.mockImplementation(async () => {
      appliedDataChanges++;
      return { exitCode: 0, output: 'migration applied' };
    });
    h.snapshot.mockResolvedValue({ exitCode: 0, output: '' });
    const ctx = context();
    const args = {
      detected: {
        framework: 'unknown' as const,
        migrationCommand: 'node migrate-data.js',
        repoSubpath: 'vrc',
      },
      formValues: { runMigration: true, migrationCommand: 'node migrate-data.js' },
      iteration: 0,
      previousIterations: [],
    };
    const apply = () => dbMigrateStep.apply(ctx, args);
    await apply();
    await redeliver(ctx, dbMigrateStep.metadata.id, apply);
    expect(appliedDataChanges).toBe(1);
  });

  it('retries the durability snapshot after replaying a recorded command success', async () => {
    h.exec.mockResolvedValue({ exitCode: 0, output: 'migration applied' });
    h.snapshot.mockRejectedValueOnce(new Error('worker lost during snapshot'));
    const ctx = context();
    const args = {
      detected: {
        framework: 'unknown' as const,
        migrationCommand: 'node migrate.js',
        repoSubpath: 'repo',
      },
      formValues: { runMigration: true, migrationCommand: 'node migrate.js' },
      iteration: 0,
      previousIterations: [],
    };
    await expect(dbMigrateStep.apply(ctx, args)).rejects.toThrow('worker lost during snapshot');
    h.snapshot.mockResolvedValue({ exitCode: 1, output: 'snapshot unavailable' });
    await redeliver(ctx, dbMigrateStep.metadata.id, async () => {
      await expect(dbMigrateStep.apply(ctx, args)).resolves.toMatchObject({
        passed: true,
        output: 'migration applied',
      });
    });
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(h.snapshot).toHaveBeenCalledTimes(2);
  });

  it('does not claim a custom migration ran when DDEV startup failed', async () => {
    h.ensure.mockRejectedValueOnce(new Error('DDEV configuration needs repair'));
    h.exec.mockResolvedValue({ exitCode: 0, output: 'done' });
    const ctx = context();
    const args = {
      detected: {
        framework: 'unknown' as const,
        migrationCommand: 'node migrate.js',
        repoSubpath: 'repo',
      },
      formValues: { runMigration: true, migrationCommand: 'node migrate.js' },
      iteration: 0,
      previousIterations: [],
    };
    await expect(dbMigrateStep.apply(ctx, args)).rejects.toThrow('DDEV configuration');
    expect(h.exec).not.toHaveBeenCalled();
    await expect(dbMigrateStep.apply(ctx, args)).resolves.toMatchObject({ passed: true });
    expect(h.exec).toHaveBeenCalledTimes(1);
  });

  it('re-executes a failed custom command after the explicit AI retry receipt reset', async () => {
    h.exec.mockResolvedValueOnce({ exitCode: 1, output: 'column missing' });
    const ctx = context();
    const args = {
      detected: {
        framework: 'unknown' as const,
        migrationCommand: 'node migrate.js',
        repoSubpath: 'repo',
      },
      formValues: { runMigration: true, migrationCommand: 'node migrate.js' },
      iteration: 0,
      previousIterations: [],
    };
    await expect(dbMigrateStep.apply(ctx, args)).rejects.toThrow('column missing');
    // The retry_ai route contract is exercised by task-retry-failed-step.test.ts.
    await ctx.db
      .update(schema.taskSteps)
      .set({ applyReceipt: null })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    h.exec.mockResolvedValue({ exitCode: 0, output: 'repaired' });
    await expect(dbMigrateStep.apply(ctx, args)).resolves.toMatchObject({
      passed: true,
      output: 'repaired',
    });
    expect(h.exec).toHaveBeenCalledTimes(2);
  });

  it('holds an interrupted custom migration until the user explicitly retries', async () => {
    h.exec.mockRejectedValue(new Error('worker lost during command'));
    const ctx = context();
    const args = {
      detected: {
        framework: 'unknown' as const,
        migrationCommand: 'node migrate.js',
        repoSubpath: 'repo',
      },
      formValues: { runMigration: true, migrationCommand: 'node migrate.js' },
      iteration: 0,
      previousIterations: [],
    };
    await expect(dbMigrateStep.apply(ctx, args)).rejects.toThrow('worker lost');
    await redeliver(ctx, dbMigrateStep.metadata.id, async () => {
      await expect(dbMigrateStep.apply(ctx, args)).rejects.toThrow('outcome is unknown');
    });
    expect(h.exec).toHaveBeenCalledTimes(1);
    // The explicit Retry reset clears the receipt, unlike recovery and Resume.
    await resetStepAndDownstream(ctx.db, ctx.taskId, dbMigrateStep.metadata.id, ctx.round);
    // The real runner claims the reset pending row before invoking apply.
    await ctx.db
      .update(schema.taskSteps)
      .set({ status: 'running' })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    h.exec.mockResolvedValue({ exitCode: 0, output: 'done' });
    await expect(dbMigrateStep.apply(ctx, args)).resolves.toMatchObject({ passed: true });
    expect(h.exec).toHaveBeenCalledTimes(2);
  });

  it('treats an edited framework command as custom and preserves a known failure', async () => {
    h.exec.mockResolvedValue({ exitCode: 1, output: 'partial data update' });
    const ctx = context();
    const args = {
      detected: {
        framework: 'laravel' as const,
        migrationCommand: 'php artisan migrate --force',
        repoSubpath: 'repo',
      },
      formValues: {
        runMigration: true,
        migrationCommand: 'php artisan migrate --force && node repair-data.js',
      },
      iteration: 0,
      previousIterations: [],
    };
    await expect(dbMigrateStep.apply(ctx, args)).rejects.toThrow('partial data update');
    await expect(dbMigrateStep.apply(ctx, args)).rejects.toThrow('partial data update');
    expect(h.exec).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['drupal', 'drush updatedb -y'],
    ['laravel', 'php artisan migrate --force'],
    ['symfony', 'php bin/console doctrine:migrations:migrate --no-interaction'],
    ['django', 'python manage.py migrate --noinput'],
    ['rails', 'bin/rails db:migrate'],
    ['wordpress', 'wp core update-db'],
    ['prisma', 'npx prisma migrate deploy'],
  ] as const)(
    'keeps the ledger-backed %s default replayable',
    async (framework, migrationCommand) => {
      h.exec.mockResolvedValue({ exitCode: 0, output: 'Connected; no pending migrations' });
      const ctx = context();
      const args = {
        detected: { framework, migrationCommand, repoSubpath: 'repo' },
        formValues: { runMigration: true, migrationCommand },
        iteration: 0,
        previousIterations: [],
      };
      await dbMigrateStep.apply(ctx, args);
      await dbMigrateStep.apply(ctx, args);
      expect(
        h.exec.mock.calls.filter((call) => call[1] === `exec ${migrationCommand}`),
      ).toHaveLength(2);
    },
  );

  it('keeps a published database save decision when recovery advances the epoch', async () => {
    const ctx = context();
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      taskDatabaseStates: schema.taskDatabaseStates,
      repositoryDatabaseStates: schema.repositoryDatabaseStates,
      databaseSnapshots: schema.databaseSnapshots,
    });
    const repositoryId = '44444444-4444-4444-8444-444444444444';
    const snapshotId = '55555555-5555-4555-8555-555555555555';
    fake.insert(schema.tasks, {
      id: ctx.taskId,
      userId: ctx.userId,
      repositoryId,
      status: 'running',
      orchestrationEpoch: 3,
    });
    fake.insert(schema.taskSteps, { id: ctx.taskStepId, taskId: ctx.taskId, status: 'running' });
    // Publication already committed; only the step's done write was lost.
    fake.insert(schema.taskDatabaseStates, {
      taskId: ctx.taskId,
      repositoryId,
      outcome: 'saved',
      decisionEpoch: 3,
      baseRevision: 1,
      candidateSnapshotId: snapshotId,
      candidateStepId: ctx.taskStepId,
      exportError: null,
    });
    fake.insert(schema.repositoryDatabaseStates, { repositoryId, revision: 1, snapshotId });
    fake.insert(schema.databaseSnapshots, {
      id: snapshotId,
      repositoryId,
      userId: ctx.userId,
      sourceTaskId: ctx.taskId,
      status: 'ready',
    });
    ctx.db = fake.db as unknown as Database;
    const apply = () =>
      saveDatabaseStep.apply(ctx, {
        detected: null,
        formValues: { action: 'save:0' },
        iteration: 0,
        previousIterations: [],
      });
    await expect(apply()).resolves.toEqual({ outcome: 'saved' });
    let recovered: unknown;
    await redeliver(ctx, saveDatabaseStep.metadata.id, async () => {
      // Mirror the fence's epoch write in the apply database; no upstream step was retried.
      await ctx.db
        .update(schema.tasks)
        .set({ orchestrationEpoch: 4 })
        .where(eq(schema.tasks.id, ctx.taskId));
      recovered = await apply().catch((error: unknown) => error);
    });
    expect(recovered).toEqual({ outcome: 'saved' });
    expect(h.exec).not.toHaveBeenCalled();
  });
});

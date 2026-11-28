import { advanceStep } from '../src/step-engine/step-runner.js';
import { redriveStalledTasks } from '../src/queues/stalled-redrive.js';
import type { DeclareDepsDetect } from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import {
  FixRoundCliUnavailable,
  recordFixRoundCliChoice,
} from '../src/step-engine/steps/workflow/_fix-round-cli.js';
import { phase2ImplementStep } from '../src/step-engine/steps/workflow/07-phase-2-implement.js';
import {
  assertComposedLspWriteProviderAvailable,
  lockTaskForComposedLsp,
  withComposedLspTransaction,
  writeLockedStepCliChoice,
} from '@haive/shared/composed-lsp-provider-lock';
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, hasPgCode, schema, type Database } from '@haive/database';
import { declareDepsStep } from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({ beforeLock: undefined as (() => void) | undefined }));
vi.mock('@haive/shared/composed-lsp-provider-lock', async (original) => {
  const real = await original<typeof import('@haive/shared/composed-lsp-provider-lock')>();
  return {
    ...real,
    lockTaskForComposedLsp: async (...args: Parameters<typeof real.lockTaskForComposedLsp>) => {
      h.beforeLock?.();
      return real.lockTaskForComposedLsp(...args);
    },
  };
});

const url = process.env.DECLARE_DEPS_PROVIDER_LOCK_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/declare_deps_provider_lock_test'))
  throw new Error('Use a dedicated declare_deps_provider_lock_test database');

const runList = [
  '04-verify-environment',
  '01-worktree-setup',
  '01b-install-plugins',
  '01b1-verify-composed-lsp',
  '05-implement',
];
const deferred = () => Promise.withResolvers<void>();

describe.skipIf(!url)('step 01 provider decisions on Postgres', () => {
  let db: Database;
  let other: Database;
  let userId: string;
  let repositoryId: string;
  let claude: string;
  let codex: string;
  beforeAll(async () => {
    db = createDatabase(url!);
    other = createDatabase(url!);
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'deps-lock@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'unused',
        status: 'active',
        role: 'user',
      })
      .returning();
    userId = user!.id;
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'deps-lock',
        source: 'local_path',
        localPath: '/tmp',
        storagePath: '/tmp',
        status: 'ready',
        lspServers: ['intelephense-extended'],
      })
      .returning();
    repositoryId = repo!.id;
    for (const name of ['claude-code', 'codex'] as const) {
      const [provider] = await db
        .insert(schema.cliProviders)
        .values({
          userId,
          name,
          label: name,
          enabled: true,
          createdAt: new Date(name === 'claude-code' ? 1 : 2),
        })
        .returning();
      if (name === 'claude-code') claude = provider!.id;
      else codex = provider!.id;
    }
  });
  beforeEach(async () => {
    await db
      .update(schema.repositories)
      .set({ lspServers: ['intelephense-extended'] })
      .where(eq(schema.repositories.id, repositoryId));
    h.beforeLock = undefined;
    await db
      .update(schema.cliProviders)
      .set({ name: 'claude-code' })
      .where(eq(schema.cliProviders.id, claude));
  });
  afterAll(async () => {
    h.beforeLock = undefined;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await Promise.all([db.$client.end({ timeout: 5 }), other.$client.end({ timeout: 5 })]);
  });

  async function fixture() {
    const [template] = await db
      .insert(schema.envTemplates)
      .values({
        userId,
        repositoryId,
        name: 'legacy',
        baseImage: 'ubuntu:24.04',
        declaredDeps: { lspServers: ['intelephense-extended'] },
      })
      .returning();
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'workflow',
        title: 'deps-lock',
        status: 'running',
        cliProviderId: claude,
        envTemplateId: template!.id,
        runListSnapshot: runList,
        ignoreSavedStepClis: true,
      })
      .returning();
    const ctx = {
      db,
      userId,
      taskId: task!.id,
      cliProviderId: claude,
      logger: { info: vi.fn() },
      emitProgress: vi.fn(),
    } as unknown as StepContext;
    const apply = () =>
      declareDepsStep.apply(ctx, {
        detected: { runtimes: [], cliSupportsLsp: false },
        formValues: {
          runtimes: [],
          containerTool: 'none',
          databaseKind: 'none',
          preinstallDeps: true,
          browserTesting: false,
          extraPackages: '',
          replaceLegacyLspInstall: true,
        },
        iteration: 0,
        previousIterations: [],
      } as unknown as Parameters<typeof declareDepsStep.apply>[1]);
    return { task: task!, template: template!, ctx, apply };
  }

  it('uses the current task CLI when the step context still names a non-LSP CLI', async () => {
    const f = await fixture();
    f.ctx.cliProviderId = codex;
    const result = await f.apply();
    const saved = await db.query.envTemplates.findFirst({
      where: eq(schema.envTemplates.id, result.envTemplateId),
    });
    expect(saved?.declaredDeps).toMatchObject({
      lspInstallContractVersion: 2,
      lspServers: ['intelephense-extended'],
    });
    const events = await db
      .select()
      .from(schema.taskEvents)
      .where(
        and(
          eq(schema.taskEvents.taskId, f.task.id),
          eq(schema.taskEvents.eventType, 'env_template.replaced'),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it('refreshes capability after waiting for the task lock and rolls the candidate back', async () => {
    const f = await fixture();
    const before = await db
      .select({ id: schema.envTemplates.id })
      .from(schema.envTemplates)
      .where(eq(schema.envTemplates.userId, userId));
    const writerReady = deferred();
    const releaseWriter = deferred();
    const readerAtLock = deferred();
    h.beforeLock = () => readerAtLock.resolve();
    const writer = other.transaction(async (tx) => {
      await tx
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, f.task.id))
        .for('no key update');
      await tx
        .update(schema.tasks)
        .set({ cliProviderId: null })
        .where(eq(schema.tasks.id, f.task.id));
      await tx
        .update(schema.cliProviders)
        .set({ name: 'codex' })
        .where(eq(schema.cliProviders.id, claude));
      writerReady.resolve();
      await releaseWriter.promise;
    });
    await writerReady.promise;
    const outcome = f.apply().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await Promise.race([
        readerAtLock.promise,
        outcome.then(() => {
          throw new Error('apply ended before taking the task lock');
        }),
      ]);
    } finally {
      releaseWriter.resolve();
    }
    await writer;
    expect(await outcome).toMatchObject({ error: { reason: 'cli_unsupported' } });
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, f.task.id) });
    expect(task?.envTemplateId).toBe(f.template.id);
    const candidates = await db
      .select()
      .from(schema.envTemplates)
      .where(eq(schema.envTemplates.userId, userId));
    expect(candidates.map((t) => t.id).sort()).toEqual(before.map((t) => t.id).sort());
    const events = await db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, f.task.id));
    expect(events).toEqual([]);
  });

  async function answeredFixture(lspServers = ['intelephense-extended'], cleared = false) {
    const f = await fixture();
    await db
      .update(schema.repositories)
      .set({ lspServers: null })
      .where(eq(schema.repositories.id, repositoryId));
    const detected = {
      runtimes: [{ language: 'php', version: '8.3' }],
      containerTool: cleared ? 'ddev' : 'none',
      database: { kind: cleared ? 'mysql' : 'none', version: cleared ? '8.0' : null },
      webserver: 'nginx-fpm',
      suggestedLsp: ['intelephense-extended'],
      cliSupportsLsp: true,
      legacyLspReplaceable: true,
    } as DeclareDepsDetect;
    const values = {
      runtimes: ['php'],
      phpVersion: '8.4',
      containerTool: cleared ? 'none' : 'docker-compose',
      databaseKind: cleared ? 'none' : 'postgres',
      databaseVersion: cleared ? '' : '18',
      webserver: 'apache-fpm',
      preinstallDeps: false,
      browserTesting: false,
      extraPackages: 'jq',
      lspServers,
      replaceLegacyLspInstall: true,
    };
    const old = new Date(Date.now() - 10 * 60_000);
    await db
      .update(schema.tasks)
      .set({
        currentStepId: '01-declare-deps',
        currentRound: 0,
        orchestrationEpoch: 7,
        updatedAt: old,
        autoContinue: true,
      })
      .where(eq(schema.tasks.id, f.task.id));
    const [row] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: f.task.id,
        stepId: '01-declare-deps',
        stepIndex: 0,
        round: 0,
        title: 'Dependencies',
        status: 'running',
        formValues: values,
        formSchema: declareDepsStep.form!(f.ctx, detected),
        detectOutput: detected,
        startedAt: old,
        updatedAt: old,
      })
      .returning();
    const advance = (epoch: number) =>
      advanceStep({
        db,
        userId,
        taskId: f.task.id,
        repoPath: '/tmp',
        workspacePath: '/tmp',
        cliProviderId: claude,
        epoch,
        round: 0,
        stepDef: { ...declareDepsStep, detect: async () => detected },
        providers: [],
        deps: {
          enqueueCliInvocation: async () => {
            throw new Error('No CLI expected');
          },
        },
      });
    return { ...f, values, row: row!, advance };
  }

  it('a stalled-sweep re-drive preserves the saved replacement tick and commits the replacement', async () => {
    const f = await answeredFixture();
    const queued: { taskId: string; epoch: number }[] = [];
    await redriveStalledTasks(
      db,
      {
        enqueueAdvance: async (taskId, _user, _step, _round, epoch) => {
          queued.push({ taskId, epoch });
        },
        enqueueStart: async () => {},
        failTask: async () => false,
        queuedTaskJobs: async () => ({ steps: new Set(), starts: new Set() }),
        queuedInvocationIds: async () => new Set(),
        stepHeld: () => false,
      },
      { staleMs: 60_000 },
    );
    const job = queued.find((j) => j.taskId === f.task.id);
    expect(job).toBeDefined();
    expect(
      (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, f.row.id) }))
        ?.formValues,
    ).toEqual(f.values);
    expect((await f.advance(job!.epoch)).status).toBe('done');
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, f.task.id) });
    expect(task?.envTemplateId).not.toBe(f.template.id);
    const template = await db.query.envTemplates.findFirst({
      where: eq(schema.envTemplates.id, task!.envTemplateId!),
    });
    expect(template?.declaredDeps?.lspInstallContractVersion).toBe(2);
    expect(
      (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, f.row.id) }))
        ?.formValues,
    ).toMatchObject({ replaceLegacyLspInstall: true });
  });

  it.each([false, true])(
    'a refused same-submit selection keeps submitted defaults, explicit none=%s',
    async (cleared) => {
      const f = await answeredFixture(['pyright'], cleared);
      const result = await f.advance(7);
      expect(result.status).toBe('waiting_form');
      if (result.status !== 'waiting_form') throw new Error('Expected a decision form');
      const defaults = Object.fromEntries(
        result.formSchema.fields.map((field) => [
          field.id,
          'defaults' in field ? field.defaults : 'default' in field ? field.default : undefined,
        ]),
      );
      expect(defaults).toMatchObject({
        runtimes: ['php'],
        phpVersion: '8.4',
        containerTool: cleared ? 'none' : 'docker-compose',
        databaseKind: cleared ? 'none' : 'postgres',
        databaseVersion: cleared ? '' : '18',
        webserver: 'apache-fpm',
        preinstallDeps: false,
        browserTesting: false,
        extraPackages: 'jq',
        lspServers: ['pyright'],
        replaceLegacyLspInstall: false,
      });
      expect(result.formSchema.fields).toContainEqual(
        expect.objectContaining({
          id: 'reopenedFormNotice',
          type: 'note',
          variant: 'warning',
        }),
      );
      expect(
        (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, f.task.id) }))?.envTemplateId,
      ).toBe(f.template.id);
      expect(result.row.formValues).toBeNull();
    },
  );

  it('a contending lockTaskForComposedLsp reads the provider committed by the holder', async () => {
    const f = await fixture();
    const held = deferred();
    const release = deferred();
    const holder = other.transaction(async (tx) => {
      await lockTaskForComposedLsp(tx, { userId, taskId: f.task.id });
      await tx
        .update(schema.tasks)
        .set({ cliProviderId: codex })
        .where(eq(schema.tasks.id, f.task.id));
      held.resolve();
      await release.promise;
    });
    await held.promise;
    let read = false;
    const waiterPid = Promise.withResolvers<number>();
    const waiter = db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      waiterPid.resolve(backend!.pid);
      const result = await lockTaskForComposedLsp(tx, { userId, taskId: f.task.id });
      read = true;
      return result;
    });
    try {
      const pid = await waiterPid.promise;
      // Observe THIS waiter's server-side lock wait before allowing the holder to commit.
      await expect
        .poll(
          async () => {
            const [state] = await db.execute<{ blocked: boolean }>(sql`
          SELECT wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0 AS blocked
          FROM pg_stat_activity WHERE pid = ${pid}`);
            return state?.blocked;
          },
          { timeout: 1_500, interval: 10 },
        )
        .toBe(true);
      expect(read).toBe(false);
    } finally {
      release.resolve();
    }
    await holder;
    expect(await waiter).toEqual({ cliProviderId: codex });
  });

  it.each([
    { victim: 'choice', write: 'choice' },
    { victim: 'delete', write: 'choice' },
    { victim: 'choice', write: 'summary' },
    { victim: 'delete', write: 'summary' },
    { victim: 'choice', write: 'fix_round' },
    { victim: 'delete', write: 'fix_round' },
  ])(
    'provider delete versus KEY SHARE: $victim victim, $write writer has a retryable outcome',
    async ({ victim, write }) => {
      const f = await fixture();
      const [provider] = await db
        .insert(schema.cliProviders)
        .values({ userId, name: 'codex', label: 'deadlock-only', enabled: true })
        .returning();
      await db
        .update(schema.tasks)
        .set({ cliProviderId: provider!.id })
        .where(eq(schema.tasks.id, f.task.id));
      const taskHeld = deferred();
      const providerHeld = deferred();
      let choicePid = 0;
      let deletePid = 0;
      const waitBlockedBy = async (pid: number, blocker: number) => {
        await expect
          .poll(
            async () => {
              const [state] = await db.execute<{ blocked: boolean }>(sql`
            SELECT wait_event_type = 'Lock' AND ${blocker} = ANY(pg_blocking_pids(pid)) AS blocked
            FROM pg_stat_activity WHERE pid = ${pid}`);
              return state?.blocked;
            },
            { timeout: 1_500, interval: 10 },
          )
          .toBe(true);
      };
      let attempts = 0;
      const observed: string[] = [];
      const choice = withComposedLspTransaction(db, async (tx) => {
        attempts++;
        await tx.execute(
          sql.raw(`SET LOCAL deadlock_timeout = '${victim === 'choice' ? '25ms' : '1min'}'`),
        );
        await tx.execute(sql`SET LOCAL statement_timeout = '8s'`);
        await lockTaskForComposedLsp(tx, { userId, taskId: f.task.id });
        if (attempts === 1) {
          const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
          choicePid = backend!.pid;
          taskHeld.resolve();
          await providerHeld.promise;
          if (victim === 'choice') await waitBlockedBy(deletePid, choicePid);
        }
        try {
          if (write === 'choice') {
            await writeLockedStepCliChoice(tx, {
              userId,
              taskId: f.task.id,
              stepId: '05-implement',
              role: 'default',
              cliProviderId: provider!.id,
              effortLevel: null,
            });
          } else if (write === 'fix_round') {
            await recordFixRoundCliChoice(
              tx,
              userId,
              f.task.id,
              phase2ImplementStep,
              2,
              provider!.id,
            );
          } else {
            await assertComposedLspWriteProviderAvailable(tx, userId, provider!.id);
            await tx
              .update(schema.tasks)
              .set({ summaryCliProviderId: provider!.id })
              .where(eq(schema.tasks.id, f.task.id));
          }
        } catch (error) {
          if (hasPgCode(error, '40P01')) observed.push('40P01');
          throw error;
        }
      }).then(
        () => ({ ok: true }),
        (error: unknown) => ({ error }),
      );
      const deletion = other
        .transaction(async (tx) => {
          await tx.execute(
            sql.raw(`SET LOCAL deadlock_timeout = '${victim === 'delete' ? '25ms' : '1min'}'`),
          );
          await tx.execute(sql`SET LOCAL statement_timeout = '8s'`);
          await taskHeld.promise;
          await tx
            .select({ id: schema.cliProviders.id })
            .from(schema.cliProviders)
            .where(eq(schema.cliProviders.id, provider!.id))
            .for('update');
          const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
          deletePid = backend!.pid;
          providerHeld.resolve();
          // The intended detector enters the cycle last, after the peer is provably blocked.
          if (victim === 'delete') await waitBlockedBy(choicePid, deletePid);
          await tx.delete(schema.cliProviders).where(eq(schema.cliProviders.id, provider!.id));
        })
        .then(
          () => ({ ok: true }),
          (error: unknown) => ({ error }),
        );
      const [choiceResult, deleteResult] = await Promise.all([choice, deletion]);
      const savedTask = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, f.task.id) });
      const savedChoices = await db.query.taskStepCliChoices.findMany({
        where: eq(schema.taskStepCliChoices.taskId, f.task.id),
      });
      if (victim === 'choice') {
        expect(observed).toEqual(['40P01']);
        // A nested writer reports busy immediately; only its rolled-back outer transaction retries.
        expect(attempts).toBe(2);
        if (write === 'fix_round') {
          // After the outer rollback/retry the provider is gone: the gate asks for a fresh pick.
          expect('error' in choiceResult && choiceResult.error).toBeInstanceOf(
            FixRoundCliUnavailable,
          );
        } else {
          expect(choiceResult).toMatchObject({
            error: { code: 'composed_lsp_write_busy', retryable: true },
          });
        }
        expect(deleteResult).toEqual({ ok: true });
        expect(savedTask?.cliProviderId).toBeNull();
        expect(savedChoices).toEqual([]);
      } else {
        expect(choiceResult).toEqual({ ok: true });
        expect('error' in deleteResult && hasPgCode(deleteResult.error, '40P01')).toBe(true);
        const modulePath = new URL('../../api/src/middleware/error-handler.ts', import.meta.url)
          .pathname;
        const { errorHandler } = (await import(modulePath)) as {
          errorHandler: (error: unknown, ctx: unknown) => unknown;
        };
        const answer = errorHandler('error' in deleteResult ? deleteResult.error : null, {
          header: vi.fn(),
          json: (body: unknown, status: number) => ({ body, status }),
        });
        expect(answer).toMatchObject({
          status: 503,
          body: { code: 'transaction_retry_required', retryable: true },
        });
        expect(savedTask?.cliProviderId).toBe(provider!.id);
        if (write !== 'summary')
          expect(savedChoices).toMatchObject([{ cliProviderId: provider!.id }]);
        else expect(savedTask?.summaryCliProviderId).toBe(provider!.id);
      }
    },
  );
});

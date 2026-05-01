import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema, type StepIterationEntry } from '@haive/database';
import { logger, validateFormValues } from '@haive/shared';
import type {
  CliExecInvocationKind,
  CliExecJobPayload,
  FormSchema,
  FormValues,
  StepStatus,
} from '@haive/shared';
import type { CliProviderRecord } from '../cli-adapters/types.js';
import { resolveDispatch } from '../orchestrator/dispatcher.js';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import {
  TaskCancelledError,
  type AgentMiningResult,
  type StepContext,
  type StepDefinition,
  type StepLoopPassRecord,
} from './step-definition.js';

const log = logger.child({ module: 'step-runner' });

export type TaskStepRow = typeof schema.taskSteps.$inferSelect;

/** Returns the user's preferred CLI provider id for a step, validated as
 *  enabled. Falls back to the explicit task default when no preference
 *  exists, or when the preferred provider has been disabled/deleted. */
async function resolvePreferredCli(
  db: Database,
  userId: string,
  stepId: string,
  fallback: string | null,
  providers: { id: string; enabled: boolean }[],
): Promise<string | null> {
  const row = await db.query.userStepCliPreferences.findFirst({
    where: and(
      eq(schema.userStepCliPreferences.userId, userId),
      eq(schema.userStepCliPreferences.stepId, stepId),
    ),
  });
  if (!row) return fallback;
  const provider = providers.find((p) => p.id === row.cliProviderId);
  if (!provider || !provider.enabled) return fallback;
  return row.cliProviderId;
}

/** Records the CLI provider that was actually dispatched for a (user, step)
 *  pair. The next time this user reaches this step in any task, the runner
 *  and UI will prefer the same provider. */
async function recordStepCliPreference(
  db: Database,
  userId: string,
  stepId: string,
  cliProviderId: string,
): Promise<void> {
  await db
    .insert(schema.userStepCliPreferences)
    .values({ userId, stepId, cliProviderId })
    .onConflictDoUpdate({
      target: [schema.userStepCliPreferences.userId, schema.userStepCliPreferences.stepId],
      set: { cliProviderId, updatedAt: sql`now()` },
    });
}

export interface WorkerDeps {
  enqueueCliInvocation(payload: CliExecJobPayload): Promise<void>;
}

export interface AdvanceStepParams {
  db: Database;
  taskId: string;
  userId: string;
  repoPath: string;
  workspacePath: string;
  cliProviderId: string | null;
  stepDef: StepDefinition;
  formValues?: FormValues;
  providers?: CliProviderRecord[];
  deps?: WorkerDeps;
}

export type AdvanceStepResult =
  | { status: 'done'; row: TaskStepRow; output: unknown }
  | { status: 'waiting_form'; row: TaskStepRow; formSchema: FormSchema }
  | { status: 'waiting_cli'; row: TaskStepRow }
  | { status: 'skipped'; row: TaskStepRow }
  | { status: 'failed'; row: TaskStepRow; error: string };

type UpdatePatch = Partial<{
  status: StepStatus;
  detectOutput: unknown;
  formSchema: unknown;
  formValues: Record<string, unknown> | null;
  output: unknown;
  iterations: StepIterationEntry[];
  iterationCount: number;
  statusMessage: string | null;
  errorMessage: string | null;
  startedAt: Date;
  endedAt: Date;
}>;

type LlmResolved =
  | { resolved: true; llmOutput: unknown; current: TaskStepRow }
  | { resolved: false; result: AdvanceStepResult };

async function resolveLlmPhase(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  detected: unknown,
  formValues: FormValues | null,
  params: AdvanceStepParams,
): Promise<LlmResolved> {
  if (process.env.HAIVE_TEST_BYPASS_LLM === '1') {
    const stub = stepDef.llm?.bypassStub;
    const llmOutput = stub ? stub({ detected, formValues: formValues ?? {} }) : null;
    ctx.logger.warn(
      { hasStub: Boolean(stub) },
      'HAIVE_TEST_BYPASS_LLM=1, skipping llm with bypass stub',
    );
    return { resolved: true, llmOutput, current };
  }

  const llmSpec = stepDef.llm!;

  // Filter out CONSUMED invocations as well as superseded ones. A
  // consumed row is one whose output the runner has already incorporated
  // into a prior apply pass — only relevant when the step has a loop hook
  // (the runner sets consumed_at when it iterates). Without this filter
  // resolveLlmPhase would forever return iteration N's output instead of
  // enqueuing iteration N+1.
  const latest = await db
    .select()
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskStepId, current.id),
        isNull(schema.cliInvocations.supersededAt),
        isNull(schema.cliInvocations.consumedAt),
        ne(schema.cliInvocations.mode, 'agent_mining'),
      ),
    )
    .orderBy(desc(schema.cliInvocations.createdAt))
    .limit(1);
  const invocation = latest[0];

  if (invocation && invocation.endedAt !== null) {
    // An invocation failed if the CLI exited non-zero, exited abnormally
    // (null exit code = killed/timeout), or emitted an explicit errorMessage
    // (e.g. stream-json without a success result — rate-limit / early abort).
    const exitedBad = invocation.exitCode === null || invocation.exitCode !== 0;
    const errTrimmed = invocation.errorMessage?.trim() ?? '';
    const contentBad = errTrimmed.length > 0;
    if (exitedBad || contentBad) {
      const rawTail = invocation.rawOutput?.trim().slice(-1000) ?? '';
      const message =
        errTrimmed || rawTail || `cli exited with code ${invocation.exitCode ?? 'unknown'}`;
      const failed = await updateRow(db, current.id, {
        status: 'failed',
        errorMessage: `cli invocation failed: ${message}`,
        endedAt: new Date(),
      });
      return { resolved: false, result: { status: 'failed', row: failed, error: message } };
    }
    const llmOutput = invocation.parsedOutput ?? invocation.rawOutput;
    return { resolved: true, llmOutput, current };
  }

  if (invocation && invocation.endedAt === null) {
    return { resolved: false, result: { status: 'waiting_cli', row: current } };
  }

  // No invocation exists yet — dispatch one
  if (!params.providers || !params.deps) {
    const failed = await updateRow(db, current.id, {
      status: 'failed',
      errorMessage: 'step requires CLI invocation but no providers or deps supplied',
      endedAt: new Date(),
    });
    return {
      resolved: false,
      result: {
        status: 'failed',
        row: failed,
        error: failed.errorMessage ?? 'missing worker deps',
      },
    };
  }

  // For loop iterations > 0, prefer the loop's iteration-aware prompt
  // builder when present so the next pass receives prior findings; fall
  // back to the standard prompt otherwise. iteration here = passes
  // already completed (i.e. the upcoming pass's index).
  const previousIterations = stepIterationsAsRecords(current);
  const upcomingIteration = previousIterations.length;
  const prompt =
    upcomingIteration > 0 && stepDef.loop?.buildIterationPrompt
      ? stepDef.loop.buildIterationPrompt({
          detected,
          formValues: formValues ?? {},
          iteration: upcomingIteration,
          previousIterations,
        })
      : llmSpec.buildPrompt({ detected, formValues: formValues ?? {} });
  const preferredProviderId = await resolvePreferredCli(
    db,
    params.userId,
    stepDef.metadata.id,
    params.cliProviderId ?? null,
    params.providers,
  );
  const plan = resolveDispatch({
    providers: params.providers,
    preferredProviderId,
    input: {
      kind: 'prompt',
      prompt,
      capabilities: llmSpec.requiredCapabilities,
    },
    invokeOpts: {
      cwd: params.workspacePath,
    },
  });

  if (plan.mode === 'skip' || !plan.invocation) {
    const failed = await updateRow(db, current.id, {
      status: 'failed',
      errorMessage: `no cli provider available: ${plan.reason}`,
      endedAt: new Date(),
    });
    return {
      resolved: false,
      result: { status: 'failed', row: failed, error: failed.errorMessage ?? plan.reason },
    };
  }

  const mode = plan.mode === 'subagent_emulated' ? 'subagent_emulated' : 'cli';
  const payloadKind: CliExecInvocationKind =
    plan.invocation.kind === 'subagent'
      ? plan.mode === 'subagent_emulated'
        ? 'subagent_sequential'
        : 'subagent_native'
      : 'cli';
  const inserted = await db
    .insert(schema.cliInvocations)
    .values({
      taskId: params.taskId,
      taskStepId: current.id,
      cliProviderId: plan.providerId,
      mode,
      prompt,
    })
    .returning();
  const invRow = inserted[0];
  if (!invRow) throw new Error('failed to insert cli_invocations row');
  await params.deps.enqueueCliInvocation({
    invocationId: invRow.id,
    taskId: params.taskId,
    taskStepId: current.id,
    userId: params.userId,
    cliProviderId: plan.providerId,
    kind: payloadKind,
    spec: plan.invocation.spec,
    timeoutMs: llmSpec.timeoutMs,
  });
  if (plan.providerId) {
    await recordStepCliPreference(db, params.userId, stepDef.metadata.id, plan.providerId);
  }
  const updated = await updateRow(db, current.id, {
    status: 'waiting_cli',
    statusMessage: 'Waiting for AI analysis...',
  });
  ctx.logger.info(
    { invocationId: invRow.id, providerId: plan.providerId, mode: plan.mode },
    'cli invocation enqueued',
  );
  return { resolved: false, result: { status: 'waiting_cli', row: updated } };
}

type AgentMiningResolved =
  | { resolved: true; results: AgentMiningResult[]; current: TaskStepRow }
  | { resolved: false; result: AdvanceStepResult };

async function resolveAgentMiningPhase(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  detected: unknown,
  formValues: FormValues | null,
  llmOutput: unknown,
  params: AdvanceStepParams,
): Promise<AgentMiningResolved> {
  const spec = stepDef.agentMining!;

  const existing = await db
    .select()
    .from(schema.taskStepAgentMinings)
    .where(eq(schema.taskStepAgentMinings.taskStepId, current.id));

  if (existing.length > 0) {
    const pending = existing.filter((r) => r.status === 'pending' || r.status === 'running');
    if (pending.length > 0) {
      return { resolved: false, result: { status: 'waiting_cli', row: current } };
    }
    const results: AgentMiningResult[] = existing.map((r) => ({
      agentId: r.agentId,
      agentTitle: r.agentTitle,
      status: r.status === 'done' ? 'done' : 'failed',
      output: r.output,
      rawOutput: r.rawOutput,
      errorMessage: r.errorMessage,
    }));
    return { resolved: true, results, current };
  }

  if (!params.providers || !params.deps) {
    const failed = await updateRow(db, current.id, {
      status: 'failed',
      errorMessage: 'agent mining requires CLI invocation but no providers or deps supplied',
      endedAt: new Date(),
    });
    return {
      resolved: false,
      result: { status: 'failed', row: failed, error: failed.errorMessage ?? 'missing deps' },
    };
  }

  const dispatches = await spec.selectAgents({
    ctx,
    detected,
    formValues: formValues ?? {},
    llmOutput,
  });

  if (dispatches.length === 0) {
    ctx.logger.warn('agent mining selectAgents returned empty list, skipping mining');
    return { resolved: true, results: [], current };
  }

  const preferredProviderId = await resolvePreferredCli(
    db,
    params.userId,
    stepDef.metadata.id,
    params.cliProviderId ?? null,
    params.providers,
  );
  let recordedProviderId: string | null = null;

  for (const dispatch of dispatches) {
    const plan = resolveDispatch({
      providers: params.providers,
      preferredProviderId,
      input: {
        kind: 'prompt',
        prompt: dispatch.prompt,
        capabilities: spec.requiredCapabilities,
      },
      invokeOpts: { cwd: params.workspacePath },
    });

    if (plan.mode === 'skip' || !plan.invocation || plan.invocation.kind !== 'cli') {
      await db.insert(schema.taskStepAgentMinings).values({
        taskStepId: current.id,
        agentId: dispatch.agentId,
        agentTitle: dispatch.agentTitle,
        status: 'failed',
        errorMessage: `no cli provider available: ${plan.reason}`,
        endedAt: new Date(),
      });
      continue;
    }

    const inv = await db
      .insert(schema.cliInvocations)
      .values({
        taskId: params.taskId,
        taskStepId: current.id,
        cliProviderId: plan.providerId,
        mode: 'agent_mining',
        prompt: dispatch.prompt,
      })
      .returning();
    const invRow = inv[0];
    if (!invRow) throw new Error('failed to insert cli_invocations row for agent mining');

    const mining = await db
      .insert(schema.taskStepAgentMinings)
      .values({
        taskStepId: current.id,
        agentId: dispatch.agentId,
        agentTitle: dispatch.agentTitle,
        cliProviderId: plan.providerId,
        cliInvocationId: invRow.id,
        status: 'pending',
      })
      .returning();
    const miningRow = mining[0];
    if (!miningRow) throw new Error('failed to insert task_step_agent_minings row');

    await params.deps.enqueueCliInvocation({
      invocationId: invRow.id,
      taskId: params.taskId,
      taskStepId: current.id,
      userId: params.userId,
      cliProviderId: plan.providerId,
      kind: 'agent_mining',
      spec: plan.invocation.spec,
      timeoutMs: spec.timeoutMs,
      agentMiningId: miningRow.id,
    });
    if (plan.providerId && !recordedProviderId) {
      recordedProviderId = plan.providerId;
    }
  }

  if (recordedProviderId) {
    await recordStepCliPreference(db, params.userId, stepDef.metadata.id, recordedProviderId);
  }

  const updated = await updateRow(db, current.id, {
    status: 'waiting_cli',
    statusMessage: `Mining knowledge from ${dispatches.length} agent(s)...`,
  });
  ctx.logger.info(
    { dispatched: dispatches.length, agentIds: dispatches.map((d) => d.agentId) },
    'agent mining fan-out enqueued',
  );
  return { resolved: false, result: { status: 'waiting_cli', row: updated } };
}

const CANCEL_POLL_INTERVAL_MS = 2_000;

export async function advanceStep(params: AdvanceStepParams): Promise<AdvanceStepResult> {
  const { db, stepDef, taskId } = params;
  const meta = stepDef.metadata;

  const row = await upsertRow(db, taskId, stepDef);

  const controller = new AbortController();
  const throwIfCancelled = (): void => {
    if (controller.signal.aborted) {
      throw new TaskCancelledError();
    }
  };
  const pollTimer = setInterval(() => {
    void (async () => {
      try {
        const statusRow = await db.query.tasks.findFirst({
          where: eq(schema.tasks.id, taskId),
          columns: { status: true },
        });
        if (statusRow?.status === 'cancelled') {
          controller.abort();
        }
      } catch (err) {
        log.warn({ err, taskId }, 'cancel poll failed');
      }
    })();
  }, CANCEL_POLL_INTERVAL_MS);

  const ctx: StepContext = {
    taskId,
    taskStepId: row.id,
    userId: params.userId,
    repoPath: params.repoPath,
    workspacePath: params.workspacePath,
    sandboxWorkdir: SANDBOX_WORKDIR,
    cliProviderId: params.cliProviderId,
    db,
    logger: log.child({ stepId: meta.id, taskId, taskStepId: row.id }),
    signal: controller.signal,
    throwIfCancelled,
    async emitProgress(message: string) {
      await updateRow(db, row.id, { statusMessage: message });
    },
  };

  try {
    if (stepDef.shouldRun) {
      const should = await stepDef.shouldRun(ctx);
      if (!should) {
        const updated = await updateRow(db, row.id, {
          status: 'skipped',
          endedAt: new Date(),
        });
        return { status: 'skipped', row: updated };
      }
    }

    let current = row;
    if (current.status === 'pending') {
      current = await updateRow(db, current.id, {
        status: 'running',
        startedAt: new Date(),
      });
    }

    let detected = current.detectOutput;
    if (detected === null || detected === undefined) {
      detected = stepDef.detect ? await stepDef.detect(ctx) : null;
      current = await updateRow(db, current.id, { detectOutput: detected, statusMessage: null });
    }

    // --- Pre-form LLM phase ---
    let llmOutput: unknown = undefined;
    if (stepDef.llm?.preForm) {
      const skip = stepDef.llm.skipIf?.({ detected, formValues: {} }) ?? false;
      if (skip) {
        ctx.logger.info({ phase: 'llm.preForm' }, 'skipping llm phase via skipIf predicate');
      } else {
        const llmResult = await resolveLlmPhase(db, stepDef, current, ctx, detected, null, params);
        if (!llmResult.resolved) return llmResult.result;
        llmOutput = llmResult.llmOutput;
        current = llmResult.current;
      }
    }

    // --- Form ---
    let persistedSchema: FormSchema | null = (current.formSchema as FormSchema | null) ?? null;
    if (!persistedSchema && stepDef.form) {
      persistedSchema = stepDef.form(ctx, detected, llmOutput);
      current = await updateRow(db, current.id, {
        formSchema: persistedSchema ?? null,
        statusMessage: null,
      });
    }

    let formValues = current.formValues as FormValues | null;
    if (persistedSchema && !formValues && !params.formValues) {
      current = await updateRow(db, current.id, { status: 'waiting_form' });
      return {
        status: 'waiting_form',
        row: current,
        formSchema: persistedSchema,
      };
    }

    if (persistedSchema && params.formValues) {
      const validation = validateFormValues(persistedSchema, params.formValues);
      if (!validation.success) {
        const failed = await updateRow(db, current.id, {
          status: 'failed',
          errorMessage: `validation failed: ${validation.issues.join('; ')}`,
          endedAt: new Date(),
        });
        return {
          status: 'failed',
          row: failed,
          error: validation.issues.join('; '),
        };
      }
      formValues = validation.data;
      current = await updateRow(db, current.id, {
        formValues,
        status: 'running',
      });
    }

    // --- Post-form LLM phase (default) ---
    if (stepDef.llm && !stepDef.llm.preForm) {
      const skip = stepDef.llm.skipIf?.({ detected, formValues: formValues ?? {} }) ?? false;
      if (skip) {
        ctx.logger.info({ phase: 'llm.postForm' }, 'skipping llm phase via skipIf predicate');
      } else {
        const llmResult = await resolveLlmPhase(
          db,
          stepDef,
          current,
          ctx,
          detected,
          formValues,
          params,
        );
        if (!llmResult.resolved) return llmResult.result;
        llmOutput = llmResult.llmOutput;
        current = llmResult.current;
      }
    }

    // --- Agent mining phase (fan-out N CLI jobs, wait for all) ---
    let agentMiningResults: AgentMiningResult[] | undefined;
    if (stepDef.agentMining) {
      const miningResult = await resolveAgentMiningPhase(
        db,
        stepDef,
        current,
        ctx,
        detected,
        formValues,
        llmOutput,
        params,
      );
      if (!miningResult.resolved) return miningResult.result;
      agentMiningResults = miningResult.results;
      current = miningResult.current;
    }

    const previousIterations = stepIterationsAsRecords(current);
    const iteration = previousIterations.length;
    const output = await stepDef.apply(ctx, {
      detected,
      formValues: formValues ?? {},
      llmOutput,
      agentMiningResults,
      iteration,
      previousIterations,
    });

    // --- Loop hook: decide whether another LLM pass is warranted ---
    if (stepDef.loop) {
      const budget = (await resolveLoopBudget(db, taskId, current, stepDef)) ?? 1;
      const continueRequested = await stepDef.loop.shouldContinue({
        ctx,
        applyOutput: output,
        llmOutput,
        iteration,
        previousIterations,
      });
      const nextIteration = iteration + 1;
      const exhaustedBudget = continueRequested && nextIteration >= budget;
      // Mark this pass's invocation consumed so the next resolveLlmPhase
      // (whether triggered now for the next pass or later for retries)
      // enqueues a fresh CLI run instead of replaying the same output.
      await markLatestInvocationConsumed(db, current.id);
      const newEntry: StepIterationEntry = {
        iteration,
        llmOutput,
        applyOutput: output,
        continueRequested,
        recordedAt: new Date().toISOString(),
        ...(exhaustedBudget ? { exhaustedBudget: true } : {}),
      };
      const newIterations = [...(current.iterations ?? []), newEntry] as StepIterationEntry[];
      current = await updateRow(db, current.id, {
        iterations: newIterations,
        iterationCount: newIterations.length,
        statusMessage: null,
      });
      ctx.logger.info(
        { iteration, continueRequested, budget, exhaustedBudget },
        'loop pass completed',
      );
      if (continueRequested && !exhaustedBudget) {
        // Re-enter LLM phase to enqueue iteration N+1. This single
        // recursive resolveLlmPhase call (a) inserts a fresh
        // cli_invocations row, (b) flips status to waiting_cli, and
        // (c) returns. The orchestrator picks up where we left off when
        // that invocation completes.
        const llmResult = await resolveLlmPhase(
          db,
          stepDef,
          current,
          ctx,
          detected,
          formValues,
          params,
        );
        if (!llmResult.resolved) return llmResult.result;
        // Shouldn't reach here — resolveLlmPhase always returns
        // unresolved (waiting_cli) for fresh enqueues.
        ctx.logger.warn(
          { iteration: nextIteration },
          'loop re-enter resolved synchronously; falling through to done',
        );
      }
    }

    const done = await updateRow(db, current.id, {
      status: 'done',
      output,
      statusMessage: null,
      endedAt: new Date(),
    });

    return { status: 'done', row: done, output };
  } catch (err) {
    const cancelled = err instanceof TaskCancelledError;
    const errorMessage = cancelled
      ? 'task cancelled by user'
      : err instanceof Error
        ? err.message
        : String(err);
    if (cancelled) {
      log.info({ stepId: meta.id, taskId }, 'step aborted by task cancel');
    } else {
      log.error({ err, stepId: meta.id, taskId }, 'step runner failed');
    }
    const failed = await updateRow(db, row.id, {
      status: 'failed',
      statusMessage: null,
      errorMessage,
      endedAt: new Date(),
    }).catch(() => row);
    return { status: 'failed', row: failed, error: errorMessage };
  } finally {
    clearInterval(pollTimer);
    if (!controller.signal.aborted) controller.abort();
  }
}

const WORKFLOW_TYPE_OFFSETS: Record<string, number> = {
  onboarding: 0,
  env_replicate: 0,
  workflow: 100,
};

export function computeGlobalStepIndex(workflowType: string, index: number): number {
  const offset = WORKFLOW_TYPE_OFFSETS[workflowType] ?? 0;
  return offset + index;
}

async function upsertRow(
  db: Database,
  taskId: string,
  stepDef: StepDefinition,
): Promise<TaskStepRow> {
  const meta = stepDef.metadata;
  const existing = await db
    .select()
    .from(schema.taskSteps)
    .where(and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, meta.id)))
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db
    .insert(schema.taskSteps)
    .values({
      taskId,
      stepId: meta.id,
      stepIndex: computeGlobalStepIndex(meta.workflowType, meta.index),
      title: meta.title,
      status: 'pending',
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error('Failed to insert task step row');
  return row;
}

async function updateRow(db: Database, id: string, patch: UpdatePatch): Promise<TaskStepRow> {
  const rows = await db
    .update(schema.taskSteps)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.taskSteps.id, id))
    .returning();
  const row = rows[0];
  if (!row) throw new Error(`Task step ${id} not found`);
  return row;
}

/** Read the step's persisted iterations array as the lighter-weight
 *  StepLoopPassRecord shape exposed to step modules. Strips bookkeeping
 *  fields (continueRequested flag stays since loop modules want it). */
function stepIterationsAsRecords(row: TaskStepRow): StepLoopPassRecord[] {
  const rows = (row.iterations ?? []) as StepIterationEntry[];
  return rows.map((entry) => ({
    iteration: entry.iteration,
    llmOutput: entry.llmOutput,
    applyOutput: entry.applyOutput,
    continueRequested: entry.continueRequested,
  }));
}

/** Resolve the max-iterations budget for a loop step. Precedence:
 *   1. The step's formValues.maxIterations — the in-form selector wins so
 *      the user can change the budget on retry without touching the task.
 *   2. tasks.step_loop_limits[stepId] — set at task creation time from
 *      the new-task form selector.
 *   3. loopSpec.maxIterations — built-in default when neither override
 *      exists.
 *  Returns null if the step has no loop hook at all. */
async function resolveLoopBudget(
  db: Database,
  taskId: string,
  current: TaskStepRow,
  stepDef: StepDefinition,
): Promise<number | null> {
  if (!stepDef.loop) return null;
  const formValues = (current.formValues ?? {}) as Record<string, unknown>;
  const formOverride = formValues.maxIterations;
  if (typeof formOverride === 'number' && formOverride > 0) return formOverride;
  if (typeof formOverride === 'string') {
    const parsed = Number.parseInt(formOverride, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { stepLoopLimits: true },
  });
  const limits = (task?.stepLoopLimits ?? {}) as Record<string, number>;
  const override = limits[stepDef.metadata.id];
  if (typeof override === 'number' && override > 0) return override;
  return stepDef.loop.maxIterations;
}

/** Mark the currently-active LLM invocation row as consumed so the next
 *  resolveLlmPhase pass enqueues a fresh one. No-op when the step has no
 *  unconsumed invocation (already-consumed paths or steps without llm). */
async function markLatestInvocationConsumed(db: Database, taskStepId: string): Promise<void> {
  const row = await db
    .select({ id: schema.cliInvocations.id })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskStepId, taskStepId),
        isNull(schema.cliInvocations.supersededAt),
        isNull(schema.cliInvocations.consumedAt),
        ne(schema.cliInvocations.mode, 'agent_mining'),
      ),
    )
    .orderBy(desc(schema.cliInvocations.createdAt))
    .limit(1);
  const invId = row[0]?.id;
  if (!invId) return;
  await db
    .update(schema.cliInvocations)
    .set({ consumedAt: new Date() })
    .where(eq(schema.cliInvocations.id, invId));
}

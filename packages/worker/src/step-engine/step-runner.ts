import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema, type StepIterationEntry } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  extractFormDefaults,
  logger,
  validateFormValues,
} from '@haive/shared';
import type {
  CliExecInvocationKind,
  CliExecJobPayload,
  FormField,
  FormSchema,
  FormValues,
  LeafFormField,
  StepStatus,
} from '@haive/shared';
import type { CliProviderRecord } from '../cli-adapters/types.js';
import { resolveDispatch, type DispatchPlan } from '../orchestrator/dispatcher.js';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import {
  TaskCancelledError,
  type AgentMiningResult,
  type StepContext,
  type StepDefinition,
  type StepLoopPassRecord,
} from './step-definition.js';
import { resolveDagPhase } from './dag-executor.js';
import { isFixLoopSuppressed } from './steps/workflow/_fix-loop.js';

const log = logger.child({ module: 'step-runner' });

export type TaskStepRow = typeof schema.taskSteps.$inferSelect;

/** Returns the user's explicit per-step CLI override (set via the task UI),
 *  validated as enabled. Falls back to the task default when no explicit
 *  override exists or the override's provider is disabled/deleted. Legacy
 *  auto-recorded rows (explicit=false) are ignored so the task provider wins. */
export async function resolvePreferredCli(
  db: Database,
  userId: string,
  stepId: string,
  fallback: string | null,
  providers: { id: string; enabled: boolean }[],
  role: string = 'default',
): Promise<string | null> {
  // Named roles (e.g. reviewer/corrector) first consult the per-role table; an
  // unset/disabled role falls through to the step's single 'default' pref, then
  // to the task provider, so partially-configured multi-CLI steps still run.
  if (role !== 'default') {
    const roleRow = await db.query.userStepCliRolePreferences.findFirst({
      where: and(
        eq(schema.userStepCliRolePreferences.userId, userId),
        eq(schema.userStepCliRolePreferences.stepId, stepId),
        eq(schema.userStepCliRolePreferences.role, role),
        eq(schema.userStepCliRolePreferences.explicit, true),
      ),
    });
    if (roleRow) {
      const p = providers.find((p) => p.id === roleRow.cliProviderId);
      if (p && p.enabled) return roleRow.cliProviderId;
    }
  }
  const row = await db.query.userStepCliPreferences.findFirst({
    where: and(
      eq(schema.userStepCliPreferences.userId, userId),
      eq(schema.userStepCliPreferences.stepId, stepId),
      eq(schema.userStepCliPreferences.explicit, true),
    ),
  });
  if (!row) return fallback;
  const provider = providers.find((p) => p.id === row.cliProviderId);
  if (!provider || !provider.enabled) return fallback;
  return row.cliProviderId;
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
  /** Fix-loop round to materialize/run the step at (default 0 = original pass). */
  round?: number;
  formValues?: FormValues;
  providers?: CliProviderRecord[];
  deps?: WorkerDeps;
}

export type AdvanceStepResult =
  | { status: 'done'; row: TaskStepRow; output: unknown }
  | { status: 'waiting_form'; row: TaskStepRow; formSchema: FormSchema }
  | { status: 'waiting_cli'; row: TaskStepRow }
  | { status: 'skipped'; row: TaskStepRow }
  | {
      status: 'loop_back';
      row: TaskStepRow;
      diagnosis: string;
      sourceStepId: string;
      /** When true the loop_back skips the max_fix_rounds cap + escalation gate (a
       *  human-driven restart, e.g. gate-2 developer reject). Omitted = capped. */
      uncapped?: boolean;
    }
  | { status: 'revise'; row: TaskStepRow; targetStepId: string; sourceStepId: string }
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
  aiFixContext: { priorError: string; priorOutput: string } | null;
  startedAt: Date;
  endedAt: Date;
}>;

type LlmResolved =
  | { resolved: true; llmOutput: unknown; current: TaskStepRow }
  | { resolved: false; result: AdvanceStepResult };

const IN_STACK_OLLAMA_HOSTS = new Set(['ollama', 'haive-ollama', 'localhost', '127.0.0.1']);

/** True when the resolved provider is an in-stack (local) Ollama model. Cloud
 *  (ollama.com) and external remote Ollama, and every non-Ollama provider, are
 *  not "local" and are never blocked. */
function isLocalOllama(provider: CliProviderRecord | null): boolean {
  if (!provider || provider.name !== 'ollama') return false;
  const baseUrl = provider.envVars?.ANTHROPIC_BASE_URL ?? 'http://ollama:11434';
  try {
    return IN_STACK_OLLAMA_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return true; // unset/malformed → the adapter default is the in-stack daemon
  }
}

/** Guard a step flagged `unsafeForLocalModels` against a local Ollama model (it
 *  rewrites long-lived files where weak models are dangerous). Returns a failed
 *  AdvanceStepResult to short-circuit when blocked; null to proceed. The
 *  ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS config flag downgrades the block to a
 *  warning. Cloud/remote Ollama and all other providers always pass. */
async function enforceLocalModelGuard(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  plan: DispatchPlan,
): Promise<AdvanceStepResult | null> {
  if (!stepDef.metadata.unsafeForLocalModels || !isLocalOllama(plan.provider)) return null;
  let allow = false;
  try {
    allow = await configService.getBoolean(CONFIG_KEYS.ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS, false);
  } catch {
    // Config store unavailable (e.g. not initialized) → safe default: block.
    allow = false;
  }
  if (allow) {
    ctx.logger.warn(
      { stepId: stepDef.metadata.id, providerId: plan.providerId },
      'local Ollama model running a destructive step (ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS override)',
    );
    return null;
  }
  const msg =
    `Step "${stepDef.metadata.id}" rewrites long-lived project files and is blocked for ` +
    `local Ollama models (low reliability for this work). Pick a commercial provider — or ` +
    `cloud/remote Ollama — for this step, or set ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS=true to override.`;
  const failed = await updateRow(db, current.id, {
    status: 'failed',
    errorMessage: msg,
    endedAt: new Date(),
  });
  return { status: 'failed', row: failed, error: msg };
}

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
      // Best-effort LLM (e.g. gate-1 config recommendation): a failed invocation
      // must not fail the step. Degrade to null output and reuse this failed row
      // on re-entry (no re-dispatch) so downstream phases fall back to defaults.
      if (llmSpec.optional) {
        ctx.logger.warn({ phase: 'llm' }, 'optional llm invocation failed; degrading to null');
        return { resolved: true, llmOutput: null, current };
      }
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
    // Best-effort LLM with no providers available: skip rather than fail.
    if (llmSpec.optional) {
      return { resolved: true, llmOutput: null, current };
    }
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

  // Optional async setup the invocation depends on (e.g. 08a starting the
  // runner's headed browser so chrome-devtools MCP can connect). Idempotent;
  // a throw here fails the step like any dispatch error.
  if (llmSpec.prepare) {
    await llmSpec.prepare({ ctx, detected, formValues: formValues ?? {} });
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
  // Multi-CLI loop steps pick a role per iteration (e.g. reviewer vs corrector);
  // the resolved provider differs per role. Non-loop steps resolve 'default'.
  const role = stepDef.loop?.resolveRole?.(upcomingIteration) ?? 'default';
  const preferredProviderId = await resolvePreferredCli(
    db,
    params.userId,
    stepDef.metadata.id,
    params.cliProviderId ?? null,
    params.providers,
    role,
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

  const guard = await enforceLocalModelGuard(db, stepDef, current, ctx, plan);
  if (guard) return { resolved: false, result: guard };

  const mode = plan.mode === 'subagent_emulated' ? 'subagent_emulated' : 'cli';
  // For multi-CLI loop steps, label the invocation with its role (Validator /
  // Fixer / Reviewer / Corrector / …) so the terminal header shows which pass it is.
  const roleLabel =
    role !== 'default'
      ? (stepDef.metadata.cliRoles?.find((r) => r.id === role)?.label ?? null)
      : null;
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
      agentTitle: roleLabel,
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

/** AI-assisted retry: when the retry_ai action set `aiFixContext` on the step,
 *  run a diagnose-and-fix agent once (reusing the cli-invocation lifecycle), then
 *  clear the marker so apply re-runs against the fixed workspace. Designed for
 *  deterministic steps (the agent fixes the repo/env; the step re-runs itself). */
async function resolveAiFixPhase(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  params: AdvanceStepParams,
): Promise<
  { resolved: true; current: TaskStepRow } | { resolved: false; result: AdvanceStepResult }
> {
  const fixCtx = current.aiFixContext as { priorError: string; priorOutput: string } | null;
  if (!fixCtx) return { resolved: true, current };

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
    // The fix agent finished (whether or not it succeeded). Consume it + clear
    // the marker, then let apply re-run against whatever the agent changed. If
    // the fix didn't help, apply fails again and re-surfaces the error.
    await markLatestInvocationConsumed(db, current.id);
    const updated = await updateRow(db, current.id, { aiFixContext: null });
    return { resolved: true, current: updated };
  }
  if (invocation && invocation.endedAt === null) {
    return { resolved: false, result: { status: 'waiting_cli', row: current } };
  }

  if (!params.providers || !params.deps) {
    const failed = await updateRow(db, current.id, {
      status: 'failed',
      errorMessage: 'retry_ai requires a CLI provider but none is available',
      aiFixContext: null,
      endedAt: new Date(),
    });
    return {
      resolved: false,
      result: { status: 'failed', row: failed, error: failed.errorMessage ?? 'no provider' },
    };
  }

  const prompt = [
    'A workflow step just failed. Diagnose the root cause and FIX it by editing files in the workspace so the step can succeed when it re-runs.',
    `Step: ${stepDef.metadata.id} (${stepDef.metadata.title}).`,
    '',
    `Failure error:\n${fixCtx.priorError || '(none recorded)'}`,
    fixCtx.priorOutput ? `\nOutput tail:\n${fixCtx.priorOutput}` : '',
    '',
    'Make minimal, correct edits. The step re-runs automatically after you finish — do NOT run it yourself. When done, stop.',
  ].join('\n');

  const preferredProviderId = await resolvePreferredCli(
    db,
    params.userId,
    stepDef.metadata.id,
    params.cliProviderId ?? null,
    params.providers,
    'default',
  );
  const plan = resolveDispatch({
    providers: params.providers,
    preferredProviderId,
    input: { kind: 'prompt', prompt, capabilities: ['tool_use', 'file_write'] },
    invokeOpts: { cwd: params.workspacePath },
  });
  if (plan.mode === 'skip' || !plan.invocation) {
    const failed = await updateRow(db, current.id, {
      status: 'failed',
      errorMessage: `retry_ai: no cli provider available: ${plan.reason}`,
      aiFixContext: null,
      endedAt: new Date(),
    });
    return {
      resolved: false,
      result: { status: 'failed', row: failed, error: failed.errorMessage ?? plan.reason },
    };
  }

  const fixGuard = await enforceLocalModelGuard(db, stepDef, current, ctx, plan);
  if (fixGuard) return { resolved: false, result: fixGuard };

  const fixMode = plan.mode === 'subagent_emulated' ? 'subagent_emulated' : 'cli';
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
      mode: fixMode,
      prompt,
    })
    .returning();
  const invRow = inserted[0];
  if (!invRow) throw new Error('failed to insert ai-fix cli_invocations row');
  await params.deps.enqueueCliInvocation({
    invocationId: invRow.id,
    taskId: params.taskId,
    taskStepId: current.id,
    userId: params.userId,
    cliProviderId: plan.providerId,
    kind: payloadKind,
    spec: plan.invocation.spec,
    timeoutMs: 30 * 60 * 1000,
  });
  const updated = await updateRow(db, current.id, {
    status: 'waiting_cli',
    statusMessage: 'AI diagnosing the failure…',
  });
  ctx.logger.info(
    { invocationId: invRow.id, providerId: plan.providerId },
    'ai-fix agent enqueued',
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
  const round = params.round ?? 0;

  const row = await upsertRow(db, taskId, stepDef, round);

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
    round,
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
    // Auto-continue flag + gate-1 pre-answers for this step. One indexed PK
    // lookup; a missing row (unit-test fixtures) behaves like autoContinue=true
    // with no pre-answers, i.e. today's behavior.
    const taskFlags = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { autoContinue: true, preAnswers: true },
    });
    const autoContinue = taskFlags?.autoContinue ?? true;
    const stepPreAnswer = (taskFlags?.preAnswers ?? {})[meta.id];

    let persistedSchema: FormSchema | null = (current.formSchema as FormSchema | null) ?? null;
    if (!persistedSchema && stepDef.form) {
      persistedSchema = stepDef.form(ctx, detected, llmOutput);
      // Pre-answers render as pre-filled defaults whenever this form DOES stop
      // (manual mode, or auto mode falling back after a validation miss).
      if (persistedSchema && stepPreAnswer) {
        persistedSchema = overlayPreAnswerDefaults(persistedSchema, stepPreAnswer);
      }
      current = await updateRow(db, current.id, {
        formSchema: persistedSchema ?? null,
        statusMessage: null,
      });
    }

    // Manual mode: EVERY step pauses before apply. Formless steps get a
    // synthesized confirm-only schema so the existing waiting_form plumbing
    // (submit endpoint, events, idle bookkeeping, web renderer) works
    // unchanged; submitting it posts {} which validates against zero fields.
    if (!persistedSchema && !autoContinue && !current.formValues && !params.formValues) {
      persistedSchema = synthesizeConfirmSchema(meta.title, meta.description);
      current = await updateRow(db, current.id, { formSchema: persistedSchema });
    }

    let formValues = current.formValues as FormValues | null;
    if (persistedSchema && !formValues && !params.formValues) {
      // Auto mode: (a) a gate-1 pre-answer for this step, else (b) {} for
      // zero-field info forms → try to auto-submit. A validation failure falls
      // through to waiting_form (never fails the step) — e.g. a pre-answered
      // browser mode that the runtime schema no longer offers. submitAction
      // 'retry' forms signal a broken precondition and are never auto-passed.
      // A form may opt to auto-submit even in manual mode (autoContinue off) via
      // its own `autoSubmit` flag — for an info-only form with nothing to decide
      // (e.g. 06b's single-agent decision).
      if (
        (autoContinue || persistedSchema.autoSubmit === true) &&
        (persistedSchema.submitAction ?? 'submit') === 'submit'
      ) {
        // Candidate precedence: a gate pre-answer wins; else a zero-field info
        // form auto-passes with {}; else a step that opts in via
        // metadata.autoSubmitDefaults (or the form's own autoSubmit) auto-submits
        // its declared field defaults.
        const candidate =
          stepPreAnswer ??
          (persistedSchema.fields.length === 0
            ? {}
            : meta.autoSubmitDefaults || persistedSchema.autoSubmit
              ? extractFormDefaults(persistedSchema)
              : undefined);
        if (candidate !== undefined) {
          const validation = validateFormValues(persistedSchema, candidate);
          if (validation.success) {
            formValues = validation.data;
            current = await updateRow(db, current.id, { formValues, status: 'running' });
            ctx.logger.info(
              {
                source: stepPreAnswer
                  ? 'pre_answer'
                  : persistedSchema.fields.length === 0
                    ? 'zero_field'
                    : 'step_defaults',
              },
              'auto-continue: form auto-submitted',
            );
          } else {
            ctx.logger.warn(
              { issues: validation.issues },
              'auto-continue: pre-answer failed validation; waiting for user',
            );
          }
        }
      }
      if (!formValues) {
        current = await updateRow(db, current.id, { status: 'waiting_form' });
        return {
          status: 'waiting_form',
          row: current,
          formSchema: persistedSchema,
        };
      }
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

    // --- AI-fix phase (retry_ai recovery) ---
    // When retry_ai set a fix marker, run a diagnose-and-fix agent once, then
    // re-run apply against the fixed workspace. The DAG executor is exempt: it
    // owns aiFixContext to resolve a merge conflict inside the integration
    // worktree (the generic agent would run at the repo root and would also
    // mis-consume a completed coder invocation). See resolveDagPhase.
    if (current.aiFixContext && !stepDef.dagExecute) {
      const fixResult = await resolveAiFixPhase(db, stepDef, current, ctx, params);
      if (!fixResult.resolved) return fixResult.result;
      current = fixResult.current;
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

    // --- DAG execution phase (multi-level coder fan-out; parks waiting_cli per
    // level until every level checkpoints, then apply finalizes the step) ---
    if (stepDef.dagExecute) {
      const dagResult = await resolveDagPhase(db, stepDef, current, ctx, params);
      if (!dagResult.resolved) return dagResult.result;
      current = dagResult.current;
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

    // --- Fix-loop hook: a downstream step that finds a BLOCKING defect routes back
    // to the implementation step for a new round instead of finishing the chain. The
    // step row is still marked done (it ran successfully and produced its findings);
    // handleResult turns the loop_back into a round bump + re-entry at implement. ---
    // Skip the loop-back once the user accepted remaining issues at the escalation
    // gate — every later fix-loop check stands down so the run proceeds to gate 2.
    if (stepDef.fixLoop && !(await isFixLoopSuppressed(db, taskId))) {
      const verdict = stepDef.fixLoop.evaluate(output);
      if (verdict?.blocking) {
        const finished = await updateRow(db, current.id, {
          status: 'done',
          output,
          statusMessage: null,
          endedAt: new Date(),
        });
        ctx.logger.info(
          { stepId: meta.id, round },
          'fix-loop: blocking defect found; routing back to implementation',
        );
        return {
          status: 'loop_back',
          row: finished,
          diagnosis: verdict.diagnosis,
          sourceStepId: meta.id,
        };
      }
    }

    // --- Restart-loop hook: a HUMAN gate (gate-2 developer reject after browser/manual
    // verification) that asks to restart from implementation. Like fixLoop it returns
    // loop_back — round bump + re-enter at implement, whole chain re-runs as new round
    // rows — but UNCAPPED and suppression-immune: the developer is the bound, not
    // max_fix_rounds, and a prior auto-fix Accept does not stand it down. ---
    if (stepDef.restartLoop) {
      const restart = stepDef.restartLoop.evaluate(output);
      if (restart) {
        const finished = await updateRow(db, current.id, {
          status: 'done',
          output,
          statusMessage: null,
          endedAt: new Date(),
        });
        ctx.logger.info(
          { stepId: meta.id, round },
          'restart-loop: human gate requested restart from implementation (uncapped)',
        );
        return {
          status: 'loop_back',
          row: finished,
          diagnosis: restart.diagnosis,
          sourceStepId: meta.id,
          uncapped: true,
        };
      }
    }

    // --- Revise-loop hook: a review step whose apply output asks to revise an EARLIER
    // step (e.g. 03c reject → re-mine 03b). The step row is marked done (it ran fine and
    // recorded its decision); handleResult resets the target + its downstream and
    // re-enters the target in the SAME round. Human-gated (the review form re-parks each
    // cycle), so unlike fix-loop there is no round bump and no cap. ---
    if (stepDef.reviseLoop) {
      const target = stepDef.reviseLoop.evaluate(output);
      if (target) {
        const finished = await updateRow(db, current.id, {
          status: 'done',
          output,
          statusMessage: null,
          endedAt: new Date(),
        });
        ctx.logger.info(
          { stepId: meta.id, targetStepId: target.targetStepId },
          'revise-loop: apply requested revising an earlier step',
        );
        return {
          status: 'revise',
          row: finished,
          targetStepId: target.targetStepId,
          sourceStepId: meta.id,
        };
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
    // Deterministic fix-loop steps (e.g. 07c) route a fixable thrown failure back to
    // implementation as a diagnosis instead of failing the task. handleResult enforces
    // the round cap; at the cap the task fails with this diagnosis.
    if (!cancelled && stepDef.fixLoopOnError) {
      const finished = await updateRow(db, row.id, {
        status: 'done',
        statusMessage: null,
        errorMessage,
        endedAt: new Date(),
      }).catch(() => row);
      log.info(
        { stepId: meta.id, taskId, round },
        'fix-loop: step error routed back to implementation',
      );
      return { status: 'loop_back', row: finished, diagnosis: errorMessage, sourceStepId: meta.id };
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
  kb_author: 300,
};

export function computeGlobalStepIndex(workflowType: string, index: number): number {
  const offset = WORKFLOW_TYPE_OFFSETS[workflowType] ?? 0;
  return offset + index;
}

async function upsertRow(
  db: Database,
  taskId: string,
  stepDef: StepDefinition,
  round: number,
): Promise<TaskStepRow> {
  const meta = stepDef.metadata;
  const existing = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, meta.id),
        eq(schema.taskSteps.round, round),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db
    .insert(schema.taskSteps)
    .values({
      taskId,
      stepId: meta.id,
      stepIndex: computeGlobalStepIndex(meta.workflowType, meta.index),
      round,
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
  // The configured budget is in ROUNDS; multiply by passesPerRound to get the
  // actual LLM-pass cap the loop enforces (default 1 → rounds == passes).
  const perRound = stepDef.loop.passesPerRound ?? 1;
  const formValues = (current.formValues ?? {}) as Record<string, unknown>;
  const formOverride = formValues.maxIterations;
  let rounds: number | null = null;
  if (typeof formOverride === 'number' && formOverride > 0) {
    rounds = formOverride;
  } else if (typeof formOverride === 'string') {
    const parsed = Number.parseInt(formOverride, 10);
    if (Number.isFinite(parsed) && parsed > 0) rounds = parsed;
  }
  if (rounds === null) {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { stepLoopLimits: true },
    });
    const limits = (task?.stepLoopLimits ?? {}) as Record<string, number>;
    const override = limits[stepDef.metadata.id];
    if (typeof override === 'number' && override > 0) rounds = override;
  }
  if (rounds === null) rounds = stepDef.loop.maxIterations;
  return rounds * perRound;
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

/** Writes a gate-1 pre-answer value into a leaf field's default so a form
 *  that still stops renders pre-filled. Values that don't fit the field
 *  (wrong type, option no longer offered) are left out rather than forced. */
function overlayLeafDefault(field: LeafFormField, pre: Record<string, unknown>): LeafFormField {
  if (!(field.id in pre)) return field;
  const v = pre[field.id];
  switch (field.type) {
    case 'checkbox':
      return typeof v === 'boolean' ? { ...field, default: v } : field;
    case 'text':
    case 'textarea':
    case 'select-with-text':
    case 'radio-with-textarea':
      return typeof v === 'string' ? { ...field, default: v } : field;
    case 'select':
    case 'radio':
      return typeof v === 'string' && field.options.some((o) => o.value === v)
        ? { ...field, default: v }
        : field;
    case 'multi-select': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return field;
      const allowed = new Set(field.options.map((o) => o.value));
      return { ...field, defaults: (v as string[]).filter((x) => allowed.has(x)) };
    }
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? { ...field, default: v } : field;
    default:
      return field;
  }
}

function overlayPreAnswerDefaults(schema: FormSchema, pre: Record<string, unknown>): FormSchema {
  return {
    ...schema,
    fields: schema.fields.map(
      (field): FormField =>
        field.type === 'accordion'
          ? {
              ...field,
              items: field.items.map((item) => ({
                ...item,
                fields: item.fields.map((leaf) => overlayLeafDefault(leaf, pre)),
              })),
            }
          : overlayLeafDefault(field, pre),
    ),
  };
}

/** Confirm-only schema for manual mode (task.autoContinue=false): formless
 *  steps pause on this so the user can review the run before apply. Submitting
 *  posts {} which validates against zero fields. */
function synthesizeConfirmSchema(title: string, description: string): FormSchema {
  return {
    title,
    description,
    fields: [],
    submitLabel: 'Continue',
  };
}

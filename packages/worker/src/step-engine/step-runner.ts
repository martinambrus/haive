import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
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
import type { StepContext, StepDefinition } from './step-definition.js';

const log = logger.child({ module: 'step-runner' });

export type TaskStepRow = typeof schema.taskSteps.$inferSelect;

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
  errorMessage: string | null;
  startedAt: Date;
  endedAt: Date;
}>;

export async function advanceStep(params: AdvanceStepParams): Promise<AdvanceStepResult> {
  const { db, stepDef, taskId } = params;
  const meta = stepDef.metadata;

  const row = await upsertRow(db, taskId, stepDef);

  const ctx: StepContext = {
    taskId,
    taskStepId: row.id,
    userId: params.userId,
    repoPath: params.repoPath,
    workspacePath: params.workspacePath,
    cliProviderId: params.cliProviderId,
    db,
    logger: log.child({ stepId: meta.id, taskId, taskStepId: row.id }),
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
      current = await updateRow(db, current.id, { detectOutput: detected });
    }

    let persistedSchema: FormSchema | null = (current.formSchema as FormSchema | null) ?? null;
    if (!persistedSchema && stepDef.form) {
      persistedSchema = stepDef.form(ctx, detected);
      current = await updateRow(db, current.id, {
        formSchema: persistedSchema ?? null,
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

    let llmOutput: unknown = undefined;
    if (stepDef.llm) {
      const latest = await db
        .select()
        .from(schema.cliInvocations)
        .where(eq(schema.cliInvocations.taskStepId, current.id))
        .orderBy(desc(schema.cliInvocations.createdAt))
        .limit(1);
      const invocation = latest[0];

      if (invocation && invocation.endedAt !== null) {
        if ((invocation.exitCode ?? 0) !== 0) {
          const message = invocation.errorMessage ?? `cli exited ${invocation.exitCode}`;
          const failed = await updateRow(db, current.id, {
            status: 'failed',
            errorMessage: `cli invocation failed: ${message}`,
            endedAt: new Date(),
          });
          return { status: 'failed', row: failed, error: message };
        }
        llmOutput = invocation.parsedOutput ?? invocation.rawOutput;
      } else if (invocation && invocation.endedAt === null) {
        return { status: 'waiting_cli', row: current };
      } else {
        if (!params.providers || !params.deps) {
          if (stepDef.llm.optional) {
            ctx.logger.warn('optional llm skipped; no providers or deps supplied');
            llmOutput = null;
          } else {
            const failed = await updateRow(db, current.id, {
              status: 'failed',
              errorMessage: 'step requires CLI invocation but no providers or deps supplied',
              endedAt: new Date(),
            });
            return {
              status: 'failed',
              row: failed,
              error: failed.errorMessage ?? 'missing worker deps',
            };
          }
        } else {
          const prompt = stepDef.llm.buildPrompt({
            detected,
            formValues: formValues ?? {},
          });
          const plan = resolveDispatch({
            providers: params.providers,
            preferredProviderId: params.cliProviderId ?? null,
            input: {
              kind: 'prompt',
              prompt,
              capabilities: stepDef.llm.requiredCapabilities,
            },
            invokeOpts: { cwd: params.workspacePath },
          });
          if (plan.mode === 'skip' || !plan.invocation) {
            if (stepDef.llm.optional) {
              ctx.logger.warn(
                { reason: plan.reason },
                'optional llm skipped; applying with null llmOutput',
              );
              llmOutput = null;
            } else {
              const failed = await updateRow(db, current.id, {
                status: 'failed',
                errorMessage: `no cli provider available: ${plan.reason}`,
                endedAt: new Date(),
              });
              return {
                status: 'failed',
                row: failed,
                error: failed.errorMessage ?? plan.reason,
              };
            }
          } else {
            const mode =
              plan.invocation.kind === 'api'
                ? 'api'
                : plan.mode === 'subagent_emulated'
                  ? 'subagent_emulated'
                  : 'cli';
            const payloadKind: CliExecInvocationKind =
              plan.invocation.kind === 'api'
                ? 'api'
                : plan.invocation.kind === 'subagent'
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
            });
            current = await updateRow(db, current.id, { status: 'waiting_cli' });
            ctx.logger.info(
              {
                invocationId: invRow.id,
                providerId: plan.providerId,
                mode: plan.mode,
              },
              'cli invocation enqueued',
            );
            return { status: 'waiting_cli', row: current };
          }
        }
      }
    }

    const output = await stepDef.apply(ctx, {
      detected,
      formValues: formValues ?? {},
      llmOutput,
    });

    const done = await updateRow(db, current.id, {
      status: 'done',
      output,
      endedAt: new Date(),
    });

    return { status: 'done', row: done, output };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err, stepId: meta.id, taskId }, 'step runner failed');
    const failed = await updateRow(db, row.id, {
      status: 'failed',
      errorMessage,
      endedAt: new Date(),
    }).catch(() => row);
    return { status: 'failed', row: failed, error: errorMessage };
  }
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
      stepIndex: meta.index,
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

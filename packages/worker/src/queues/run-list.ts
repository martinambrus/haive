import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { ExecutionPath, WorkflowType } from '@haive/shared';
import { parseStepId, type PromptStepEntry } from '@haive/shared/modularity';
import { orderWorkflowRunList } from '../orchestrator/execution-paths.js';
import { stepRegistry, UnresolvedStepError, type StepRegistry } from '../step-engine/registry.js';
import type { StepDefinition } from '../step-engine/step-definition.js';
import { buildPromptStep } from '../step-engine/steps/custom/prompt-step.js';
import { getTaskEnvTemplate } from '../step-engine/steps/env-replicate/_shared.js';
import { FIX_LOOP_TARGET_STEP_ID } from '../step-engine/steps/workflow/_fix-loop.js';
import { builtinTaskTypeRows } from '../step-engine/task-type-seed.js';

export type FixLoopDef = NonNullable<typeof schema.taskTypeDefinitions.$inferSelect.fixLoop>;

export interface ResolvedTaskContext {
  taskId: string;
  userId: string;
  workflowType: WorkflowType;
  repoPath: string;
  workspacePath: string;
  cliProviderId: string | null;
  ignoreSavedStepClis: boolean;
  /** Execution path recorded by 00-triage; null pre-triage and on legacy rows. */
  executionPath: ExecutionPath | null;
  metadata: Record<string, unknown> | null;
  /** Current orchestration generation; advance-step jobs from an older epoch are
   *  skipped as stale (see handleAdvanceStep). */
  orchestrationEpoch: number;
  /** The step the orchestrator considers current. Every legitimate advance targets it:
   *  the forward walk and every loop-back/revise path call markTaskRunningWithStep before
   *  enqueueing, and the api step actions repoint it (and bump the epoch) in the same
   *  transaction. An advance for a different step at the SAME epoch is therefore a second
   *  orchestration loop for one task. Null on a task that has not advanced yet. */
  currentStepId: string | null;
  currentRound: number;
  /** Task status as of job pickup. A `cancelled`/`completed` task must never be advanced —
   *  cancel leaves its already-queued advance jobs in place, so this is what stops them. */
  status: string;
  /** When the task last ended: on a failed task, when it failed. */
  completedAt: Date | null;
  runListStrategy: 'static' | 'workflow_paths' | 'run_app_modes';
  runListSnapshot: string[] | null;
  /** The prompt steps this task pinned at create, by step id (tasks.custom_steps, invalid entries dropped). */
  customSteps?: Record<string, PromptStepEntry>;
  fixLoop?: FixLoopDef | null;
  /** When the task was marked dead (see markTaskDead); null on a live task. */
  deadAt?: Date | null;
}

export { parsePinnedCustomSteps as parseCustomSteps } from '@haive/shared/modularity';

const SYNTHESISED_STEP_LIMIT = 256;
const synthesisedSteps = new Map<string, StepDefinition>();

type TaskStepScope = Partial<
  Pick<ResolvedTaskContext, 'taskId' | 'customSteps' | 'runListSnapshot'>
>;

/** The step a task runs under an id. A core or module id comes from the registry; a `custom.*` id is
 *  built from the entry this task pinned, so no registry holds it and an edit never reaches a task. */
export function resolveTaskStep(
  ctx: TaskStepScope,
  stepId: string,
  registry: Pick<StepRegistry, 'get'> = stepRegistry,
): StepDefinition | undefined {
  if (parseStepId(stepId)?.kind !== 'custom') return registry.get(stepId);
  const entry = ctx.customSteps?.[stepId];
  if (!entry) return undefined;
  const key = ctx.taskId === undefined ? null : `${ctx.taskId}|${stepId}`;
  const known = key === null ? undefined : synthesisedSteps.get(key);
  if (known) return known;
  const position = ctx.runListSnapshot?.indexOf(stepId) ?? -1;
  const def = buildPromptStep(stepId, entry, Math.max(position, 0));
  if (key !== null) {
    if (synthesisedSteps.size >= SYNTHESISED_STEP_LIMIT) {
      synthesisedSteps.delete(synthesisedSteps.keys().next().value!);
    }
    synthesisedSteps.set(key, def);
  }
  return def;
}

export function requireTaskStep(
  ctx: TaskStepScope,
  stepId: string,
  registry: Pick<StepRegistry, 'get'> = stepRegistry,
): StepDefinition {
  const def = resolveTaskStep(ctx, stepId, registry);
  if (!def) throw new UnresolvedStepError([stepId]);
  return def;
}

/** A static task's run list, split into the steps that resolve and the ids that do not. A task
 *  created before run-list snapshots existed has none and keeps the live list. */
export function resolveRunList(
  ctx: Pick<ResolvedTaskContext, 'workflowType' | 'runListSnapshot'> & TaskStepScope,
  registry: Pick<StepRegistry, 'get' | 'listByWorkflow'> = stepRegistry,
): { steps: StepDefinition[]; unresolved: string[] } {
  if (!ctx.runListSnapshot) {
    return { steps: registry.listByWorkflow(ctx.workflowType), unresolved: [] };
  }
  const steps: StepDefinition[] = [];
  const unresolved: string[] = [];
  for (const id of ctx.runListSnapshot) {
    const def = resolveTaskStep(ctx, id, registry);
    if (def) steps.push(def);
    else unresolved.push(id);
  }
  return { steps, unresolved };
}

export async function buildRunList(
  ctx: ResolvedTaskContext,
  db: Database,
): Promise<StepDefinition[]> {
  // run_app assembles its own mode-aware list from steps reused BY ID (there is no
  // full registered list for the type — only the 99-run-app-ready gate is native).
  if (ctx.runListStrategy === 'run_app_modes') return buildRunAppRunList(ctx, db);
  if (ctx.runListStrategy === 'workflow_paths') {
    const main = stepRegistry.listByWorkflow('workflow');
    const prelude = stepRegistry.listByWorkflow('env_replicate');
    // The model-health canary runs first (a dead model fails loudly before any path is
    // chosen — the path is moot when no model can run it), then 00-triage, both ahead of
    // the env-replicate prelude so the path is chosen up front; execution_path (null
    // pre-triage / on legacy rows) then trims the workflow steps to the chosen path. The
    // ordering + filtering is a pure helper in orchestrator/execution-paths.ts so it can
    // be unit-tested. Safe with the forward walk because every path set contains the
    // canary + triage + the spine, so the just-finished step is always present in the
    // filtered list.
    return orderWorkflowRunList(main, prelude, ctx.executionPath);
  }
  const { steps, unresolved } = resolveRunList(ctx);
  if (unresolved.length > 0) throw new UnresolvedStepError(unresolved);
  return steps;
}

export async function taskTypeRuntimeFor(
  db: Database,
  slug: string,
): Promise<Pick<ResolvedTaskContext, 'runListStrategy' | 'fixLoop'>> {
  const row = await db.query.taskTypeDefinitions.findFirst({
    where: eq(schema.taskTypeDefinitions.slug, slug),
  });
  if (row) return { runListStrategy: row.runListStrategy, fixLoop: row.fixLoop ?? null };
  // Smokes and a fresh install run worker code on a database the boot never seeded.
  const builtin = builtinTaskTypeRows(stepRegistry).find((r) => r.slug === slug);
  if (!builtin) throw new Error(`task type ${slug} has no definition`);
  return { runListStrategy: builtin.runListStrategy, fixLoop: null };
}

export function resolveFixLoopTarget(args: {
  taskType: string;
  fixLoop: FixLoopDef | null | undefined;
  runList: readonly StepDefinition[];
  registry: Pick<StepRegistry, 'get'>;
}): { ok: true; def: StepDefinition } | { ok: false; reason: string } {
  const targetId = args.fixLoop?.targetStepId ?? FIX_LOOP_TARGET_STEP_ID;
  // Only 07 reads the recorded fix_loop.requested diagnosis; another target would re-run blind.
  if (targetId !== FIX_LOOP_TARGET_STEP_ID) {
    return {
      ok: false,
      reason: `fix loop target ${targetId} of task type ${args.taskType} cannot read the fix diagnosis; only ${FIX_LOOP_TARGET_STEP_ID} can`,
    };
  }
  const def = args.registry.get(targetId);
  if (def && args.runList.some((s) => s.metadata.id === targetId)) return { ok: true, def };
  return {
    ok: false,
    reason: `fix loop target ${targetId} is not in the run list of task type ${args.taskType}`,
  };
}

/** Assemble a run_app task's run list. The env + runtime steps are reused BY ID
 *  from the workflow / env-replicate sets; the runtime tail is chosen from the
 *  container tool 01-declare-deps persisted into the env template. Before declare-
 *  deps has run the tool is unknown, so the tail is empty and is filled in on the
 *  next rebuild (handleResult rebuilds the list after every step). The prefix
 *  [declare-deps, worktree-setup, debug-mode] is stable and 99-run-app-ready is
 *  always last, so the forward walk (findIndex(stepId)+1) stays correct as the tail
 *  grows. 01-debug-mode precedes the runtime (it self-skips when the global debug
 *  kill-switch is off) so a run_app session — the prime "run it and poke at it"
 *  surface — can opt into step-debugging before DDEV / the app-runner comes up.
 *  98-choose-view ALSO precedes the runtime (not just 99-run-app-ready): the
 *  VNC-vs-own-browser choice writes tasks.direct_access, which the runner reads at
 *  CREATE to decide host-port publishing (fixed at cold boot, never reconfigured) —
 *  mirrors 01d-browser-access in the workflow pipeline. */
async function buildRunAppRunList(
  ctx: ResolvedTaskContext,
  db: Database,
): Promise<StepDefinition[]> {
  const prefix = [
    stepRegistry.require('01-declare-deps'),
    stepRegistry.require('01-worktree-setup'),
    stepRegistry.require('01-debug-mode'),
  ];
  const chooseView = stepRegistry.require('98-choose-view');
  const ready = stepRegistry.require('99-run-app-ready');

  const envTemplate = await getTaskEnvTemplate(db, ctx.taskId);
  const containerTool = (envTemplate?.declaredDeps as { containerTool?: string } | null | undefined)
    ?.containerTool;

  if (containerTool && containerTool !== 'ddev') {
    const database = await db.query.taskDatabaseStates.findFirst({
      where: eq(schema.taskDatabaseStates.taskId, ctx.taskId),
    });
    if (database?.sourceSnapshotId && !database.importedAt)
      throw new Error(
        'The selected saved database requires DDEV. Choose DDEV in the declared dependencies before continuing.',
      );
  }

  let runtime: StepDefinition[] = [];
  if (containerTool === 'ddev') {
    // 01c starts DDEV; 01c1 restores the selected database; 06a runs the framework
    // DB migrations (drush updatedb / artisan migrate / …) so an imported DB matches
    // the code before browsing. 06a self-gates on .ddev/config.yaml and is skippable.
    runtime = [
      stepRegistry.require('01c-ddev-env'),
      stepRegistry.require('01c1-restore-database'),
      stepRegistry.require('06a-db-migrate'),
    ];
  } else if (containerTool) {
    // Non-DDEV (none / docker / docker-compose): build the env image, then boot the
    // app in the app-runner (01a-app-boot's optional LLM infers the run command).
    runtime = [
      stepRegistry.require('02-generate-dockerfile'),
      stepRegistry.require('03-build-image'),
      stepRegistry.require('01a-app-boot'),
    ];
  }
  return [...prefix, chooseView, ...runtime, ready, stepRegistry.require('11g-save-database')];
}

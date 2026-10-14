import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CONFIG_KEYS,
  REPO_OPTIONAL_BUILTIN_TASK_TYPES,
  configService,
  workflowTypeSchema,
} from '@haive/shared';
import {
  composableStepEntrySchema,
  derivePromptStepComposable,
  isCustomStepId,
  promptStepEntrySchema,
  promptStepId,
  resolveTaskTypeAvailability,
  validatePromptStep,
  type ComposableStepEntry,
  type CompositionIssue,
  type PromptStepEntry,
  type PromptStepProblemKind,
} from '@haive/shared/modularity';
import { HttpError } from '../context.js';

const BUILTIN_TASK_TYPES: ReadonlySet<string> = new Set(schema.workflowTypeEnum.enumValues);
const GENERIC_BUILTIN_TASK_TYPES: ReadonlySet<string> = new Set(workflowTypeSchema.options);

const MODEL_HEALTH_STEP_ID = '00-model-health-workflow';
const SIMPLIFY_STEP_ID = '07a-code-simplify';
/** Steps that write at the repository root: the base sync, the worktree add, and the cleanup merge. */
export const ROOT_WRITING_STEP_IDS: readonly string[] = [
  '00a-sync-base',
  '01-worktree-setup',
  '12-worktree-cleanup',
];
const RESTORE_DATABASE_STEP_ID = '01c1-restore-database';
const DATABASE_PIN_STEP_IDS = [RESTORE_DATABASE_STEP_ID, '11g-save-database'];

export function restoresDatabase(def: {
  source: string;
  runListStrategy: string;
  stepIds: readonly string[] | null;
}): boolean {
  return (
    def.source !== 'builtin' &&
    def.runListStrategy === 'static' &&
    def.stepIds?.includes(RESTORE_DATABASE_STEP_ID) === true
  );
}

const SAVED_DATABASE_BUILTINS = ['workflow', 'run_app'];

/** Whether a task of this type may be created from a saved database. */
export function acceptsSavedDatabase(slug: string, restores: boolean): boolean {
  return SAVED_DATABASE_BUILTINS.includes(slug) || restores;
}

/** Stored prompt steps by slug; an entry that no longer parses is left out, so its id reads as a missing step. */
export function parsePromptSteps(raw: unknown): Record<string, PromptStepEntry> {
  const out: Record<string, PromptStepEntry> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [slug, value] of Object.entries(raw)) {
    const parsed = promptStepEntrySchema.safeParse(value);
    if (parsed.success) out[slug] = parsed.data;
  }
  return out;
}

interface CatalogSets {
  stepIds: Set<string>;
  dispatchesCli: Set<string>;
  composable: Map<string, ComposableStepEntry>;
}

/** The catalog as one type sees it: the worker's steps plus that type's own prompt steps. */
export function mergePromptStepCatalog<C extends CatalogSets>(
  catalog: C,
  def: { slug: string; source: string; requiresRepository: boolean; promptSteps: unknown },
): C {
  if (def.source !== 'admin') return catalog;
  const entries = Object.values(parsePromptSteps(def.promptSteps));
  if (entries.length === 0) return catalog;
  const merged = {
    ...catalog,
    stepIds: new Set(catalog.stepIds),
    dispatchesCli: new Set(catalog.dispatchesCli),
    composable: new Map(catalog.composable),
  };
  for (const entry of entries) {
    const composable = derivePromptStepComposable(entry, def.slug, def.requiresRepository);
    merged.stepIds.add(composable.stepId);
    merged.dispatchesCli.add(composable.stepId);
    merged.composable.set(composable.stepId, composable);
  }
  return merged;
}

export type PromptStepIssueKind =
  PromptStepProblemKind | 'prompt-step-missing' | 'prompt-step-orphan';

export interface PromptStepIssue {
  kind: PromptStepIssueKind;
  stepId: string;
  index?: number;
  message: string;
  raw?: string;
  start?: number;
}

/** Every custom id in the step list has an entry of this type, every entry is used, and each validates where it stands. */
export function checkPromptSteps(
  def: { slug: string; stepIds: readonly string[]; requiresRepository: boolean },
  promptSteps: Record<string, PromptStepEntry>,
  catalog: { composable: ReadonlyMap<string, ComposableStepEntry> },
): PromptStepIssue[] {
  const issues: PromptStepIssue[] = [];
  const byId = new Map(
    Object.values(promptSteps).map((entry) => [promptStepId(def.slug, entry.slug), entry]),
  );
  const quotableStepIds = new Set([
    ...[...catalog.composable.values()]
      .filter((entry) => entry.agentAuthoredOutput === true)
      .map((entry) => entry.stepId),
    ...byId.keys(),
  ]);
  def.stepIds.forEach((stepId, index) => {
    if (!isCustomStepId(stepId)) return;
    const entry = byId.get(stepId);
    if (!entry) {
      issues.push({
        kind: 'prompt-step-missing',
        stepId,
        index,
        message: `${stepId} has no prompt step on this task type.`,
      });
      return;
    }
    const problems = validatePromptStep(entry, {
      typeSlug: def.slug,
      requiresRepository: def.requiresRepository,
      stepIdsBefore: def.stepIds.slice(0, index),
      quotableStepIds,
    });
    for (const { kind, message, raw, start } of problems) {
      issues.push({ kind, stepId, index, message, raw, start });
    }
  });
  for (const stepId of byId.keys()) {
    if (!def.stepIds.includes(stepId)) {
      issues.push({
        kind: 'prompt-step-orphan',
        stepId,
        message: `${stepId} is not in the step list.`,
      });
    }
  }
  return issues;
}

export interface TaskTypeDefinitionForCreate {
  runListSnapshot: string[] | null;
  /** The type's prompt steps by step id, only those in the snapshot; the task keeps this copy. */
  customSteps: Record<string, PromptStepEntry> | null;
  requiresRepository: boolean;
  /** True when a SEEDED definition needs no repository, so the task records whether it was anchored. */
  repoOptional: boolean;
  preAnswers: Record<string, Record<string, unknown>> | null;
  stepLoopLimits: Record<string, number>;
  /** True forces the flag on; false leaves it to the request, as for every built-in. */
  simplifyCode: boolean;
  takesRootLock: boolean;
  /** True makes the task pin a database state; a built-in's workflow/run_app gate stays at the site. */
  pinsDatabase: boolean;
  /** True when the run list imports a saved database, so the create may name one. */
  restoresDatabase: boolean;
}

const unseededBuiltin = (slug: string): TaskTypeDefinitionForCreate => ({
  runListSnapshot: null,
  customSteps: null,
  requiresRepository: !REPO_OPTIONAL_BUILTIN_TASK_TYPES.has(slug),
  repoOptional: false,
  preAnswers: null,
  stepLoopLimits: {},
  simplifyCode: false,
  takesRootLock: slug === 'workflow',
  pinsDatabase: false,
  restoresDatabase: false,
});

function describeIssue(issue: CompositionIssue): string {
  return 'stepId' in issue ? `${issue.kind} ${issue.stepId}` : issue.kind;
}

async function readCatalog(handle: Pick<Database, 'select'>) {
  const rows = await handle
    .select({
      stepId: schema.stepCatalog.stepId,
      dispatchesCli: schema.stepCatalog.dispatchesCli,
      composable: schema.stepCatalog.composable,
      entry: schema.stepCatalog.entry,
    })
    .from(schema.stepCatalog);
  if (rows.length === 0) return null;
  const composable = new Map<string, ComposableStepEntry>();
  for (const row of rows) {
    const parsed = row.composable ? composableStepEntrySchema.safeParse(row.entry) : null;
    if (parsed?.success) composable.set(row.stepId, parsed.data);
  }
  return {
    stepIds: new Set(rows.map((r) => r.stepId)),
    dispatchesCli: new Set(rows.filter((r) => r.dispatchesCli).map((r) => r.stepId)),
    composable,
  };
}

export async function definitionForCreate(
  handle: Pick<Database, 'select'>,
  slug: string,
  opts: { generic: boolean },
): Promise<TaskTypeDefinitionForCreate> {
  // FOR SHARE holds the row until the caller's insert commits, so a concurrent delete waits and then sees the task.
  const [def] = await handle
    .select()
    .from(schema.taskTypeDefinitions)
    .where(eq(schema.taskTypeDefinitions.slug, slug))
    .limit(1)
    .for('share');
  if (!def) {
    // The worker seeds the built-ins at boot; until it has, a built-in keeps today's live run list.
    if (!BUILTIN_TASK_TYPES.has(slug)) throw new HttpError(404, `Unknown task type ${slug}`);
    if (opts.generic && !GENERIC_BUILTIN_TASK_TYPES.has(slug)) {
      throw new HttpError(403, `Task type ${slug} cannot be created here`);
    }
    return unseededBuiltin(slug);
  }
  const storedCatalog =
    def.runListStrategy === 'static' && def.stepIds !== null ? await readCatalog(handle) : null;
  const catalog = storedCatalog && mergePromptStepCatalog(storedCatalog, def);
  const availability = resolveTaskTypeAvailability({
    definition: def,
    switches: {
      customEnabled:
        def.source !== 'admin' ||
        (await configService.getBoolean(CONFIG_KEYS.CUSTOM_TASK_TYPES_ENABLED, false)),
      moduleEnabled:
        !def.source.startsWith('module:') ||
        (await configService.getBoolean(CONFIG_KEYS.MODULE_TASK_TYPES_ENABLED, false)),
    },
    catalog,
    generic: opts.generic,
  });
  if (!availability.available) {
    switch (availability.reason) {
      case 'disabled':
        throw new HttpError(403, `Task type ${slug} is disabled`);
      case 'not-selectable':
        throw new HttpError(403, `Task type ${slug} cannot be created here`);
      case 'custom-types-off':
        throw new HttpError(403, 'Custom task types are disabled on this install');
      case 'module-types-off':
        throw new HttpError(403, 'Module task types are disabled on this install');
      case 'missing-step':
        throw new HttpError(
          409,
          `Task type ${slug} uses steps that no longer exist: ${availability.stepIds?.join(', ')}`,
          availability.reason,
        );
      case 'invalid-composition':
        throw new HttpError(
          409,
          `Task type ${slug} has an invalid step composition: ${(availability.issues ?? []).map(describeIssue).join(', ')}`,
          availability.reason,
        );
    }
  }
  const notBuiltin = def.source !== 'builtin';
  // Prompt steps stay with admin rows; every other trait is shared by module and admin rows.
  const promptEntries =
    def.source === 'admin' ? Object.values(parsePromptSteps(def.promptSteps)) : [];
  // Every prompt step dispatches a CLI, which the stored entries prove without a synced catalog.
  const promptIds = new Set(promptEntries.map((entry) => promptStepId(def.slug, entry.slug)));
  let snapshot = def.runListStrategy === 'static' ? def.stepIds : null;
  if (
    notBuiltin &&
    snapshot !== null &&
    !snapshot.includes(MODEL_HEALTH_STEP_ID) &&
    snapshot.some((id) => promptIds.has(id) || catalog?.dispatchesCli.has(id))
  ) {
    snapshot = [MODEL_HEALTH_STEP_ID, ...snapshot];
  }
  const has = (id: string) => snapshot?.includes(id) === true;
  const customSteps: Record<string, PromptStepEntry> = {};
  for (const entry of promptEntries) {
    const id = promptStepId(def.slug, entry.slug);
    if (has(id)) customSteps[id] = entry;
  }
  return {
    runListSnapshot: snapshot,
    customSteps: Object.keys(customSteps).length > 0 ? customSteps : null,
    requiresRepository: def.requiresRepository,
    repoOptional: !def.requiresRepository,
    preAnswers:
      notBuiltin && Object.keys(def.preAnswerDefaults).length > 0 ? def.preAnswerDefaults : null,
    stepLoopLimits: notBuiltin ? def.stepLoopLimitDefaults : {},
    simplifyCode: notBuiltin && has(SIMPLIFY_STEP_ID),
    takesRootLock: slug === 'workflow' || ROOT_WRITING_STEP_IDS.some(has),
    pinsDatabase: notBuiltin && DATABASE_PIN_STEP_IDS.some(has),
    restoresDatabase: restoresDatabase(def),
  };
}

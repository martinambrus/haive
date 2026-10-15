import { eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CONFIG_KEYS,
  REPO_OPTIONAL_BUILTIN_TASK_TYPES,
  configService,
  workflowTypeSchema,
} from '@haive/shared';
import {
  mergePromptStepCatalog,
  moduleIdsOfTaskType,
  parsePromptSteps,
  promptStepId,
  resolveTaskTypeAvailability,
  type CompositionIssue,
  type TaskTypeModuleRef,
  type TaskTypeModuleState,
} from '@haive/shared/modularity';
import { readStepCatalog } from '@haive/shared/modularity-server';
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

export interface TaskTypeDefinitionForCreate {
  runListSnapshot: string[] | null;
  /** The type's prompt steps by step id, only those in the snapshot; the task keeps this copy. */
  customSteps: Record<string, unknown> | null;
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

// FOR KEY SHARE on named rows: a deactivate running meanwhile waits, then counts the new task.
export async function readModuleStates(
  handle: Pick<Database, 'select'>,
  only?: readonly string[],
): Promise<Map<string, TaskTypeModuleState>> {
  if (only?.length === 0) return new Map();
  const read = handle
    .select({
      moduleId: schema.modules.moduleId,
      name: schema.modules.name,
      missingAt: schema.modules.missingAt,
      deactivatedAt: schema.modules.deactivatedAt,
    })
    .from(schema.modules);
  const rows =
    only === undefined
      ? await read
      : await read.where(inArray(schema.modules.moduleId, [...only])).for('key share');
  return new Map(
    rows.map((row) => [
      row.moduleId,
      { name: row.name, missing: row.missingAt !== null, deactivated: row.deactivatedAt !== null },
    ]),
  );
}

const moduleNames = (modules: TaskTypeModuleRef[] = []): string =>
  modules.map((m) => (m.name === null ? m.id : `${m.name} (${m.id})`)).join(', ');

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
  const modules = await readModuleStates(handle, moduleIdsOfTaskType(def));
  const storedCatalog =
    def.runListStrategy === 'static' && def.stepIds !== null ? await readStepCatalog(handle) : null;
  const catalog = storedCatalog?.synced ? mergePromptStepCatalog(storedCatalog, def) : null;
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
    modules,
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
      case 'module-missing':
        throw new HttpError(
          409,
          `Task type ${slug} needs modules that are not installed: ${moduleNames(availability.modules)}`,
          availability.reason,
        );
      case 'module-deactivated':
        throw new HttpError(
          409,
          `Task type ${slug} needs modules an administrator turned off: ${moduleNames(availability.modules)}`,
          availability.reason,
        );
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
      default: {
        const unhandled: never = availability.reason;
        throw new HttpError(409, `Task type ${slug} is unavailable (${String(unhandled)})`);
      }
    }
  }
  const notBuiltin = def.source !== 'builtin';
  // Prompt steps stay with admin rows; every other trait is shared by module and admin rows.
  const promptEntries =
    def.source === 'admin' ? Object.entries(parsePromptSteps(def.promptSteps)) : [];
  // Every prompt step dispatches a CLI, which the stored entries prove without a synced catalog.
  const promptIds = new Set(promptEntries.map(([, entry]) => promptStepId(def.slug, entry.slug)));
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
  const customSteps: Record<string, unknown> = {};
  for (const [key, entry] of promptEntries) {
    const id = promptStepId(def.slug, entry.slug);
    // As stored: the parsed copy drops a tool that no longer parses, which a task must still name.
    if (has(id)) customSteps[id] = def.promptSteps[key];
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

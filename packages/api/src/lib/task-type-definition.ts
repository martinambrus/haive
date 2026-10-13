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
  resolveTaskTypeAvailability,
  type ComposableStepEntry,
  type CompositionIssue,
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
    def.source === 'admin' &&
    def.runListStrategy === 'static' &&
    def.stepIds?.includes(RESTORE_DATABASE_STEP_ID) === true
  );
}

export interface TaskTypeDefinitionForCreate {
  runListSnapshot: string[] | null;
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
  const catalog =
    def.runListStrategy === 'static' && def.stepIds !== null ? await readCatalog(handle) : null;
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
  const custom = def.source === 'admin';
  let snapshot = def.runListStrategy === 'static' ? def.stepIds : null;
  if (
    custom &&
    snapshot !== null &&
    !snapshot.includes(MODEL_HEALTH_STEP_ID) &&
    snapshot.some((id) => catalog?.dispatchesCli.has(id))
  ) {
    snapshot = [MODEL_HEALTH_STEP_ID, ...snapshot];
  }
  const has = (id: string) => snapshot?.includes(id) === true;
  return {
    runListSnapshot: snapshot,
    requiresRepository: def.requiresRepository,
    repoOptional: !def.requiresRepository,
    preAnswers:
      custom && Object.keys(def.preAnswerDefaults).length > 0 ? def.preAnswerDefaults : null,
    stepLoopLimits: custom ? def.stepLoopLimitDefaults : {},
    simplifyCode: custom && has(SIMPLIFY_STEP_ID),
    takesRootLock: slug === 'workflow' || ROOT_WRITING_STEP_IDS.some(has),
    pinsDatabase: custom && DATABASE_PIN_STEP_IDS.some(has),
    restoresDatabase: restoresDatabase(def),
  };
}

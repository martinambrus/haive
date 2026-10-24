import { z } from 'zod';
import { stepLoopLimitsSchema } from '../schemas/tasks.js';
import { validateComposition, type CompositionIssue } from './composition.js';
import { RESERVED_TASK_TYPE_SLUGS, parseStepId, type ComposableStepEntry } from './contracts.js';
import { promptStepEntrySchema } from './prompt-steps.js';

export const CUSTOM_TASK_TYPE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const COMPOSABLE_STEP_GROUPS = [
  { id: 'env', label: 'Environment', order: 0 },
  { id: 'setup', label: 'Setup', order: 1 },
  { id: 'runtime', label: 'Runtime', order: 2 },
  { id: 'spec', label: 'Specification', order: 3 },
  { id: 'build', label: 'Build', order: 4 },
  { id: 'check', label: 'Checks', order: 5 },
  { id: 'finish', label: 'Finish', order: 6 },
  { id: 'knowledge', label: 'Knowledge', order: 7 },
] as const;

export const TASK_TYPE_UNAVAILABLE_REASONS = [
  'disabled',
  'not-selectable',
  'custom-types-off',
  'module-types-off',
  'module-missing',
  'module-deactivated',
  'missing-step',
  'invalid-composition',
] as const;
export type TaskTypeUnavailableReason = (typeof TASK_TYPE_UNAVAILABLE_REASONS)[number];

// The public list drops disabled and not-selectable rows before it asks, so a row never has them.
export const PUBLIC_TASK_TYPE_UNAVAILABLE_REASONS = [
  'custom-types-off',
  'module-types-off',
  'module-missing',
  'module-deactivated',
  'missing-step',
  'invalid-composition',
] as const satisfies readonly TaskTypeUnavailableReason[];
export type PublicTaskTypeUnavailableReason = (typeof PUBLIC_TASK_TYPE_UNAVAILABLE_REASONS)[number];

export interface TaskTypeModuleState {
  name: string;
  missing: boolean;
  deactivated: boolean;
}

export const taskTypeModuleRefSchema = z.object({ id: z.string(), name: z.string().nullable() });
export type TaskTypeModuleRef = z.infer<typeof taskTypeModuleRefSchema>;

export interface TaskTypeAvailabilityInput {
  definition: {
    source: string;
    enabled: boolean;
    selectable: boolean;
    runListStrategy: 'static' | 'workflow_paths' | 'run_app_modes';
    stepIds: readonly string[] | null;
    requiresRepository: boolean;
  };
  switches: { customEnabled: boolean; moduleEnabled: boolean };
  // Null when no rows were read, which turns the module reasons off; a module with no row is missing.
  modules: ReadonlyMap<string, TaskTypeModuleState> | null;
  catalog: {
    stepIds: ReadonlySet<string>;
    composable: ReadonlyMap<string, ComposableStepEntry>;
  } | null;
  generic: boolean;
}

export type TaskTypeAvailability =
  | { available: true }
  | {
      available: false;
      reason: TaskTypeUnavailableReason;
      missingStepIds?: string[];
      issues?: CompositionIssue[];
      modules?: TaskTypeModuleRef[];
    };

export function moduleIdsOfTaskType(
  definition: Pick<
    TaskTypeAvailabilityInput['definition'],
    'source' | 'runListStrategy' | 'stepIds'
  >,
): string[] {
  const ids = new Set<string>();
  if (definition.source.startsWith('module:')) ids.add(definition.source.slice('module:'.length));
  if (definition.runListStrategy === 'static') {
    for (const stepId of definition.stepIds ?? []) {
      const parsed = parseStepId(stepId);
      if (parsed?.kind === 'module') ids.add(parsed.moduleId);
    }
  }
  return [...ids].sort();
}

export function resolveTaskTypeAvailability(
  input: TaskTypeAvailabilityInput,
): TaskTypeAvailability {
  const { definition, switches, modules, catalog, generic } = input;
  if (!definition.enabled) return { available: false, reason: 'disabled' };
  if (generic && !definition.selectable) return { available: false, reason: 'not-selectable' };
  if (definition.source === 'admin' && !switches.customEnabled) {
    return { available: false, reason: 'custom-types-off' };
  }
  if (definition.source.startsWith('module:') && !switches.moduleEnabled) {
    return { available: false, reason: 'module-types-off' };
  }
  if (modules !== null) {
    const used = moduleIdsOfTaskType(definition);
    const refs = (ids: string[]): TaskTypeModuleRef[] =>
      ids.map((id) => ({ id, name: modules.get(id)?.name ?? null }));
    const missing = used.filter((id) => {
      const state = modules.get(id);
      return state === undefined || state.missing;
    });
    if (missing.length > 0) {
      return { available: false, reason: 'module-missing', modules: refs(missing) };
    }
    const deactivated = used.filter((id) => modules.get(id)?.deactivated === true);
    if (deactivated.length > 0) {
      return { available: false, reason: 'module-deactivated', modules: refs(deactivated) };
    }
  }
  if (catalog === null || definition.runListStrategy !== 'static' || definition.stepIds === null) {
    return { available: true };
  }
  const missingSteps = definition.stepIds.filter((id) => !catalog.stepIds.has(id));
  if (missingSteps.length > 0) {
    return { available: false, reason: 'missing-step', missingStepIds: missingSteps };
  }
  // A step with no composable entry is internal: what it requires and provides is unknown.
  const checked =
    definition.source === 'admin' ||
    (definition.source.startsWith('module:') &&
      definition.stepIds.every((id) => catalog.composable.has(id)));
  if (checked) {
    const issues = validateComposition(definition.stepIds, catalog.composable, {
      requiresRepository: definition.requiresRepository,
    });
    if (issues.length > 0) return { available: false, reason: 'invalid-composition', issues };
  }
  return { available: true };
}

const preAnswerDefaultsSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

const promptStepsSchema = z
  .record(z.string(), promptStepEntrySchema)
  .refine(
    (steps) => Object.entries(steps).every(([key, entry]) => key === entry.slug),
    'Each prompt step must be keyed by its slug',
  );

export const customTaskTypeCreateSchema = z
  .object({
    slug: z
      .string()
      .regex(CUSTOM_TASK_TYPE_SLUG_PATTERN)
      .refine((slug) => !RESERVED_TASK_TYPE_SLUGS.includes(slug), 'This slug is reserved'),
    displayName: z.string().min(1),
    description: z.string().optional(),
    stepIds: z.array(z.string().min(1)).min(1),
    preAnswerDefaults: preAnswerDefaultsSchema.optional(),
    stepLoopLimitDefaults: stepLoopLimitsSchema,
    promptSteps: promptStepsSchema.optional(),
    requiresRepository: z.boolean(),
    selectable: z.boolean().optional(),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();
export type CustomTaskTypeCreate = z.infer<typeof customTaskTypeCreateSchema>;

export const taskTypeUpdateSchema = customTaskTypeCreateSchema
  .omit({ slug: true })
  .partial()
  .strict();
export type TaskTypeUpdate = z.infer<typeof taskTypeUpdateSchema>;

export const publicTaskTypeSchema = z.object({
  slug: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().nullable(),
  requiresRepository: z.boolean(),
  sortOrder: z.number().int(),
  restoresDatabase: z.boolean(),
  dispatchesCli: z.boolean(),
  available: z.boolean(),
  reason: z.enum(PUBLIC_TASK_TYPE_UNAVAILABLE_REASONS).optional(),
  missingStepIds: z.array(z.string()).optional(),
  modules: z.array(taskTypeModuleRefSchema).optional(),
});
export type PublicTaskType = z.infer<typeof publicTaskTypeSchema>;

export type TaskTypeDefaultsIssue =
  | {
      kind: 'default-key-not-in-steps';
      field: 'preAnswerDefaults' | 'stepLoopLimitDefaults';
      stepId: string;
    }
  | { kind: 'loop-limit-not-editable'; stepId: string };

export function validateTaskTypeDefaults(
  input: {
    stepIds: readonly string[];
    preAnswerDefaults?: Record<string, unknown>;
    stepLoopLimitDefaults?: Record<string, number>;
  },
  catalog: ReadonlyMap<string, ComposableStepEntry>,
): TaskTypeDefaultsIssue[] {
  const issues: TaskTypeDefaultsIssue[] = [];
  const steps = new Set(input.stepIds);
  for (const stepId of Object.keys(input.preAnswerDefaults ?? {})) {
    if (!steps.has(stepId)) {
      issues.push({ kind: 'default-key-not-in-steps', field: 'preAnswerDefaults', stepId });
    }
  }
  for (const stepId of Object.keys(input.stepLoopLimitDefaults ?? {})) {
    if (!steps.has(stepId)) {
      issues.push({ kind: 'default-key-not-in-steps', field: 'stepLoopLimitDefaults', stepId });
    } else if (catalog.get(stepId)?.loopBudgetEditable !== true) {
      issues.push({ kind: 'loop-limit-not-editable', stepId });
    }
  }
  return issues;
}

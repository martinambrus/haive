import { z } from 'zod';
import { formSchemaSchema } from '../schemas/form.js';
import { stepLoopLimitsSchema } from '../schemas/tasks.js';

export const MODULES_LOADED_WORKER_KEY = 'haive:modules:loaded:worker';

export const CORE_STEP_ID_PATTERN = /^[0-9a-z_-]+$/;
const MODULE_STEP_ID_PATTERN = /^module\.([a-z0-9][a-z0-9-]*)\.([a-z0-9][a-z0-9_-]*)$/;
const CUSTOM_STEP_ID_PATTERN = /^custom\.([a-z0-9][a-z0-9-]*)\.([a-z0-9][a-z0-9-]*)$/;
export const CORE_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const TOOL_NAME_MAX_LENGTH = 40;
/** An MCP tool name Haive lists: integration operations and custom tools alike. */
export const TOOL_NAME_PATTERN = new RegExp(`^[a-z][a-z0-9_]{0,${TOOL_NAME_MAX_LENGTH - 1}}$`);
export const INTEGRATION_ID_MAX_LENGTH = 16;
/** A module or prompt step's requirement id prefixes a shared tool name (`<id>_<opId>`), cut to the cap with a digest past it. */
export const INTEGRATION_ID_PATTERN = new RegExp(
  `^[a-z][a-z0-9-]{0,${INTEGRATION_ID_MAX_LENGTH - 1}}$`,
);
export const PERSONA_ID_PATTERN_SOURCE = '[a-z0-9-]+';
const PERSONA_ID_PATTERN = new RegExp(`^${PERSONA_ID_PATTERN_SOURCE}$`);
const TASK_TYPE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const MODULE_TASK_TYPE_SLUG_PATTERN = /^([a-z0-9][a-z0-9-]*)__[a-z0-9][a-z0-9_-]*$/;
const MODULE_PACKAGE_PATTERN = /^(?:@haive\/module-|@haive-module\/)([a-z0-9][a-z0-9-]{0,22})$/;
/** Slugs no task type may take: `new` is the admin create page and `catalog` the step catalog route. */
export const RESERVED_TASK_TYPE_SLUGS: readonly string[] = ['new', 'catalog'];

/** The module id a package name stands for: `@haive/module-<id>` (a folder) or `@haive-module/<id>` (the registry), else null. */
export function modulePackageId(name: string): string | null {
  return MODULE_PACKAGE_PATTERN.exec(name)?.[1] ?? null;
}

/** No module id and no admin slug holds an underscore and no built-in holds `__`, so the first `__` splits it. */
export function moduleTaskTypeSlug(moduleId: string, local: string): string {
  return `${moduleId}__${local}`;
}

export function moduleIdOfTaskTypeSlug(slug: string): string | null {
  return MODULE_TASK_TYPE_SLUG_PATTERN.exec(slug)?.[1] ?? null;
}

export const CORE_INTEGRATION_CATEGORIES = [
  'rich-documents',
  'spreadsheets',
  'file-storage',
  'mail',
  'chat',
  'issues',
  'wiki',
  'forge',
] as const;
export type CoreIntegrationCategory = (typeof CORE_INTEGRATION_CATEGORIES)[number];

const CORE_INTEGRATION_CATEGORY_LABELS: Readonly<Record<CoreIntegrationCategory, string>> = {
  'rich-documents': 'Documents',
  spreadsheets: 'Spreadsheets',
  'file-storage': 'File storage',
  mail: 'Email',
  chat: 'Chat',
  issues: 'Issue tracking',
  wiki: 'Wiki',
  forge: 'Git forge',
};

export const CORE_INTEGRATION_CATEGORY_SPECS: readonly {
  readonly id: CoreIntegrationCategory;
  readonly label: string;
}[] = CORE_INTEGRATION_CATEGORIES.map((id) => ({
  id,
  label: CORE_INTEGRATION_CATEGORY_LABELS[id],
}));

const CORE_INTEGRATION_CATEGORY_IDS: ReadonlySet<string> = new Set(CORE_INTEGRATION_CATEGORIES);

export const REPOSITORY_BOUND_CATEGORIES: ReadonlySet<string> = new Set(['forge']);

export type ParsedStepId =
  | { kind: 'core' }
  | { kind: 'module'; moduleId: string; localId: string }
  | { kind: 'custom'; defSlug: string; stepSlug: string };

export type ParsedScopedId = { kind: 'core' } | { kind: 'module'; moduleId: string; id: string };

export function parseStepId(id: string): ParsedStepId | null {
  if (CORE_STEP_ID_PATTERN.test(id)) return { kind: 'core' };
  const mod = MODULE_STEP_ID_PATTERN.exec(id);
  if (mod) return { kind: 'module', moduleId: mod[1]!, localId: mod[2]! };
  const custom = CUSTOM_STEP_ID_PATTERN.exec(id);
  if (custom) return { kind: 'custom', defSlug: custom[1]!, stepSlug: custom[2]! };
  return null;
}

export function isStepOfModule(stepId: string | null, moduleId: string): boolean {
  const parsed = stepId === null ? null : parseStepId(stepId);
  return parsed?.kind === 'module' && parsed.moduleId === moduleId;
}

function parseScopedId(id: string): ParsedScopedId | null {
  if (CORE_PROVIDER_ID_PATTERN.test(id)) return { kind: 'core' };
  const mod = MODULE_STEP_ID_PATTERN.exec(id);
  if (mod) return { kind: 'module', moduleId: mod[1]!, id: mod[2]! };
  return null;
}

export function parseProviderId(id: string): ParsedScopedId | null {
  return parseScopedId(id);
}

export function parseCategoryId(id: string): ParsedScopedId | null {
  return parseScopedId(id);
}

export function isCoreStepId(id: string): boolean {
  return CORE_STEP_ID_PATTERN.test(id);
}

export function isModuleStepId(id: string): boolean {
  return MODULE_STEP_ID_PATTERN.test(id);
}

export function isCustomStepId(id: string): boolean {
  return CUSTOM_STEP_ID_PATTERN.test(id);
}

export function isProviderId(id: string): boolean {
  return parseProviderId(id) !== null;
}

export function isCategoryId(id: string): boolean {
  const parsed = parseCategoryId(id);
  return parsed !== null && (parsed.kind === 'module' || CORE_INTEGRATION_CATEGORY_IDS.has(id));
}

export function isPersonaId(id: string): boolean {
  return PERSONA_ID_PATTERN.test(id);
}

const stepIdSchema = z.string().refine((id) => parseStepId(id) !== null, 'invalid step id');

export const integrationRequirementSchema = z
  .object({
    id: z.string().regex(PERSONA_ID_PATTERN),
    category: z
      .string()
      .refine((id) => isCategoryId(id), 'invalid category id')
      .optional(),
    provider: z
      .string()
      .refine((id) => isProviderId(id), 'invalid provider id')
      .optional(),
    access: z.enum(['read', 'write']),
    optional: z.boolean().optional(),
  })
  .refine((r) => (r.category === undefined) !== (r.provider === undefined), {
    message: 'exactly one of category or provider is required',
  });
export type IntegrationRequirement = z.infer<typeof integrationRequirementSchema>;

export const REPOSITORY_TOKEN = 'repository';

/** Tokens no catalog entry provides or removes: the composition starts with them. */
export const IMPLICIT_COMPOSITION_TOKENS: ReadonlySet<string> = new Set([REPOSITORY_TOKEN]);

export const composableStepEntrySchema = z
  .object({
    stepId: stepIdSchema,
    label: z.string().min(1),
    group: z.string().min(1),
    dispatchesCli: z.boolean(),
    requires: z.array(z.object({ needs: z.string(), reason: z.string() })),
    provides: z.array(z.string()),
    paramFormSchema: formSchemaSchema.optional(),
    loopBudgetEditable: z.boolean().optional(),
    loopTargetStepId: stepIdSchema.optional(),
    closes: z.boolean().optional(),
    agentAuthoredOutput: z.boolean().optional(),
    precedes: z.array(z.string()).optional(),
    removes: z.array(z.string()).optional(),
    entails: z.array(z.string()).optional(),
    entailsWhen: z
      .array(z.object({ provided: z.string(), entails: z.array(z.string()) }))
      .optional(),
    integrations: z.array(integrationRequirementSchema).optional(),
  })
  .refine(
    (e) => {
      const ids = (e.integrations ?? []).map((i) => i.id);
      return new Set(ids).size === ids.length;
    },
    { message: 'integration requirement ids must be unique within a step' },
  )
  .refine(
    (e) => ![...e.provides, ...(e.removes ?? [])].some((t) => IMPLICIT_COMPOSITION_TOKENS.has(t)),
    { message: 'an implicit composition token cannot be provided or removed by a step' },
  );
export type ComposableStepEntry = z.infer<typeof composableStepEntrySchema>;

export const taskTypeDefinitionSeedSchema = z
  .object({
    slug: z
      .string()
      .regex(TASK_TYPE_SLUG_PATTERN)
      .refine((slug) => !RESERVED_TASK_TYPE_SLUGS.includes(slug), 'This slug is reserved'),
    displayName: z.string().min(1),
    description: z.string().optional(),
    runListStrategy: z.enum(['static', 'workflow_paths', 'run_app_modes']),
    stepIds: z.array(stepIdSchema).nullable(),
    selectable: z.boolean(),
    requiresRepository: z.boolean(),
    preAnswerDefaults: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    stepLoopLimitDefaults: stepLoopLimitsSchema,
    sortOrder: z.number().int().min(-2147483648).max(2147483647).optional(),
  })
  .refine(
    (s) =>
      s.runListStrategy === 'static'
        ? s.stepIds !== null && s.stepIds.length > 0
        : s.stepIds === null,
    { message: 'static needs a non-empty stepIds; dynamic strategies need stepIds null' },
  );
export type TaskTypeDefinitionSeed = z.infer<typeof taskTypeDefinitionSeedSchema>;

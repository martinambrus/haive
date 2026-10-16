import { z } from 'zod';
import { formSchemaSchema, statusSummaryItemSchema, type FormSchema } from '../schemas/form.js';
import {
  CORE_INTEGRATION_CATEGORIES,
  composableStepEntrySchema,
  type ComposableStepEntry,
  isCoreStepId,
  moduleTaskTypeSlug,
  parseCategoryId,
  parseProviderId,
  parseStepId,
  taskTypeDefinitionSeedSchema,
} from './contracts.js';
import {
  integrationCategorySpecSchema,
  integrationProviderSpecSchema,
  type IntegrationCategorySpec,
  type IntegrationProviderSpec,
} from './integrations.js';
import { STEP_ID_MAX_LENGTH } from './prompt-steps.js';

const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// databaseName('module', id) must fit Postgres' 63-byte identifier under the longest install id:
// 63 - 33 ('<32 chars>_') - 7 ('module_') = 23.
export const MODULE_ID_MAX_LENGTH = 23;
const PAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** The `task_type_definitions.slug` column. */
const TASK_TYPE_SLUG_MAX_LENGTH = 128;
/** Provider and category ids are varchar(256) in the integration tables. */
const INTEGRATION_LOCAL_ID_MAX_LENGTH = 64;
const CORE_CATEGORY_IDS: ReadonlySet<string> = new Set(CORE_INTEGRATION_CATEGORIES);
/** The id prefixes a shared tool name (`<id>_<opId>`), cut to the cap with a digest past it. */
const REQUIREMENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;

const endpointSchema = z
  .string()
  .refine(
    (e) =>
      e.startsWith('/') &&
      !e.includes('..') &&
      !e.includes('://') &&
      !e.includes('%') &&
      !e.includes('\\') &&
      !/\s/.test(e),
    'endpoint must be a relative api path',
  );

const cellSchema = z.union([z.string(), z.number(), z.null()]);
const rowSchema = z.record(z.string(), cellSchema);
const keyLabelSchema = z.object({ key: z.string().min(1), label: z.string().min(1) });

const exactlyOne = (hasInline: boolean, hasEndpoint: boolean) => hasInline !== hasEndpoint;

const kpiWidgetSchema = z
  .object({
    type: z.literal('kpi'),
    label: z.string().min(1),
    value: z.union([z.number(), z.string()]).optional(),
    endpoint: endpointSchema.optional(),
    unit: z.string().optional(),
  })
  .refine((w) => exactlyOne(w.value !== undefined, w.endpoint !== undefined), {
    message: 'exactly one of value or endpoint is required',
  });

const tableWidgetSchema = z
  .object({
    type: z.literal('table'),
    title: z.string().optional(),
    columns: z.array(keyLabelSchema).min(1),
    rows: z.array(rowSchema).optional(),
    endpoint: endpointSchema.optional(),
  })
  .refine((w) => exactlyOne(w.rows !== undefined, w.endpoint !== undefined), {
    message: 'exactly one of rows or endpoint is required',
  });

const meterWidgetSchema = z
  .object({
    type: z.literal('meter'),
    label: z.string().min(1),
    value: z.number().optional(),
    max: z.number().optional(),
    endpoint: endpointSchema.optional(),
  })
  .refine(
    (w) => (w.value === undefined) === (w.max === undefined),
    'value and max must be set together',
  )
  .refine((w) => exactlyOne(w.value !== undefined, w.endpoint !== undefined), {
    message: 'exactly one of value with max, or endpoint, is required',
  });

const markdownWidgetSchema = z.object({
  type: z.literal('markdown'),
  body: z.string(),
});

const statusWidgetSchema = z.object({
  type: z.literal('status'),
  title: z.string().optional(),
  endpoint: endpointSchema,
});

const chartWidgetSchema = z
  .object({
    type: z.literal('chart'),
    title: z.string().optional(),
    kind: z.enum(['line', 'bar', 'pie', 'area']),
    xKey: z.string().min(1),
    series: z.array(keyLabelSchema).min(1),
    data: z.array(rowSchema).optional(),
    endpoint: endpointSchema.optional(),
  })
  .refine((w) => exactlyOne(w.data !== undefined, w.endpoint !== undefined), {
    message: 'exactly one of data or endpoint is required',
  });

export const kpiResponseSchema = z.object({
  value: z.union([z.number(), z.string()]),
  unit: z.string().optional(),
});
export const tableResponseSchema = z.object({ rows: z.array(rowSchema) });
export const meterResponseSchema = z.object({ value: z.number(), max: z.number() });
export const statusResponseSchema = z.object({ items: z.array(statusSummaryItemSchema) });
export const chartResponseSchema = z.object({ data: z.array(rowSchema) });

const WIDGET_RESPONSE_SCHEMAS = {
  kpi: kpiResponseSchema,
  table: tableResponseSchema,
  meter: meterResponseSchema,
  status: statusResponseSchema,
  chart: chartResponseSchema,
} as const;

export function widgetResponseSchema<T extends keyof typeof WIDGET_RESPONSE_SCHEMAS>(
  type: T,
): (typeof WIDGET_RESPONSE_SCHEMAS)[T] {
  return WIDGET_RESPONSE_SCHEMAS[type];
}

export const dashboardWidgetSchema = z.discriminatedUnion('type', [
  kpiWidgetSchema,
  tableWidgetSchema,
  meterWidgetSchema,
  markdownWidgetSchema,
  statusWidgetSchema,
  chartWidgetSchema,
]);
export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;

export const dashboardSpecSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  widgets: z.array(dashboardWidgetSchema).min(1),
});
export type DashboardSpec = z.infer<typeof dashboardSpecSchema>;

export const moduleNavItemSchema = z.object({
  href: endpointSchema,
  label: z.string().min(1),
  icon: z.string().optional(),
  adminOnly: z.boolean().optional(),
  order: z.number().optional(),
});
export type ModuleNavItem = z.infer<typeof moduleNavItemSchema>;

export const moduleSettingsSchema = z.object({
  form: formSchemaSchema,
  defaults: z.record(z.string(), z.unknown()),
});
export type ModuleSettings = z.infer<typeof moduleSettingsSchema>;

export function collectFieldIds(form: FormSchema): Set<string> {
  const ids = new Set<string>();
  for (const field of form.fields) {
    ids.add(field.id);
    if (field.type === 'accordion') {
      for (const item of field.items) for (const inner of item.fields) ids.add(inner.id);
    }
  }
  return ids;
}

function defaultsMatchForm(settings: ModuleSettings | undefined): boolean {
  if (settings === undefined) return true;
  const ids = collectFieldIds(settings.form);
  return Object.keys(settings.defaults).every((key) => ids.has(key));
}

function isUnique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

type IntegrationDeclarations = {
  id: string;
  integrations?: IntegrationProviderSpec[];
  categories?: IntegrationCategorySpec[];
  composableSteps?: ComposableStepEntry[];
};

function checkIntegrationDeclarations(
  m: IntegrationDeclarations,
  ctx: z.core.$RefinementCtx,
): void {
  const fail = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', message, path });
  const prefix = `module.${m.id}.`;
  const providers = m.integrations ?? [];
  const categories = m.categories ?? [];
  const declaredCategories = new Set(categories.map((category) => category.id));
  const declaredProviders = new Set(providers.map((provider) => provider.id));

  const checkOwnId = (
    kind: 'provider' | 'category',
    id: string,
    parse: typeof parseProviderId,
    path: (string | number)[],
  ) => {
    const parsed = parse(id);
    if (parsed?.kind !== 'module' || parsed.moduleId !== m.id) {
      fail(path, `${kind} "${id}" must be named ${prefix}<name>`);
    } else if (parsed.id.length > INTEGRATION_LOCAL_ID_MAX_LENGTH) {
      fail(
        path,
        `${kind} "${id}": the name after ${prefix} is longer than ${INTEGRATION_LOCAL_ID_MAX_LENGTH} characters`,
      );
    }
  };
  const checkUnique = (kind: string, ids: string[], path: string) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) fail([path, index, 'id'], `${kind} id "${id}" appears twice`);
      seen.add(id);
    });
  };

  categories.forEach((category, index) =>
    checkOwnId('category', category.id, parseCategoryId, ['categories', index, 'id']),
  );
  checkUnique(
    'category',
    categories.map((category) => category.id),
    'categories',
  );
  providers.forEach((provider, index) => {
    const at = ['integrations', index];
    checkOwnId('provider', provider.id, parseProviderId, [...at, 'id']);
    provider.categories.forEach((categoryId, position) => {
      if (!CORE_CATEGORY_IDS.has(categoryId) && !declaredCategories.has(categoryId)) {
        fail(
          [...at, 'categories', position],
          `provider "${provider.id}" fills "${categoryId}", which is neither a core category nor declared by this module`,
        );
      }
    });
    if (provider.categories.includes('forge')) {
      fail([...at, 'categories'], `provider "${provider.id}" cannot fill the forge category`);
    }
    if (provider.mcp !== undefined) {
      fail(
        [...at, 'mcp'],
        `provider "${provider.id}" cannot declare an mcp surface; remote MCP is not supported yet`,
      );
    }
    if (provider.selfHosted) {
      fail(
        [...at, 'selfHosted'],
        `provider "${provider.id}" cannot be self-hosted: its urls are fixed in the manifest`,
      );
    }
    const canSignIn = provider.auth.some(
      (method) =>
        (method.kind === 'oauth2' &&
          method.userInfo !== undefined &&
          method.clientRegistration.includes('preregistered')) ||
        (method.kind === 'device' && method.userInfo !== undefined),
    );
    if (!canSignIn) {
      fail(
        [...at, 'auth'],
        `provider "${provider.id}" has no sign-in method that works: it needs oauth2 with userInfo and preregistered, or device with userInfo`,
      );
    }
    if (provider.apiHosts === undefined) {
      fail(
        [...at, 'apiHosts'],
        `provider "${provider.id}" must list the hosts it calls in apiHosts`,
      );
    }
  });
  checkUnique(
    'provider',
    providers.map((provider) => provider.id),
    'integrations',
  );

  (m.composableSteps ?? []).forEach((step, stepIndex) => {
    (step.integrations ?? []).forEach((requirement, index) => {
      const { category, provider } = requirement;
      const at = ['composableSteps', stepIndex, 'integrations', index];
      if (!REQUIREMENT_ID_PATTERN.test(requirement.id)) {
        fail(
          [...at, 'id'],
          `step "${step.stepId}" requirement id "${requirement.id}" must be 1 to 16 characters: a lower case letter, then lower case letters, digits or hyphens`,
        );
      }
      if (
        category !== undefined &&
        parseCategoryId(category)?.kind === 'module' &&
        !declaredCategories.has(category)
      ) {
        fail(
          at,
          `step "${step.stepId}" requires the category "${category}", which this module does not declare`,
        );
      }
      if (
        provider !== undefined &&
        parseProviderId(provider)?.kind === 'module' &&
        !declaredProviders.has(provider)
      ) {
        fail(
          at,
          `step "${step.stepId}" requires the provider "${provider}", which this module does not declare`,
        );
      }
    });
  });
}

export const moduleManifestSchema = z
  .object({
    id: z.string().regex(MODULE_ID_PATTERN).max(MODULE_ID_MAX_LENGTH),
    name: z.string().min(1),
    version: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    nav: z.array(moduleNavItemSchema).optional(),
    pages: z.record(z.string().regex(PAGE_ID_PATTERN), dashboardSpecSchema).optional(),
    apiRequiresAdmin: z.boolean().optional(),
    globalSettings: moduleSettingsSchema.optional(),
    adminSettings: moduleSettingsSchema.optional(),
    composableSteps: z.array(composableStepEntrySchema).optional(),
    taskTypes: z.array(taskTypeDefinitionSeedSchema).optional(),
    integrations: z.array(integrationProviderSpecSchema).optional(),
    categories: z.array(integrationCategorySpecSchema).optional(),
    ownsDatabase: z.boolean().optional(),
    hasWebPages: z.boolean().optional(),
    entitlementId: z.string().optional(),
  })
  .refine(
    (m) => (m.nav ?? []).every((n) => n.href === `/m/${m.id}` || n.href.startsWith(`/m/${m.id}/`)),
    { message: 'every nav href must be /m/<id> or start with /m/<id>/', path: ['nav'] },
  )
  .refine(
    (m) =>
      Object.values(m.pages ?? {}).every((page) =>
        page.widgets.every(
          (w) =>
            !('endpoint' in w) ||
            w.endpoint === undefined ||
            w.endpoint === `/m/${m.id}` ||
            w.endpoint.startsWith(`/m/${m.id}/`),
        ),
      ),
    { message: 'every widget endpoint must be /m/<id> or start with /m/<id>/', path: ['pages'] },
  )
  .refine((m) => (m.composableSteps ?? []).every((s) => isCoreStepId(s.stepId)), {
    message: 'composable step ids must be local (no module. or custom. prefix)',
    path: ['composableSteps'],
  })
  .refine((m) => isUnique((m.composableSteps ?? []).map((s) => s.stepId)), {
    message: 'composable step ids must be unique within a manifest',
    path: ['composableSteps'],
  })
  .refine((m) => isUnique((m.taskTypes ?? []).map((t) => t.slug)), {
    message: 'task type slugs must be unique within a manifest',
    path: ['taskTypes'],
  })
  .superRefine((m, ctx) => {
    (m.taskTypes ?? []).forEach((seed, index) => {
      const fail = (message: string) =>
        ctx.addIssue({
          code: 'custom',
          message: `task type "${seed.slug}": ${message}`,
          path: ['taskTypes', index],
        });
      const stored = moduleTaskTypeSlug(m.id, seed.slug);
      if (stored.length > TASK_TYPE_SLUG_MAX_LENGTH) {
        fail(
          `stored slug is ${stored.length} characters; the limit is ${TASK_TYPE_SLUG_MAX_LENGTH}`,
        );
      }
      if (`module:${m.id}`.length > TASK_TYPE_SLUG_MAX_LENGTH) {
        fail(`its source "module:${m.id}" is longer than ${TASK_TYPE_SLUG_MAX_LENGTH} characters`);
      }
      if (seed.runListStrategy !== 'static') {
        fail('a module task type must use the static strategy');
      }
      const seen = new Set<string>();
      for (const stepId of seed.stepIds ?? []) {
        if (seen.has(stepId)) fail(`step "${stepId}" appears twice`);
        seen.add(stepId);
        if (stepId.length > STEP_ID_MAX_LENGTH) {
          fail(`step "${stepId}" is longer than ${STEP_ID_MAX_LENGTH} characters`);
        }
        const parsed = parseStepId(stepId);
        if (parsed?.kind === 'custom') {
          fail(
            `step "${stepId}" is a custom step; a module task type names core steps and its own`,
          );
        } else if (parsed?.kind === 'module' && parsed.moduleId !== m.id) {
          fail(
            `step "${stepId}" belongs to module "${parsed.moduleId}"; a module task type names core steps and its own`,
          );
        }
      }
    });
  })
  .superRefine(checkIntegrationDeclarations)
  .refine((m) => defaultsMatchForm(m.globalSettings), {
    message: 'every default must name a field of the form',
    path: ['globalSettings', 'defaults'],
  })
  .refine((m) => defaultsMatchForm(m.adminSettings), {
    message: 'every default must name a field of the form',
    path: ['adminSettings', 'defaults'],
  });
export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

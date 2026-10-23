import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, logger, resolveDefaultCliProvider } from '@haive/shared';
import { listIntegrationCategories } from '@haive/shared/integrations';
import {
  COMPOSABLE_STEP_GROUPS,
  checkPromptSteps,
  customTaskTypeCreateSchema,
  mergePromptStepCatalog,
  parsePromptSteps,
  publicTaskTypeSchema,
  resolveTaskTypeAvailability,
  taskTypeUpdateSchema,
  validateComposition,
  validateTaskTypeDefaults,
  type TaskTypeModuleState,
} from '@haive/shared/modularity';
import { readStepCatalog, type StepCatalogRead } from '@haive/shared/modularity-server';
import { getDb } from '../db.js';
import { recordAuditEvent } from '../lib/audit.js';
import { buildUpcomingCliSteps } from './tasks/_helpers.js';
import { loadStepFlags, withTaskCustomSteps } from '../lib/step-flags.js';
import {
  acceptsSavedDatabase,
  definitionForCreate,
  readModuleStates,
  restoresDatabase,
} from '../lib/task-type-definition.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

const log = logger.child({ module: 'task-types' });

const BUILTIN_SLUGS: ReadonlySet<string> = new Set(schema.workflowTypeEnum.enumValues);

const registeredCategoryIds = (): ReadonlySet<string> =>
  new Set(listIntegrationCategories().map((category) => category.id));

type Db = ReturnType<typeof getDb>;
type DefinitionRow = typeof schema.taskTypeDefinitions.$inferSelect;

type Catalog = StepCatalogRead;

async function loadCatalog(db: Db): Promise<Catalog> {
  const catalog = await readStepCatalog(db, { ordered: true });
  for (const { stepId, source } of catalog.invalid) {
    log.warn({ stepId, source }, 'composable catalog entry is invalid');
  }
  return catalog;
}

async function readSwitches() {
  return {
    customEnabled: await configService.getBoolean(CONFIG_KEYS.CUSTOM_TASK_TYPES_ENABLED, false),
    moduleEnabled: await configService.getBoolean(CONFIG_KEYS.MODULE_TASK_TYPES_ENABLED, false),
  };
}

function availabilityOf(
  row: DefinitionRow,
  switches: Awaited<ReturnType<typeof readSwitches>>,
  catalog: Catalog,
  modules: ReadonlyMap<string, TaskTypeModuleState>,
) {
  const own = mergePromptStepCatalog(catalog, row);
  return resolveTaskTypeAvailability({
    definition: row,
    switches,
    modules,
    catalog: own.synced ? { stepIds: own.stepIds, composable: own.composable } : null,
    generic: true,
  });
}

function requireSynced(catalog: Catalog): void {
  if (!catalog.synced) throw new HttpError(409, 'The step catalog has not been synced yet');
}

async function findDefinition(db: Db, slug: string): Promise<DefinitionRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.taskTypeDefinitions)
    .where(eq(schema.taskTypeDefinitions.slug, slug))
    .limit(1);
  return row;
}

const BUILTIN_FIELDS = ['displayName', 'description', 'sortOrder'];
const MODULE_FIELDS = ['enabled', 'sortOrder', 'displayName'];
/** The New Task page infers these from the repository's onboarding state, so neither may be switched off. */
const ENABLE_LOCKED_BUILTINS: ReadonlySet<string> = new Set(['onboarding', 'workflow']);

function allowedFields(row: DefinitionRow): string[] | null {
  if (row.source === 'admin') return null;
  if (row.source === 'builtin')
    return row.selectable && !ENABLE_LOCKED_BUILTINS.has(row.slug)
      ? [...BUILTIN_FIELDS, 'enabled']
      : BUILTIN_FIELDS;
  return MODULE_FIELDS;
}

const UPDATABLE_FIELDS = Object.keys(taskTypeUpdateSchema.shape);

const taskTypePatchSchema = taskTypeUpdateSchema.extend({
  expectedUpdatedAt: z.iso.datetime().optional(),
});

/** The map without the steps that left the list, or undefined when none of its keys did. */
function withoutRemovedSteps<T>(
  map: Record<string, T>,
  stepIds: readonly string[],
): Record<string, T> | undefined {
  const listed = new Set(stepIds);
  const kept = Object.entries(map).filter(([id]) => listed.has(id));
  return kept.length < Object.keys(map).length ? Object.fromEntries(kept) : undefined;
}

function editableFieldsOf(row: DefinitionRow): string[] {
  return allowedFields(row) ?? UPDATABLE_FIELDS;
}

function dispatchesCliOf(row: DefinitionRow, catalog: Catalog): boolean {
  // Unsynced, the catalog cannot rule an agent out, so the form keeps its CLI pickers.
  if (!catalog.synced || row.runListStrategy !== 'static' || row.stepIds === null) return true;
  const { dispatchesCli } = mergePromptStepCatalog(catalog, row);
  return row.stepIds.some((id) => dispatchesCli.has(id));
}

export const adminTaskTypeRoutes = new Hono<AppEnv>();
adminTaskTypeRoutes.use('*', requireAuth);
adminTaskTypeRoutes.use('*', requireAdmin);

adminTaskTypeRoutes.get('/', async (c) => {
  const db = getDb();
  const [rows, counts, catalog, switches, modules] = await Promise.all([
    db
      .select()
      .from(schema.taskTypeDefinitions)
      .orderBy(asc(schema.taskTypeDefinitions.sortOrder), asc(schema.taskTypeDefinitions.slug)),
    db
      .select({ type: schema.tasks.type, count: sql<number>`count(*)::int` })
      .from(schema.tasks)
      .groupBy(schema.tasks.type),
    loadCatalog(db),
    readSwitches(),
    readModuleStates(db),
  ]);
  const taskCounts = new Map(counts.map((r) => [r.type, r.count]));
  return c.json({
    taskTypes: rows.map((row) => ({
      ...row,
      builtin: row.source === 'builtin',
      editableFields: editableFieldsOf(row),
      availability: availabilityOf(row, switches, catalog, modules),
      taskCount: taskCounts.get(row.slug) ?? 0,
    })),
  });
});

function catalogModuleState(row: TaskTypeModuleState): 'missing' | 'deactivated' | 'loaded' {
  if (row.missing) return 'missing';
  return row.deactivated ? 'deactivated' : 'loaded';
}

adminTaskTypeRoutes.get('/catalog', async (c) => {
  const db = getDb();
  const [catalog, modules] = await Promise.all([loadCatalog(db), readModuleStates(db)]);
  const offSources = new Set(
    [...modules].filter(([, row]) => row.deactivated).map(([id]) => `module:${id}`),
  );
  const steps = catalog.steps.filter((s) => !offSources.has(s.source));
  const known = new Set<string>(COMPOSABLE_STEP_GROUPS.map((g) => g.id));
  const unknown = [...new Set(steps.map((s) => s.entry.group))]
    .filter((id) => !known.has(id))
    .sort()
    .map((id) => ({ id, label: id }));
  return c.json({
    steps,
    groups: [...COMPOSABLE_STEP_GROUPS.map(({ id, label }) => ({ id, label })), ...unknown],
    synced: catalog.synced,
    modules: [...modules]
      .map(([id, row]) => ({ id, name: row.name, state: catalogModuleState(row) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    registeredStepIds: [...catalog.stepIds],
  });
});

adminTaskTypeRoutes.get('/:slug', async (c) => {
  const db = getDb();
  const row = await findDefinition(db, c.req.param('slug'));
  if (!row) throw new HttpError(404, 'Task type not found');
  const [catalog, switches, modules] = await Promise.all([
    loadCatalog(db),
    readSwitches(),
    readModuleStates(db),
  ]);
  const compositionIssues =
    row.source === 'admin' && catalog.synced
      ? validateComposition(row.stepIds ?? [], mergePromptStepCatalog(catalog, row).composable, {
          requiresRepository: row.requiresRepository,
        })
      : [];
  const promptStepIssues =
    row.source === 'admin' && catalog.synced
      ? checkPromptSteps(
          {
            slug: row.slug,
            stepIds: row.stepIds ?? [],
            requiresRepository: row.requiresRepository,
          },
          parsePromptSteps(row.promptSteps),
          catalog,
          registeredCategoryIds(),
        )
      : [];
  return c.json({
    taskType: { ...row, editableFields: editableFieldsOf(row) },
    availability: availabilityOf(row, switches, catalog, modules),
    compositionIssues,
    promptStepIssues,
  });
});

adminTaskTypeRoutes.post('/', async (c) => {
  const raw: unknown = await c.req.json();
  const rawSlug = (raw as { slug?: unknown } | null)?.slug;
  if (typeof rawSlug === 'string' && BUILTIN_SLUGS.has(rawSlug)) {
    throw new HttpError(409, 'That slug belongs to a built-in type');
  }
  const body = customTaskTypeCreateSchema.parse(raw);
  const db = getDb();
  if (await findDefinition(db, body.slug)) throw new HttpError(409, 'That slug is already taken');
  const catalog = await loadCatalog(db);
  requireSynced(catalog);
  const promptSteps = body.promptSteps ?? {};
  const promptIssues = checkPromptSteps(body, promptSteps, catalog, registeredCategoryIds());
  if (promptIssues.length > 0) {
    return c.json({ error: 'Invalid prompt steps', issues: promptIssues }, 400);
  }
  const { composable } = mergePromptStepCatalog(catalog, {
    slug: body.slug,
    source: 'admin',
    requiresRepository: body.requiresRepository,
    promptSteps,
  });
  const issues = validateComposition(body.stepIds, composable, {
    requiresRepository: body.requiresRepository,
  });
  if (issues.length > 0) return c.json({ error: 'Invalid step composition', issues }, 400);
  const defaultIssues = validateTaskTypeDefaults(body, composable);
  if (defaultIssues.length > 0) {
    return c.json({ error: 'Invalid defaults', issues: defaultIssues }, 400);
  }
  const [created] = await db
    .insert(schema.taskTypeDefinitions)
    .values({
      slug: body.slug,
      displayName: body.displayName,
      description: body.description ?? null,
      runListStrategy: 'static',
      stepIds: body.stepIds,
      preAnswerDefaults: body.preAnswerDefaults ?? {},
      stepLoopLimitDefaults: body.stepLoopLimitDefaults ?? {},
      promptSteps,
      fixLoop: null,
      enabled: body.enabled ?? true,
      selectable: body.selectable ?? true,
      source: 'admin',
      requiresRepository: body.requiresRepository,
      sortOrder: body.sortOrder ?? 0,
      contentHash: null,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) throw new HttpError(409, 'That slug is already taken');
  await recordAuditEvent(db, {
    actorUserId: c.get('userId'),
    action: 'task_type.create',
    targetType: 'task_type',
    metadata: { slug: body.slug, stepCount: body.stepIds.length },
  });
  return c.json({ taskType: { ...created, editableFields: editableFieldsOf(created) } }, 201);
});

adminTaskTypeRoutes.patch('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const { expectedUpdatedAt, ...body } = taskTypePatchSchema.parse(await c.req.json());
  const db = getDb();
  const fields = Object.keys(body);
  // Locked and reread, so two concurrent edits cannot each validate against the same stale row.
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, slug))
      .for('update');
    if (!row) throw new HttpError(404, 'Task type not found');
    // A JS Date holds milliseconds and the column microseconds, so the two are compared as Dates.
    if (
      expectedUpdatedAt !== undefined &&
      row.updatedAt.getTime() !== Date.parse(expectedUpdatedAt)
    ) {
      return { changed: row } as const;
    }
    const allowed = allowedFields(row);
    const refused = allowed ? fields.filter((f) => !allowed.includes(f)) : [];
    if (refused.length > 0) {
      throw new HttpError(400, `Cannot change ${refused.join(', ')} on this task type`);
    }
    // A removed step takes its preset and loop limit with it, unless the request sends that map itself.
    const dropped: Partial<Pick<DefinitionRow, 'preAnswerDefaults' | 'stepLoopLimitDefaults'>> = {};
    if (body.stepIds !== undefined && body.preAnswerDefaults === undefined) {
      const kept = withoutRemovedSteps(row.preAnswerDefaults, body.stepIds);
      if (kept) dropped.preAnswerDefaults = kept;
    }
    if (body.stepIds !== undefined && body.stepLoopLimitDefaults === undefined) {
      const kept = withoutRemovedSteps(row.stepLoopLimitDefaults, body.stepIds);
      if (kept) dropped.stepLoopLimitDefaults = kept;
    }
    if (
      body.stepIds !== undefined ||
      body.requiresRepository !== undefined ||
      body.promptSteps !== undefined ||
      body.preAnswerDefaults !== undefined ||
      body.stepLoopLimitDefaults !== undefined
    ) {
      const catalog = await loadCatalog(db);
      requireSynced(catalog);
      const stepIds = body.stepIds ?? row.stepIds ?? [];
      const requiresRepository = body.requiresRepository ?? row.requiresRepository;
      const promptSteps = body.promptSteps ?? parsePromptSteps(row.promptSteps);
      if (
        body.stepIds !== undefined ||
        body.requiresRepository !== undefined ||
        body.promptSteps !== undefined
      ) {
        const promptIssues = checkPromptSteps(
          { slug, stepIds, requiresRepository },
          promptSteps,
          catalog,
          registeredCategoryIds(),
        );
        if (promptIssues.length > 0) {
          return { invalid: { error: 'Invalid prompt steps', issues: promptIssues } } as const;
        }
      }
      const { composable } = mergePromptStepCatalog(catalog, {
        slug,
        source: row.source,
        requiresRepository,
        promptSteps,
      });
      if (
        body.stepIds !== undefined ||
        body.requiresRepository !== undefined ||
        body.promptSteps !== undefined
      ) {
        const issues = validateComposition(stepIds, composable, { requiresRepository });
        if (issues.length > 0) {
          return { invalid: { error: 'Invalid step composition', issues } } as const;
        }
      }
      const defaultIssues = validateTaskTypeDefaults(
        {
          stepIds,
          preAnswerDefaults:
            body.preAnswerDefaults ?? dropped.preAnswerDefaults ?? row.preAnswerDefaults,
          stepLoopLimitDefaults:
            body.stepLoopLimitDefaults ??
            dropped.stepLoopLimitDefaults ??
            row.stepLoopLimitDefaults,
        },
        composable,
      );
      if (defaultIssues.length > 0) {
        return { invalid: { error: 'Invalid defaults', issues: defaultIssues } } as const;
      }
    }
    const [updated] = await tx
      .update(schema.taskTypeDefinitions)
      .set({ ...body, ...dropped, updatedAt: new Date() })
      .where(eq(schema.taskTypeDefinitions.slug, slug))
      .returning();
    return { updated, droppedFields: Object.keys(dropped) } as const;
  });
  const changed = outcome.changed;
  if (changed) {
    return c.json(
      {
        error: 'This task type was changed since it was loaded',
        code: 'task_type_changed',
        taskType: { ...changed, editableFields: editableFieldsOf(changed) },
      },
      409,
    );
  }
  if ('invalid' in outcome) return c.json(outcome.invalid, 400);
  const updated = outcome.updated;
  if (!updated) throw new HttpError(404, 'Task type not found');
  await recordAuditEvent(db, {
    actorUserId: c.get('userId'),
    action: 'task_type.update',
    targetType: 'task_type',
    metadata: { slug, fields: [...fields, ...outcome.droppedFields] },
  });
  return c.json({ taskType: { ...updated, editableFields: editableFieldsOf(updated) } });
});

adminTaskTypeRoutes.delete('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const db = getDb();
  // The row lock pairs with the create path's FOR SHARE read, so a task cannot be inserted between the check and the delete.
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, slug))
      .for('update');
    if (!row) throw new HttpError(404, 'Task type not found');
    if (row.source !== 'admin') {
      throw new HttpError(400, 'Only custom task types can be deleted; disable this one instead');
    }
    const [used] = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.type, slug))
      .limit(1);
    if (used) throw new HttpError(409, 'Tasks of this type exist; disable it instead');
    await tx.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, slug));
  });
  await recordAuditEvent(db, {
    actorUserId: c.get('userId'),
    action: 'task_type.delete',
    targetType: 'task_type',
    metadata: { slug },
  });
  return c.body(null, 204);
});

export const taskTypeRoutes = new Hono<AppEnv>();
taskTypeRoutes.use('*', requireAuth);

taskTypeRoutes.get('/', async (c) => {
  const db = getDb();
  const [rows, catalog, switches, modules] = await Promise.all([
    db
      .select()
      .from(schema.taskTypeDefinitions)
      .where(
        and(
          eq(schema.taskTypeDefinitions.enabled, true),
          eq(schema.taskTypeDefinitions.selectable, true),
        ),
      )
      .orderBy(asc(schema.taskTypeDefinitions.sortOrder), asc(schema.taskTypeDefinitions.slug)),
    loadCatalog(db),
    readSwitches(),
    readModuleStates(db),
  ]);
  // Rows behind a switch that is off stay listed, unavailable with that reason, so the form can say why.
  const taskTypes = rows.map((row) => {
    const availability = availabilityOf(row, switches, catalog, modules);
    return publicTaskTypeSchema.parse({
      slug: row.slug,
      displayName: row.displayName,
      description: row.description,
      requiresRepository: row.requiresRepository,
      sortOrder: row.sortOrder,
      restoresDatabase: acceptsSavedDatabase(row.slug, restoresDatabase(row)),
      dispatchesCli: dispatchesCliOf(row, catalog),
      available: availability.available,
      ...(availability.available
        ? {}
        : {
            reason: availability.reason,
            stepIds: availability.stepIds,
            modules: availability.modules,
          }),
    });
  });
  return c.json({ taskTypes });
});

taskTypeRoutes.get('/:slug/saved-step-clis', async (c) => {
  const db = getDb();
  const slug = c.req.param('slug');
  const definition = await definitionForCreate(db, slug, { generic: true });
  const flags = withTaskCustomSteps(await loadStepFlags(db), {
    type: slug,
    requiresRepository: definition.requiresRepository,
    runListSnapshot: definition.runListSnapshot,
    customSteps: definition.customSteps,
  });
  const upcoming = await buildUpcomingCliSteps(
    db,
    flags,
    c.get('userId'),
    null,
    slug,
    [],
    false,
    definition.runListSnapshot,
  );
  const holdsSaved = (values: Record<string, string | null> | undefined) =>
    Object.values(values ?? {}).some((value) => value !== null);
  const steps = upcoming.filter(
    (step) =>
      step.preferredCliProviderId !== null ||
      holdsSaved(step.cliRoleProviders) ||
      holdsSaved(step.miningSeatProviders),
  );
  const providers = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.userId, c.get('userId')),
    columns: { id: true, enabled: true, createdAt: true },
  });
  return c.json({ steps, defaultProviderId: resolveDefaultCliProvider(providers)?.id ?? null });
});

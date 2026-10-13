import { Hono } from 'hono';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, logger } from '@haive/shared';
import {
  COMPOSABLE_STEP_GROUPS,
  composableStepEntrySchema,
  customTaskTypeCreateSchema,
  publicTaskTypeSchema,
  resolveTaskTypeAvailability,
  taskTypeUpdateSchema,
  validateComposition,
  validateTaskTypeDefaults,
  type ComposableStepEntry,
} from '@haive/shared/modularity';
import { getDb } from '../db.js';
import { recordAuditEvent } from '../lib/audit.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

const log = logger.child({ module: 'task-types' });

/** Workers cannot give a custom type a scratch workspace yet (P7), so it must name a repository. */
const REPO_LESS_UNSUPPORTED = 'Custom task types without a repository are not supported yet';

const BUILTIN_SLUGS: ReadonlySet<string> = new Set(schema.workflowTypeEnum.enumValues);

type Db = ReturnType<typeof getDb>;
type DefinitionRow = typeof schema.taskTypeDefinitions.$inferSelect;

interface Catalog {
  synced: boolean;
  stepIds: Set<string>;
  composable: Map<string, ComposableStepEntry>;
  steps: { stepId: string; source: string; title: string; entry: ComposableStepEntry }[];
}

async function loadCatalog(db: Db): Promise<Catalog> {
  const rows = await db.select().from(schema.stepCatalog).orderBy(asc(schema.stepCatalog.stepId));
  const catalog: Catalog = {
    synced: rows.length > 0,
    stepIds: new Set(rows.map((r) => r.stepId)),
    composable: new Map(),
    steps: [],
  };
  for (const row of rows) {
    if (!row.composable) continue;
    const parsed = composableStepEntrySchema.safeParse(row.entry);
    if (!parsed.success) {
      log.warn({ stepId: row.stepId, source: row.source }, 'composable catalog entry is invalid');
      continue;
    }
    catalog.composable.set(row.stepId, parsed.data);
    catalog.steps.push({
      stepId: row.stepId,
      source: row.source,
      title: row.title,
      entry: parsed.data,
    });
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
) {
  return resolveTaskTypeAvailability({
    definition: row,
    switches,
    catalog: catalog.synced ? { stepIds: catalog.stepIds, composable: catalog.composable } : null,
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

export const adminTaskTypeRoutes = new Hono<AppEnv>();
adminTaskTypeRoutes.use('*', requireAuth);
adminTaskTypeRoutes.use('*', requireAdmin);

adminTaskTypeRoutes.get('/', async (c) => {
  const db = getDb();
  const [rows, counts, catalog, switches] = await Promise.all([
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
  ]);
  const taskCounts = new Map(counts.map((r) => [r.type, r.count]));
  return c.json({
    taskTypes: rows.map((row) => ({
      ...row,
      builtin: row.source === 'builtin',
      availability: availabilityOf(row, switches, catalog),
      taskCount: taskCounts.get(row.slug) ?? 0,
    })),
  });
});

adminTaskTypeRoutes.get('/catalog', async (c) => {
  const catalog = await loadCatalog(getDb());
  const known = new Set<string>(COMPOSABLE_STEP_GROUPS.map((g) => g.id));
  const unknown = [...new Set(catalog.steps.map((s) => s.entry.group))]
    .filter((id) => !known.has(id))
    .sort()
    .map((id) => ({ id, label: id }));
  return c.json({
    steps: catalog.steps,
    groups: [...COMPOSABLE_STEP_GROUPS.map(({ id, label }) => ({ id, label })), ...unknown],
    synced: catalog.synced,
  });
});

adminTaskTypeRoutes.get('/:slug', async (c) => {
  const db = getDb();
  const row = await findDefinition(db, c.req.param('slug'));
  if (!row) throw new HttpError(404, 'Task type not found');
  const [catalog, switches] = await Promise.all([loadCatalog(db), readSwitches()]);
  const compositionIssues =
    row.source === 'admin' && catalog.synced
      ? validateComposition(row.stepIds ?? [], catalog.composable)
      : [];
  return c.json({
    taskType: row,
    availability: availabilityOf(row, switches, catalog),
    compositionIssues,
  });
});

adminTaskTypeRoutes.post('/', async (c) => {
  const raw: unknown = await c.req.json();
  const rawSlug = (raw as { slug?: unknown } | null)?.slug;
  if (typeof rawSlug === 'string' && BUILTIN_SLUGS.has(rawSlug)) {
    throw new HttpError(409, 'That slug belongs to a built-in type');
  }
  const body = customTaskTypeCreateSchema.parse(raw);
  if (body.requiresRepository === false) throw new HttpError(400, REPO_LESS_UNSUPPORTED);
  const db = getDb();
  if (await findDefinition(db, body.slug)) throw new HttpError(409, 'That slug is already taken');
  const catalog = await loadCatalog(db);
  requireSynced(catalog);
  const issues = validateComposition(body.stepIds, catalog.composable);
  if (issues.length > 0) return c.json({ error: 'Invalid step composition', issues }, 400);
  const defaultIssues = validateTaskTypeDefaults(body, catalog.composable);
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
  return c.json({ taskType: created }, 201);
});

adminTaskTypeRoutes.patch('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const body = taskTypeUpdateSchema.parse(await c.req.json());
  if (body.requiresRepository === false) throw new HttpError(400, REPO_LESS_UNSUPPORTED);
  const db = getDb();
  const row = await findDefinition(db, slug);
  if (!row) throw new HttpError(404, 'Task type not found');
  const fields = Object.keys(body);
  const allowed = allowedFields(row);
  const refused = allowed ? fields.filter((f) => !allowed.includes(f)) : [];
  if (refused.length > 0) {
    throw new HttpError(400, `Cannot change ${refused.join(', ')} on this task type`);
  }
  if (
    body.stepIds !== undefined ||
    body.preAnswerDefaults !== undefined ||
    body.stepLoopLimitDefaults !== undefined
  ) {
    const catalog = await loadCatalog(db);
    requireSynced(catalog);
    const stepIds = body.stepIds ?? row.stepIds ?? [];
    if (body.stepIds !== undefined) {
      const issues = validateComposition(stepIds, catalog.composable);
      if (issues.length > 0) return c.json({ error: 'Invalid step composition', issues }, 400);
    }
    const defaultIssues = validateTaskTypeDefaults(
      {
        stepIds,
        preAnswerDefaults: body.preAnswerDefaults ?? row.preAnswerDefaults,
        stepLoopLimitDefaults: body.stepLoopLimitDefaults ?? row.stepLoopLimitDefaults,
      },
      catalog.composable,
    );
    if (defaultIssues.length > 0) {
      return c.json({ error: 'Invalid defaults', issues: defaultIssues }, 400);
    }
  }
  const [updated] = await db
    .update(schema.taskTypeDefinitions)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(schema.taskTypeDefinitions.slug, slug))
    .returning();
  await recordAuditEvent(db, {
    actorUserId: c.get('userId'),
    action: 'task_type.update',
    targetType: 'task_type',
    metadata: { slug, fields },
  });
  return c.json({ taskType: updated });
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
  const [rows, catalog, switches] = await Promise.all([
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
  ]);
  const taskTypes = rows
    .filter((row) => {
      if (row.source === 'admin') return switches.customEnabled;
      if (row.source.startsWith('module:')) return switches.moduleEnabled;
      return true;
    })
    .map((row) => {
      const availability = availabilityOf(row, switches, catalog);
      return publicTaskTypeSchema.parse({
        slug: row.slug,
        displayName: row.displayName,
        description: row.description,
        requiresRepository: row.requiresRepository,
        sortOrder: row.sortOrder,
        available: availability.available,
        ...(availability.available ? {} : { reason: availability.reason }),
      });
    });
  return c.json({ taskTypes });
});

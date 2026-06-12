import { z } from 'zod';
import { Hono } from 'hono';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  GLOBAL_KB_JOB_NAMES,
  SECRET_KEYS,
  TASK_JOB_NAMES,
  configService,
  secretsService,
  type GlobalKbSyncJobPayload,
  type TaskJobPayload,
} from '@haive/shared';
import {
  globalKbEntries,
  resolveGlobalKbConnection,
  resolveGlobalKbSettings,
  withGlobalKb,
  type GlobalKbCategory,
  type GlobalKbFacets,
  type GlobalKbStatus,
} from '@haive/shared/global-kb';
import { ollamaEmbed, probeOllama } from '@haive/shared/rag';
import { getDb } from '../db.js';
import { getGlobalKbSyncQueue, getTaskQueue } from '../queues.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

// Global KB is instance/namespace-scoped (not per-user). haive is self-hosted
// single-operator — every signed-in user manages their own repos, tasks and
// settings — so the shared global KB is managed by any authenticated user too
// (requireAuth only, no admin role). The corpus lives in a SEPARATE database
// reached via withGlobalKb; getDb() is the main DB, needed only to CREATE the
// dedicated DB in internal mode.
const CATEGORIES = [
  'general',
  'tech_pattern',
  'anti_pattern',
  'best_practice',
  'quick_reference',
] as const;

const facetsSchema = z
  .object({
    framework: z.array(z.string()).optional(),
    frameworkMajor: z.array(z.string()).optional(),
    language: z.array(z.string()).optional(),
    phpMajor: z.array(z.string()).optional(),
    nodeMajor: z.array(z.string()).optional(),
    packages: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

const createSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1),
  category: z.enum(CATEGORIES),
  facets: facetsSchema.optional(),
  namespace: z.string().min(1).max(120).optional(),
  status: z.enum(['draft', 'active']).optional(),
  seedText: z.string().optional(),
});

const updateSchema = z
  .object({
    title: z.string().min(1).max(300),
    body: z.string().min(1),
    category: z.enum(CATEGORIES),
    facets: facetsSchema,
    status: z.enum(['draft', 'active', 'archived']),
  })
  .partial();

async function enqueueSync(
  entryId: string,
  namespace: string,
  reason: 'upsert' | 'delete',
): Promise<void> {
  await getGlobalKbSyncQueue().add(
    GLOBAL_KB_JOB_NAMES.SYNC_ENTRY,
    { entryId, namespace, reason } satisfies GlobalKbSyncJobPayload,
    { removeOnComplete: true, removeOnFail: 20 },
  );
}

const enrichSchema = z.object({
  // Free-text house rules — the only content input. The kb_author task derives
  // the title, category and version facets itself by reading the chosen repo.
  seedText: z.string().min(1),
  namespace: z.string().min(1).max(120).optional(),
  repositoryId: z.string().uuid(),
  cliProviderId: z.string().uuid(),
  // Per-article egress for the enrichment run (plan §5.3): none = repo + the
  // CLI's own model only; allowlist = + the listed domains; full = open internet.
  egress: z
    .object({
      mode: z.enum(['none', 'allowlist', 'full']),
      domains: z.array(z.string()).optional(),
    })
    .optional(),
});

export const globalKbRoutes = new Hono<AppEnv>();

globalKbRoutes.use('*', requireAuth);

// --- Global KB connection settings (instance-level: provider mode, external
// connection string, namespace, pinned embed model). Backed by ConfigService +
// SecretsService; resolveGlobalKbSettings is the same resolver the worker sync +
// query path use, so the UI edits exactly what they read. ---
function configResponse(s: Awaited<ReturnType<typeof resolveGlobalKbSettings>>) {
  return {
    enabled: s.enabled,
    mode: s.mode,
    namespace: s.namespace,
    ollamaUrl: s.ollamaUrl ?? '',
    embedModel: s.embedModel ?? '',
    embedDimensions: s.embeddingDimensions,
    connectionStringSet: !!s.connectionString,
  };
}

const configSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(['internal', 'external']).optional(),
    namespace: z.string().min(1).max(120).optional(),
    ollamaUrl: z.string().optional(),
    embedModel: z.string().optional(),
    embedDimensions: z.number().int().positive().max(8192).optional(),
    connectionString: z.string().optional(),
  })
  .strict();

globalKbRoutes.get('/config', async (c) => {
  return c.json(configResponse(await resolveGlobalKbSettings()));
});

globalKbRoutes.put('/config', async (c) => {
  const parsed = configSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid global KB config', 'invalid_body');
  const d = parsed.data;
  if (d.enabled !== undefined)
    await configService.set(CONFIG_KEYS.GLOBAL_KB_ENABLED, String(d.enabled));
  if (d.mode !== undefined) await configService.set(CONFIG_KEYS.GLOBAL_KB_MODE, d.mode);
  if (d.namespace !== undefined)
    await configService.set(CONFIG_KEYS.GLOBAL_KB_NAMESPACE, d.namespace);
  if (d.ollamaUrl !== undefined)
    await configService.set(CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL, d.ollamaUrl);
  if (d.embedModel !== undefined)
    await configService.set(CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL, d.embedModel);
  if (d.embedDimensions !== undefined)
    await configService.set(CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS, String(d.embedDimensions));
  if (d.connectionString !== undefined && d.connectionString.trim().length > 0) {
    await secretsService.set(
      SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING,
      d.connectionString.trim(),
      'Global KB external connection string',
    );
  }
  return c.json(configResponse(await resolveGlobalKbSettings()));
});

// --- Connection tests (the UI "Test" buttons). Both exercise the exact paths
// the worker sync/query use, so a green result means the real embed/store path
// works with the entered settings. ---
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  // Handle a late rejection (after the timeout already won the race) so it never
  // surfaces as an unhandledRejection.
  void p.catch(() => {});
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const testOllamaSchema = z
  .object({
    ollamaUrl: z.string().min(1),
    model: z.string().min(1),
    dimensions: z.number().int().positive().max(8192),
  })
  .strict();

globalKbRoutes.post('/test-ollama', async (c) => {
  const parsed = testOllamaSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid test request', 'invalid_body');
  const { ollamaUrl, model, dimensions } = parsed.data;
  if (!(await probeOllama(ollamaUrl))) {
    return c.json({ ok: false, message: `Ollama unreachable at ${ollamaUrl}` });
  }
  try {
    const [vec] = await ollamaEmbed(ollamaUrl, model, ['healthcheck']);
    const dims = vec?.length ?? 0;
    const dimsMatch = dims === dimensions;
    return c.json({
      ok: dimsMatch,
      message: dimsMatch
        ? `OK — ${model} returns ${dims} dims`
        : `Reachable, but ${model} returns ${dims} dims (config expects ${dimensions})`,
    });
  } catch (err) {
    return c.json({
      ok: false,
      message: `Reachable, but model "${model}" failed: ${(err as Error).message}`,
    });
  }
});

const testDbSchema = z
  .object({
    mode: z.enum(['internal', 'external']).optional(),
    connectionString: z.string().optional(),
  })
  .strict();

globalKbRoutes.post('/test-db', async (c) => {
  const parsed = testDbSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid test request', 'invalid_body');
  const saved = await resolveGlobalKbSettings();
  const mode = parsed.data.mode ?? saved.mode;
  // For external, prefer the freshly-typed connection string (lets the user test
  // before saving); fall back to the stored secret when the field is left blank.
  const connectionString =
    mode === 'external'
      ? parsed.data.connectionString?.trim() || saved.connectionString
      : saved.connectionString;
  if (mode === 'external' && !connectionString) {
    return c.json({ ok: false, message: 'No external connection string to test' });
  }
  let conn: Awaited<ReturnType<typeof resolveGlobalKbConnection>> | null = null;
  try {
    conn = await resolveGlobalKbConnection({ ...saved, mode, connectionString }, getDb());
    const pg = conn.pg;
    await withTimeout(
      (async () => {
        await pg`select 1`;
      })(),
      8000,
      'connection timed out',
    );
    return c.json({
      ok: true,
      message: mode === 'internal' ? 'Internal global KB DB reachable' : 'External DB reachable',
    });
  } catch (err) {
    return c.json({ ok: false, message: (err as Error).message });
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// Repo-anchored AI enrichment (plan §5.1/§5.3): create a `skeleton` entry, then a
// kb_author task that reads the chosen repo with the chosen CLI to expand the
// skeleton into a version-scoped `draft`. The user reviews + activates the draft.
globalKbRoutes.post('/enrich', async (c) => {
  const parsed = enrichSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid enrich request', 'invalid_body');
  const data = parsed.data;
  const userId = c.get('userId');
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(
      eq(schema.repositories.id, data.repositoryId),
      eq(schema.repositories.userId, userId),
    ),
    columns: { id: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');
  const provider = await db.query.cliProviders.findFirst({
    where: and(
      eq(schema.cliProviders.id, data.cliProviderId),
      eq(schema.cliProviders.userId, userId),
    ),
    columns: { id: true },
  });
  if (!provider) throw new HttpError(404, 'CLI provider not found');

  const firstLine =
    data.seedText
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean) ?? '';
  const placeholderTitle = firstLine.slice(0, 80) || 'Untitled house rule';

  const entry = await withGlobalKb(db, async ({ db: gdb, settings }) => {
    const [row] = await gdb
      .insert(globalKbEntries)
      .values({
        namespace: data.namespace || settings.namespace,
        userId,
        // Placeholders; the kb_author LLM overwrites title/category/facets/body.
        title: placeholderTitle,
        seedText: data.seedText,
        body: data.seedText,
        category: 'general',
        facets: {},
        status: 'skeleton',
        source: 'user',
        embedStatus: 'pending',
      })
      .returning();
    return row!;
  });

  const [task] = await db
    .insert(schema.tasks)
    .values({
      userId,
      type: 'kb_author',
      title: `Enrich: ${firstLine || data.seedText}`.slice(0, 512),
      repositoryId: data.repositoryId,
      cliProviderId: data.cliProviderId,
      metadata: {
        globalKbEntryId: entry.id,
        ...(data.egress
          ? { egress: { mode: data.egress.mode, domains: data.egress.domains ?? [], ips: [] } }
          : {}),
      },
      autoContinue: true,
      status: 'created',
    })
    .returning();
  if (!task) throw new HttpError(500, 'failed to create enrichment task');

  // Link the entry back to its task so the UI can offer a "watch task" link.
  await withGlobalKb(db, async ({ db: gdb }) => {
    await gdb
      .update(globalKbEntries)
      .set({ sourceTaskId: task.id })
      .where(eq(globalKbEntries.id, entry.id));
  });

  await getTaskQueue().add(
    TASK_JOB_NAMES.START,
    { taskId: task.id, userId } satisfies TaskJobPayload,
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );

  return c.json({ entry, taskId: task.id }, 201);
});

// Server-side paginated browse. Only one page of rows ever reaches the client,
// so the full-body corpus is never shipped/held in the browser. Search + filters
// run in SQL; the distinct framework list (for the filter dropdown) is computed
// from facets only (tiny — no bodies).
globalKbRoutes.get('/entries', async (c) => {
  const status = c.req.query('status');
  const category = c.req.query('category');
  const framework = c.req.query('framework');
  const q = c.req.query('q')?.trim();
  const page = Math.max(1, Math.floor(Number(c.req.query('page') ?? '1')) || 1);
  const pageSize = Math.min(
    50,
    Math.max(1, Math.floor(Number(c.req.query('pageSize') ?? '12')) || 12),
  );

  const result = await withGlobalKb(getDb(), async ({ db }) => {
    const conds: SQL[] = [];
    if (status) conds.push(eq(globalKbEntries.status, status as GlobalKbStatus));
    if (category) conds.push(eq(globalKbEntries.category, category as GlobalKbCategory));
    if (framework) {
      conds.push(sql`jsonb_exists(${globalKbEntries.facets} -> 'framework', ${framework})`);
    }
    if (q) {
      const like = `%${q}%`;
      conds.push(
        sql`(${globalKbEntries.title} ilike ${like} or ${globalKbEntries.body} ilike ${like})`,
      );
    }
    const where = conds.length ? and(...conds) : undefined;

    const totalRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(globalKbEntries)
      .where(where);
    const total = totalRows[0]?.n ?? 0;

    const entries = await db
      .select()
      .from(globalKbEntries)
      .where(where)
      .orderBy(desc(globalKbEntries.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const facetRows = await db.select({ facets: globalKbEntries.facets }).from(globalKbEntries);
    const frameworks = Array.from(
      new Set(facetRows.flatMap((r) => r.facets?.framework ?? [])),
    ).sort();

    return { entries, total, frameworks };
  });

  return c.json({
    entries: result.entries,
    total: result.total,
    page,
    pageSize,
    frameworks: result.frameworks,
  });
});

globalKbRoutes.get('/entries/:id', async (c) => {
  const id = c.req.param('id');
  const entry = await withGlobalKb(getDb(), async ({ db }) =>
    db.query.globalKbEntries.findFirst({ where: eq(globalKbEntries.id, id) }),
  );
  if (!entry) throw new HttpError(404, 'global KB entry not found');
  return c.json({ entry });
});

globalKbRoutes.post('/entries', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid global KB entry', 'invalid_body');
  const data = parsed.data;
  const userId = c.get('userId');

  const entry = await withGlobalKb(getDb(), async ({ db, settings }) => {
    const [row] = await db
      .insert(globalKbEntries)
      .values({
        namespace: data.namespace || settings.namespace,
        userId,
        title: data.title,
        seedText: data.seedText ?? null,
        body: data.body,
        category: data.category,
        facets: (data.facets ?? {}) as GlobalKbFacets,
        status: data.status ?? 'draft',
        source: 'user',
        embedStatus: 'pending',
      })
      .returning();
    return row!;
  });

  await enqueueSync(entry.id, entry.namespace, 'upsert');
  return c.json({ entry }, 201);
});

globalKbRoutes.patch('/entries/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid update', 'invalid_body');
  const data = parsed.data;
  if (Object.keys(data).length === 0) throw new HttpError(400, 'no fields to update');

  const entry = await withGlobalKb(getDb(), async ({ db }) => {
    const set: Partial<typeof globalKbEntries.$inferInsert> = { updatedAt: new Date() };
    if (data.title !== undefined) set.title = data.title;
    if (data.body !== undefined) set.body = data.body;
    if (data.category !== undefined) set.category = data.category;
    if (data.facets !== undefined) set.facets = data.facets as GlobalKbFacets;
    if (data.status !== undefined) set.status = data.status;
    // Content/scope/status edits need a re-embed.
    if (data.body !== undefined || data.facets !== undefined || data.status !== undefined) {
      set.embedStatus = 'pending';
    }
    const [row] = await db
      .update(globalKbEntries)
      .set(set)
      .where(eq(globalKbEntries.id, id))
      .returning();
    return row;
  });

  if (!entry) throw new HttpError(404, 'global KB entry not found');
  await enqueueSync(entry.id, entry.namespace, 'upsert');
  return c.json({ entry });
});

// Hard delete (single-operator instance; no shared-corpus concern). Remove the
// row, then enqueue a `delete` sync to drop its vectors. The UI guards this with
// a confirm since it is irreversible.
globalKbRoutes.delete('/entries/:id', async (c) => {
  const id = c.req.param('id');
  const entry = await withGlobalKb(getDb(), async ({ db }) => {
    const [row] = await db.delete(globalKbEntries).where(eq(globalKbEntries.id, id)).returning();
    return row;
  });
  if (!entry) throw new HttpError(404, 'global KB entry not found');
  await enqueueSync(entry.id, entry.namespace, 'delete');
  return c.json({ ok: true });
});

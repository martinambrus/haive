import { z } from 'zod';
import { Hono } from 'hono';
import { and, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
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
  globalKbTopicKey,
  orphanFacetMajors,
  resolveGlobalKbConnection,
  resolveGlobalKbSettings,
  withGlobalKb,
  type GlobalKbCategory,
  FACET_DIMENSIONS,
  normalizeFacets,
  type GlobalKbFacets,
  type GlobalKbStatus,
} from '@haive/shared/global-kb';
import {
  FACET_FILTER_DIMENSIONS,
  ollamaEmbed,
  probeOllama,
  releaseEmbedModelIfUnused,
} from '@haive/shared/rag';
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

/** DERIVED from the canonical dimension list rather than restated, because `.strict()` makes a
 *  gap here a silent 400 on a payload the rest of the system produces and stores happily.
 *  `database` and `dbMajor` were missing: the enrich step writes them, `facetsMatchProject`
 *  filters on them and the UI displays them, but any PATCH carrying one was refused as
 *  `invalid update` — which is what blocked editing an entry's scope at all. Strict is still
 *  right; a typo'd dimension stored here would simply never match anything. */
const facetsSchema = z
  .object(
    Object.fromEntries(FACET_DIMENSIONS.map((dim) => [dim, z.array(z.string()).optional()])) as {
      [K in (typeof FACET_DIMENSIONS)[number]]: z.ZodOptional<z.ZodArray<z.ZodString>>;
    },
  )
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

/** Exported for the test that pins the strict-schema regression: a facet dimension missing from
 *  `facetsSchema` is a 400 on a payload every other layer accepts, and nothing else catches it. */
export const updateSchema = z
  .object({
    title: z.string().min(1).max(300),
    body: z.string().min(1),
    category: z.enum(CATEGORIES),
    facets: facetsSchema,
    status: z.enum(['draft', 'active', 'archived']),
  })
  .partial();

/** The fast path only. Every edit that changes what gets embedded commits `embed_status = 'pending'`
 *  before this runs, so an `add` that fails or never lands is re-queued by the worker's
 *  `reconcilePendingGlobalKbSyncs`. A delete needs no such net: every path that retires an entry
 *  removes its vectors in its own transaction. */
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

export const enrichSchema = z.object({
  // User-set title — used verbatim for the entry and the task title (so the user
  // recognizes their own articles). Max matches the canonical title length (300).
  title: z.string().min(1).max(300),
  // Free-text house rules — the body the kb_author task reads and enriches. The
  // task derives the category and version facets itself by reading the chosen repo.
  seedText: z.string().min(1),
  namespace: z.string().min(1).max(120).optional(),
  /** OPTIONAL: a repository to read while writing the rule. It is where the model can SEE the
   *  pattern in practice, never the subject of the article — a house standard that applies to
   *  every project must be writable without opening one. */
  repositoryId: z.string().uuid().optional(),
  cliProviderId: z.string().uuid(),
  /** Scope the author is sure of, e.g. `{ framework: ['drupal'] }` for a rule that holds across
   *  Drupal majors. Authoritative: the worker merges these over whatever the model returns,
   *  because asking the prompt was already tried and produced a Drupal-8+ rule scoped to
   *  `frameworkMajor: ['7']`. Dimensions left out stay the model's to fill. */
  facets: facetsSchema.optional(),
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
    digestEnabled: s.digestEnabled,
    mode: s.mode,
    namespace: s.namespace,
    ollamaUrl: s.ollamaUrl ?? '',
    embedModel: s.embedModel ?? '',
    embedDimensions: s.embeddingDimensions,
    archiveRetentionDays: s.archiveRetentionDays,
    connectionStringSet: !!s.connectionString,
  };
}

const configSchema = z
  .object({
    enabled: z.boolean().optional(),
    digestEnabled: z.boolean().optional(),
    mode: z.enum(['internal', 'external']).optional(),
    namespace: z.string().min(1).max(120).optional(),
    ollamaUrl: z.string().optional(),
    embedModel: z.string().optional(),
    embedDimensions: z.number().int().positive().max(8192).optional(),
    archiveRetentionDays: z.number().int().min(0).max(3650).optional(),
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
  if (d.digestEnabled !== undefined)
    await configService.set(CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED, String(d.digestEnabled));
  if (d.mode !== undefined) await configService.set(CONFIG_KEYS.GLOBAL_KB_MODE, d.mode);
  if (d.namespace !== undefined)
    await configService.set(CONFIG_KEYS.GLOBAL_KB_NAMESPACE, d.namespace);
  if (d.ollamaUrl !== undefined)
    await configService.set(CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL, d.ollamaUrl);
  if (d.embedModel !== undefined)
    await configService.set(CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL, d.embedModel);
  if (d.embedDimensions !== undefined)
    await configService.set(CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS, String(d.embedDimensions));
  if (d.archiveRetentionDays !== undefined)
    await configService.set(
      CONFIG_KEYS.GLOBAL_KB_ARCHIVE_RETENTION_DAYS,
      String(d.archiveRetentionDays),
    );
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

// Best-effort GPU release, called by the Global KB settings page when the user
// leaves it (SPA unmount / tab close). Evicts the global-KB embed model ONLY when
// it is resident AND unused — the shared gate keeps it loaded if a live repo-RAG
// task (which may share the same model) or an in-flight global-KB sync still needs
// it, and never load-then-unloads a model that is not resident. The worker-boot
// reconciler and Ollama's keep_alive are the durable backstops; this just frees
// the GPU sooner once the user is clearly done with the KB UI.
globalKbRoutes.post('/release-embed-model', async (c) => {
  const settings = await resolveGlobalKbSettings();
  if (!settings.enabled || !settings.ollamaUrl || !settings.embedModel) {
    return c.json({ released: false, status: 'not_configured' });
  }
  const queue = getGlobalKbSyncQueue();
  const inFlight = (await queue.getActiveCount()) + (await queue.getWaitingCount());
  const status = await releaseEmbedModelIfUnused(getDb(), {
    url: settings.ollamaUrl,
    model: settings.embedModel,
    alsoInUse: inFlight > 0,
  });
  return c.json({ released: status === 'unloaded', status });
});

// Repo-anchored AI enrichment (plan §5.1/§5.3): create a `skeleton` entry, then a
// kb_author task that reads the chosen repo with the chosen CLI to expand the
// skeleton into a version-scoped `draft`. The user reviews + activates the draft.
globalKbRoutes.post('/enrich', async (c) => {
  const parsed = enrichSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid enrich request', 'invalid_body');
  const data = parsed.data;
  assertFacetsNameTheirTechnology(data.facets);
  const userId = c.get('userId');
  const db = getDb();

  // Only when one was named — a repo-less enrich is a first-class mode, not a missing field.
  if (data.repositoryId) {
    const repo = await db.query.repositories.findFirst({
      where: and(
        eq(schema.repositories.id, data.repositoryId),
        eq(schema.repositories.userId, userId),
      ),
      columns: { id: true },
    });
    if (!repo) throw new HttpError(404, 'Repository not found');
  }
  const provider = await db.query.cliProviders.findFirst({
    where: and(
      eq(schema.cliProviders.id, data.cliProviderId),
      eq(schema.cliProviders.userId, userId),
    ),
    columns: { id: true },
  });
  if (!provider) throw new HttpError(404, 'CLI provider not found');

  const entry = await withGlobalKb(db, async ({ db: gdb, settings }) => {
    const [row] = await gdb
      .insert(globalKbEntries)
      .values({
        namespace: data.namespace || settings.namespace,
        userId,
        // User-set title is authoritative; the LLM overwrites category/facets/body.
        title: data.title,
        seedText: data.seedText,
        body: data.seedText,
        category: 'general',
        // The author's stated scope, carried on the skeleton so the enrich step can read it
        // back as authoritative. `{}` when they stated nothing, which leaves every dimension
        // to the model exactly as before.
        facets: normalizeFacets(data.facets as GlobalKbFacets | undefined),
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
      title: `Enrich: ${data.title}`.slice(0, 512),
      description: data.seedText,
      repositoryId: data.repositoryId ?? null,
      cliProviderId: data.cliProviderId,
      metadata: {
        globalKbEntryId: entry.id,
        // What the AUTHOR chose, which `repositoryId` stops being able to say the moment a
        // repository is deleted: the FK is ON DELETE SET NULL, and `cancelOpenTasksForRepo`
        // leaves terminal tasks alone, so a FAILED anchored task silently becomes
        // indistinguishable from one created repo-less. Written even when null, because the
        // KEY's presence is what separates "recorded" from "predates this".
        anchorRepositoryId: data.repositoryId ?? null,
        // The author's OWN scope, kept where it cannot be rewritten. `01-enrich`'s apply
        // overwrites the ENTRY's facets with the merged result, so on a retry the entry reports
        // the model's inferred scope as though the author had stated it — and forcing those
        // values back over the new answer makes "retry to correct a wrong scope" impossible.
        authorFacets: normalizeFacets(data.facets as GlobalKbFacets | undefined),
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
  const sourceTaskId = c.req.query('sourceTaskId');
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
    // Scope to the drafts a given task promoted (the completed-task "review drafts" CTA).
    if (sourceTaskId) conds.push(eq(globalKbEntries.sourceTaskId, sourceTaskId));
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
  const found = await withGlobalKb(getDb(), async ({ db }) => {
    const entry = await db.query.globalKbEntries.findFirst({
      where: eq(globalKbEntries.id, id),
    });
    if (!entry) return null;
    // The LIVE entry that replaced this one, if any. Answered here because the only other way
    // to know is to scan the entries list — and that list is filtered and paginated, so a
    // reviewer looking at archived entries never has the active successor in hand. A warning
    // derived from a VIEW is a warning that silently disappears when the view narrows.
    //
    // Walks the CHAIN, not the direct child. An article replaced more than once leaves
    // A -> B -> C with only C active, and C points at B: a direct lookup from A finds B,
    // discards it for being archived, and reports no successor — so the warning vanished on
    // exactly the entries that have been superseded most often.
    //
    // Bounded twice, because this is recursion over user data: a depth cap, and a visited-set
    // guard so a cycle in `supersedes_entry_id` terminates instead of spinning. Only for an
    // archived row — an active entry cannot meaningfully be "replaced", and the query is not
    // worth running on every detail open.
    const successors =
      entry.status === 'archived'
        ? ((await db.execute(sql`
            WITH RECURSIVE chain AS (
              SELECT e.id, e.status, e.title, 1 AS depth, ARRAY[e.id] AS seen
                FROM global_kb_entries e
               WHERE e.supersedes_entry_id = ${entry.id}
              UNION ALL
              SELECT n.id, n.status, n.title, c.depth + 1, c.seen || n.id
                FROM global_kb_entries n
                JOIN chain c ON n.supersedes_entry_id = c.id
               WHERE c.depth < 20 AND NOT (n.id = ANY(c.seen))
            )
            SELECT id, title FROM chain WHERE status = 'active' LIMIT 1
          `)) as unknown as Array<{ id: string; title: string }>)
        : [];
    return { entry, activeSuccessor: successors[0] ?? null };
  });
  if (!found) throw new HttpError(404, 'global KB entry not found');
  return c.json(found);
});

globalKbRoutes.post('/entries', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid global KB entry', 'invalid_body');
  const data = parsed.data;
  assertFacetsNameTheirTechnology(data.facets);
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
        facets: normalizeFacets(data.facets as GlobalKbFacets | undefined),
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

/** Refuse a major-version facet that names no technology.
 *
 *  `normalizeFacets` DROPS one, which is the right convergent answer for a writer with nobody
 *  to ask — but silently discarding what an author typed is the wrong answer when there IS an
 *  author. They meant a specific technology's major and omitted the technology; both keeping it
 *  (it then matches that version of everything) and dropping it (the entry widens) are wrong,
 *  so the only honest move is to say which dimension is missing.
 *
 *  Applied to the RAW request facets, before normalisation, or the drop would have already
 *  happened and there would be nothing left to report. */
function assertFacetsNameTheirTechnology(facets: unknown): void {
  const orphans = orphanFacetMajors(facets as GlobalKbFacets | undefined);
  if (orphans.length === 0) return;
  const detail = orphans.map((o) => `${o.dimension} needs ${o.parent}`).join('; ');
  throw new HttpError(
    400,
    `a major-version facet must name its technology (${detail}) — a bare major matches that version of every technology`,
    'facet_major_without_parent',
  );
}

/** Whether a facet edit changed the entry's SCOPE, ignoring `tags`.
 *
 *  `tags` is carried by an entry but does not restrict retrieval (see FACET_FILTER_DIMENSIONS),
 *  so relabelling one does not make the article a different rule. Every other dimension does. */
export function scopeChanged(
  before: GlobalKbFacets | null | undefined,
  after: GlobalKbFacets | null | undefined,
): boolean {
  // BOTH operands are normalised here rather than at the call site. The stored side can predate
  // normalisation (`{framework:["Drupal"]}`) while the incoming side is always normalised, so
  // comparing them raw makes a no-op save look like a re-scope and silently drops a valid
  // `supersedesEntryId` — leaving the predecessor active after activation. Normalising inside
  // the helper is what stops a future caller reintroducing that asymmetry.
  const key = (f: GlobalKbFacets | null | undefined): string => {
    const n = normalizeFacets(f);
    return JSON.stringify(
      FACET_FILTER_DIMENSIONS.map((dim) => [dim, [...((n[dim] as string[]) ?? [])].sort()]),
    );
  };
  return key(before) !== key(after);
}

/** Why an entry cannot be edited right now, or null when it can.
 *
 *  Enrichment rewrites an entry's title, category, facets, body and status when it lands
 *  (`01-enrich`'s apply) from the task's own metadata and the model's answer, never from this row,
 *  so an edit accepted while that can still happen reports success and is then silently lost.
 *  `failed` counts too: recovering one is a step retry, which runs the same apply, and the retry
 *  route accepts any step status. The page already refuses to open such an entry; this is what
 *  stops a second tab, an API client, or a modal left open on a draft that a retry has since put
 *  back into enrichment. */
export function enrichmentBlocksEdit(status: string): string | null {
  if (status === 'skeleton' || status === 'enriching') {
    return 'this entry is still being enriched, and enrichment rewrites its content when it finishes — wait for the draft, then edit it';
  }
  if (status === 'failed') {
    return 'this entry is a failed enrichment, and a retry rewrites its content — retry or delete it instead of editing';
  }
  return null;
}

/** The promotion key a scope edit leaves behind, or `undefined` to leave the stored one alone.
 *
 *  `topic_key` is `category:tech[:major]` derived from the key-driving facets, and
 *  `promoteToGlobalKbDraft` groups its supersede candidates by EXACT equality on it. Left stale,
 *  a re-scoped entry is grouped with its FORMER stack's promotions and invisible to its new one
 *  — the same dedup-off-by-one-spelling defect `recomputeAliasedTopicKeys` closed for legacy
 *  rows, arriving this time through the scope editor.
 *
 *  Only an entry that ALREADY has a key is recomputed. Enrich derives the same value as a lock
 *  key and deliberately never stores it (`01-enrich.ts`), so writing one here would drag every
 *  hand-authored entry into a dedup it was built to stay out of.
 *
 *  Gated on `scopeChanged` rather than on facets merely being present in the patch, because the
 *  stored key may have come from a promotion's free-form `tech` (`globalKbTopicKey`'s
 *  `fallbackTech`, which nothing persists): a tags-only edit would then recompute it to null and
 *  silently drop a valid key. Tags do not drive the key, and `FACET_FILTER_DIMENSIONS` — what
 *  `scopeChanged` compares — is exactly the set the derivation reads. A real re-scope that
 *  leaves no derivable tech still CLEARS the key, which is what `globalKbTopicKey` returning
 *  null already means: never deduped. */
export function rescopedTopicKey(
  existing: { facets: GlobalKbFacets; category: GlobalKbCategory; topicKey: string | null },
  next: { category?: GlobalKbCategory; facets?: GlobalKbFacets },
): string | null | undefined {
  if (!existing.topicKey) return undefined;
  const categoryChanged = next.category !== undefined && next.category !== existing.category;
  const facetsChanged = next.facets !== undefined && scopeChanged(existing.facets, next.facets);
  if (!categoryChanged && !facetsChanged) return undefined;
  // A category-only edit changed nothing the TECH half is derived from, so the stored suffix is
  // carried across verbatim rather than re-derived. Re-deriving there LOSES information the key
  // holds and the facets do not: the tech may have come from a promotion's `fallbackTech`, which
  // nothing persists, and the major segment can outlive the facet that produced it — MEASURED on
  // the live store, `quick_reference:postgres:17` sits on facets `{"database":["postgres"]}` with
  // no `dbMajor`, so a category edit would have silently dropped the `:17`. Preserving is also
  // the minimal answer: reconciling a key that disagrees with its facets is
  // `recomputeAliasedTopicKeys`' job, and it is deliberately narrow about when it does that.
  const sep = existing.topicKey.indexOf(':');
  if (!facetsChanged && sep > 0) {
    return `${next.category}:${existing.topicKey.slice(sep + 1)}`;
  }
  return globalKbTopicKey(next.category ?? existing.category, next.facets ?? existing.facets ?? {});
}

globalKbRoutes.patch('/entries/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid update', 'invalid_body');
  const data = parsed.data;
  assertFacetsNameTheirTechnology(data.facets);
  if (Object.keys(data).length === 0) throw new HttpError(400, 'no fields to update');

  // ONE transaction for read-decide-write-archive. Without it two clients racing the same
  // draft interleave: activation reads `supersedesEntryId` after a concurrent scope edit has
  // decided to clear it but before the clear lands, and archives a predecessor the reviewer
  // had just detached. The UI's button guard cannot prevent that — it only serialises one tab,
  // while a second tab or an API client goes straight at the route.
  const result = await withGlobalKb(getDb(), async ({ db: conn }) =>
    conn.transaction(async (db) => {
      // LOCKED, so a retry's detect — a plain UPDATE to `enriching` — waits for this transaction
      // instead of flipping the status between the check and the write.
      const [current] = await db
        .select({ status: globalKbEntries.status })
        .from(globalKbEntries)
        .where(eq(globalKbEntries.id, id))
        .for('update');
      const blocked = current ? enrichmentBlocksEdit(current.status) : null;
      if (blocked) throw new HttpError(409, blocked, 'entry_enrichment_pending');
      const set: Partial<typeof globalKbEntries.$inferInsert> = { updatedAt: new Date() };
      if (data.title !== undefined) set.title = data.title;
      if (data.body !== undefined) set.body = data.body;
      if (data.category !== undefined) set.category = data.category;
      if (data.facets !== undefined) set.facets = normalizeFacets(data.facets as GlobalKbFacets);
      if (data.status !== undefined) set.status = data.status;
      // Activating CLEARS the supersession stamp, or reactivating is a no-op that looks like a
      // success. `supersededAt` means "archived because something replaced it", and the digest
      // filters on `status = 'active' AND superseded_at IS NULL` — so a row flipped to active
      // with the stamp still set stays invisible to every project. The scope editor's own warning
      // tells a reviewer to reactivate the predecessor when they move a replacement's scope, and
      // this is what makes that instruction true rather than merely printed.
      //
      // `supersedesEntryId` is deliberately KEPT here: it records what this entry replaced. Only a
      // real re-scope clears it (below), because a rule whose scope moved no longer replaces that.
      if (data.status === 'active') set.supersededAt = null;
      // Title/content/scope/status edits need a re-embed — the title heads every chunk — and marking
      // them pending is what lets the worker re-queue a sync whose enqueue below is lost.
      if (
        data.title !== undefined ||
        data.body !== undefined ||
        data.facets !== undefined ||
        data.status !== undefined
      ) {
        set.embedStatus = 'pending';
      }
      // A SCOPE edit invalidates a proposed supersession. The link was decided by comparing this
      // draft's article against the entry it would replace; re-scoping it to another technology
      // makes it a different rule, and activating it would then archive an entry it no longer has
      // anything to do with. Cleared rather than revalidated — revalidating needs an embedding
      // pass, and a stale duplicate the reviewer can archive by hand is a far cheaper mistake than
      // silently retiring the wrong article. Keyed on the FILTER dimensions, so a tags-only edit
      // (tags do not scope retrieval) leaves a valid link alone.
      // The locked read serves TWO decisions — the supersede link below and the topic key
      // after it — so it runs for a category edit as well as a facet one.
      let existing:
        | {
            facets: GlobalKbFacets;
            supersedesEntryId: string | null;
            status: GlobalKbStatus;
            category: GlobalKbCategory;
            topicKey: string | null;
          }
        | undefined;
      if (data.facets !== undefined || data.category !== undefined) {
        // LOCKED, not merely read inside a transaction. Postgres defaults to READ COMMITTED,
        // where atomicity is not isolation: an unlocked read can see the draft's old
        // `supersedesEntryId`, a concurrent activation can commit and archive that predecessor,
        // and this request then clears the link too late to have prevented anything. The row
        // lock makes the two PATCHes take turns, which is what the UI's button guard could
        // never do across tabs or API clients.
        [existing] = await db
          .select({
            facets: globalKbEntries.facets,
            supersedesEntryId: globalKbEntries.supersedesEntryId,
            status: globalKbEntries.status,
            category: globalKbEntries.category,
            topicKey: globalKbEntries.topicKey,
          })
          .from(globalKbEntries)
          .where(eq(globalKbEntries.id, id))
          .for('update');
      }
      if (data.facets !== undefined) {
        // Cleared on ANY real re-scope, whatever the status. The link is not only history: every
        // activation reads it — reactivation included — and archives the entry it names. So an
        // exemption for ACTIVE entries became wrong once an active entry could be archived and
        // reactivated from the page: re-scope an active replacement (the scope editor then tells
        // the reviewer to reactivate the old entry), archive it, reactivate it, and its activation
        // archived that old entry again although the two rules no longer share a scope. This
        // condition already had to widen once, from drafts to archived entries, for the same
        // reason: the set of states an entry can be activated from kept growing.
        //
        // Clearing costs the record of what a re-scoped entry once replaced, which stopped being
        // true when its scope moved. The predecessor's "an active entry still replaces this one"
        // warning follows this link too, so it stops claiming a replacement that is gone.
        if (existing?.supersedesEntryId && scopeChanged(existing.facets, set.facets)) {
          set.supersedesEntryId = null;
        }
        // The same holds for a link POINTING AT this entry: it was decided against the old scope
        // too. Left in place, activating that replacement — a reactivation included — archives
        // this entry although the two rules no longer share a scope, and the successor lookup
        // keeps warning that it has been replaced. Their `updatedAt` is left alone, for the
        // list-order reason the activation's predecessor archive gives.
        if (existing && scopeChanged(existing.facets, set.facets)) {
          await db
            .update(globalKbEntries)
            .set({ supersedesEntryId: null })
            .where(eq(globalKbEntries.supersedesEntryId, id));
        }
      }
      if (existing) {
        const rekeyed = rescopedTopicKey(existing, { category: set.category, facets: set.facets });
        if (rekeyed !== undefined) set.topicKey = rekeyed;
      }
      const [row] = await db
        .update(globalKbEntries)
        .set(set)
        .where(eq(globalKbEntries.id, id))
        .returning();
      // Carry the new scope onto this entry's CHUNKS, in the same transaction.
      //
      // A chunk holds its OWN copy of the facets and `buildFacetClause` filters on THAT, not on
      // the entry's — so committing the entry alone leaves every chunk advertising the old
      // scope, while the body expansion serves the entry's current text. Until the sync ran, a
      // re-scoped rule was therefore still delivered to its FORMER projects and missing from its
      // new ones, and indefinitely so if the enqueue or the embed failed.
      //
      // An UPDATE rather than a delete: a scope edit changes metadata, not prose, so the vectors
      // stay valid and the entry keeps working for the whole operation instead of going dark
      // until a re-embed lands. The enqueue below still runs — it is what re-embeds a BODY change
      // — but retrieval is correct the moment this commits rather than whenever that job does.
      if (set.facets !== undefined) {
        await db.execute(
          sql`UPDATE ai_rag_embeddings SET facets = ${JSON.stringify(set.facets)}::jsonb
               WHERE namespace = ${row?.namespace ?? ''} AND entry_id = ${id}`,
        );
      }
      // A non-active entry holds no vectors, enforced HERE, in the transaction that sets the status,
      // rather than by the sync job enqueued after commit. Global retrieval has no status predicate:
      // `rag.ts` ranks chunks on namespace and facets and joins the entry only to expand its body,
      // so a chunk that outlives its entry's `active` status is served. An enqueue that failed after
      // commit (Redis unavailable) used to leave an archived rule retrievable indefinitely, while
      // the page reported the archive as failed. A no-op for an entry that holds none.
      if (row && row.status !== 'active') {
        await db.execute(
          sql`DELETE FROM ai_rag_embeddings WHERE namespace = ${row.namespace} AND entry_id = ${id}`,
        );
      }
      // Activation supersession: when a draft that proposes replacing another entry (a
      // merge produced by onboarding) is activated, archive the entry it supersedes so
      // the topic keeps a single live article. Its vectors go in this transaction too, for the
      // reason above.
      let supersededId: string | null = null;
      if (row && set.status === 'active' && row.supersedesEntryId) {
        const [archived] = await db
          .update(globalKbEntries)
          // Record the archive time via supersededAt, but DON'T bump updatedAt: the
          // list sorts by updatedAt desc, so bumping it would float the just-archived
          // old article above its replacement. Leaving updatedAt keeps it in place.
          .set({ status: 'archived', supersededAt: new Date() })
          .where(
            and(
              eq(globalKbEntries.id, row.supersedesEntryId),
              ne(globalKbEntries.status, 'archived'),
            ),
          )
          .returning({ id: globalKbEntries.id, namespace: globalKbEntries.namespace });
        if (archived) {
          await db.execute(
            sql`DELETE FROM ai_rag_embeddings
                 WHERE namespace = ${archived.namespace} AND entry_id = ${archived.id}`,
          );
        }
        supersededId = archived?.id ?? null;
      }
      return { row, supersededId };
    }),
  );

  const entry = result.row;
  if (!entry) throw new HttpError(404, 'global KB entry not found');
  await enqueueSync(entry.id, entry.namespace, 'upsert');
  if (result.supersededId) await enqueueSync(result.supersededId, entry.namespace, 'delete');
  return c.json({ entry });
});

// Hard delete (single-operator instance; no shared-corpus concern). The UI guards this with a
// confirm since it is irreversible. The row and its vectors go in ONE transaction: a chunk whose
// entry is gone is still served — `expandGlobalHits` returns a global hit it has no body for
// unchanged — so leaving the vectors to the enqueued sync kept a deleted rule retrievable whenever
// that enqueue failed. The sync is still enqueued, and finds nothing left to remove.
globalKbRoutes.delete('/entries/:id', async (c) => {
  const id = c.req.param('id');
  const entry = await withGlobalKb(getDb(), async ({ db: conn }) =>
    conn.transaction(async (db) => {
      const [row] = await db.delete(globalKbEntries).where(eq(globalKbEntries.id, id)).returning();
      if (row) {
        await db.execute(
          sql`DELETE FROM ai_rag_embeddings WHERE namespace = ${row.namespace} AND entry_id = ${id}`,
        );
        // Entries that replaced this one now replace what IT replaced. Left pointing at the gap, a
        // chain A -> B -> C loses B, and archived A stops warning that C is live, so Reactivate is
        // offered on a rule that already has an active successor. `updated_at` is left alone, for
        // the list-order reason the activation's predecessor archive gives.
        await db.execute(
          sql`UPDATE global_kb_entries
                 SET supersedes_entry_id = CASE WHEN id = ${row.supersedesEntryId}::uuid
                                                THEN NULL ELSE ${row.supersedesEntryId}::uuid END
               WHERE supersedes_entry_id = ${id}::uuid`,
        );
      }
      return row;
    }),
  );
  if (!entry) throw new HttpError(404, 'global KB entry not found');
  await enqueueSync(entry.id, entry.namespace, 'delete');
  return c.json({ ok: true });
});

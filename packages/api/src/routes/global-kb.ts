import { safeErrorMessage } from '@haive/shared/logger';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, desc, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import {
  isLockNotAvailable,
  isRefusedStatement,
  lockRepositoryTasksKey,
  schema,
  type DbTx,
} from '@haive/database';
import {
  CONFIG_KEYS,
  GLOBAL_KB_JOB_NAMES,
  SECRET_KEYS,
  collapseToLine,
  configService,
  logger,
  secretsService,
  type GlobalKbSyncJobPayload,
} from '@haive/shared';
import {
  GLOBAL_KB_DESCRIPTION_MAX,
  HOUSE_RULES_ALWAYS_CAP_BYTES,
  enforcementState,
  globalKbEntries,
  globalKbTopicKey,
  houseRuleApprovalHash,
  houseRuleBytes,
  houseRuleContentToken,
  houseRuleShortIds,
  normalizeGlobalKbDescription,
  orphanFacetMajors,
  refusedHouseRuleText,
  resolveGlobalKbConnection,
  resolveGlobalKbSettings,
  readVectorColumnWidth,
  resolveHouseRulesEnabled,
  validateHouseRuleGlobs,
  withGlobalKb,
  withGlobalKbSchemaLock,
  type EnforceSpec,
  type GlobalKbCategory,
  FACET_DIMENSIONS,
  normalizeFacets,
  type GlobalKbDb,
  type GlobalKbEntry,
  type GlobalKbFacets,
  type GlobalKbStatus,
  type HouseRuleRow,
} from '@haive/shared/global-kb';
import {
  FACET_FILTER_DIMENSIONS,
  ollamaEmbed,
  probeOllama,
  releaseEmbedModelIfUnused,
} from '@haive/shared/rag';
import { loadUsableProvider } from '../lib/step-cli-choice.js';
import { getDb } from '../db.js';
import { insertAuditEvent, logAuditEvent, type AuditEvent } from '../lib/audit.js';
import { getGlobalKbSyncQueue } from '../queues.js';
import { enqueueStart, markQueuedForStart } from '../lib/task-start.js';
import { definitionForCreate } from '../lib/task-type-definition.js';
import { isUuid } from '../lib/uuid.js';
import { probeEgressFor } from '../lib/probe-hosts.js';
import { boundedLockWait } from '../lib/repository-busy.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { admitNewWork, requireNewWorkAllowed } from '../middleware/maintenance.js';
import { HttpError, type AppEnv } from '../context.js';

// Global KB is instance/namespace-scoped (not per-user). haive is self-hosted
// single-operator — every signed-in user manages their own repos, tasks and
// settings — so the shared global KB is managed by any authenticated user too
// (requireAuth only), except what puts an entry's text into agent prompts as an
// instruction: enforcement and the store settings are admin-only. The corpus lives in a
// SEPARATE database reached via withGlobalKb; getDb() is the main DB, needed only to
// CREATE the dedicated DB in internal mode.
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
  description: z.string().nullable().optional(),
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
    description: z.string().nullable(),
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

type GlobalKbTx = Parameters<Parameters<GlobalKbDb['transaction']>[0]>[0];

// A wait this long is a stuck holder, and every waiter holds a connection and a request meanwhile.
const GLOBAL_KB_LOCK_TIMEOUT_MS = 30_000;

// The corpus's advisory lock before the row's, always: writers that cross rows (an activation
// archiving its predecessor, a delete re-linking successors) can then never wait on each other.
async function lockEntry(db: GlobalKbTx, id: string): Promise<GlobalKbEntry | undefined> {
  const [named] = await db
    .select({ namespace: globalKbEntries.namespace })
    .from(globalKbEntries)
    .where(eq(globalKbEntries.id, id));
  if (!named) return undefined;
  await db.execute(sql.raw(`SET LOCAL lock_timeout = '${GLOBAL_KB_LOCK_TIMEOUT_MS}ms'`));
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`gkb-entries:${named.namespace}`}, 0))`,
  );
  const [row] = await db
    .select()
    .from(globalKbEntries)
    .where(eq(globalKbEntries.id, id))
    .for('update');
  return row;
}

function lockBusyError(err: unknown): never {
  if (isLockNotAvailable(err)) {
    throw new HttpError(503, 'Another change to this knowledge base is in progress; try again');
  }
  throw err;
}

// Postgres refuses a non-uuid in a uuid comparison, and that error would answer 500.
function entryIdParam(raw: string): string {
  if (!isUuid(raw)) throw new HttpError(404, 'global KB entry not found');
  return raw;
}

interface HouseRuleContext {
  namespace: string;
  houseRulesEnabled: boolean;
}

async function houseRuleContext(namespace: string): Promise<HouseRuleContext> {
  return { namespace, houseRulesEnabled: await resolveHouseRulesEnabled(configService) };
}

function presentEntry<T extends HouseRuleRow>(entry: T, ctx: HouseRuleContext) {
  return {
    ...entry,
    contentToken: houseRuleContentToken(entry),
    enforcementState: enforcementState(entry, ctx),
  };
}

const ALWAYS: EnforceSpec = { mode: 'always' };

// Counted as if house rules were on, so switching them on cannot overrun the cap.
async function alwaysBytes(
  db: Pick<GlobalKbDb, 'select'>,
  namespace: string,
  entry: Pick<GlobalKbEntry, 'id' | 'title' | 'category' | 'description' | 'body'>,
): Promise<{ usedBytes: number; entryBytes: number }> {
  const rows = await db
    .select()
    .from(globalKbEntries)
    .where(
      and(
        eq(globalKbEntries.namespace, namespace),
        isNotNull(globalKbEntries.enforcedHash),
        ne(globalKbEntries.id, entry.id),
      ),
    );
  // Every enforced rule widens the ids it shares a prefix with, as a prompt printing them all does.
  const shortIds = houseRuleShortIds([entry.id, ...rows.map((row) => row.id)]);
  const counted = (rule: typeof entry): number =>
    houseRuleBytes(rule, { enforce: ALWAYS, shortId: shortIds.get(rule.id)! });
  const usedBytes = rows.reduce((sum, row) => {
    const state = enforcementState(row, { namespace, houseRulesEnabled: true });
    return state.state === 'enforced' && state.mode === 'always' ? sum + counted(row) : sum;
  }, 0);
  return { usedBytes, entryBytes: counted(entry) };
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
  /** A one-line description the author is sure of. Authoritative, like the title: the worker keeps
   *  it over whatever the model proposes. */
  description: z.string().nullable().optional(),
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
async function configResponse(
  s: Awaited<ReturnType<typeof resolveGlobalKbSettings>>,
  role: 'admin' | 'user',
) {
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
    canEnforce: role === 'admin',
    houseRulesEnabled: await resolveHouseRulesEnabled(configService),
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
    clearConnectionString: z.boolean().optional(),
  })
  .strict();

// The bounds of the api's other reads of the store (rag.ts search).
const VECTOR_CHECK_CONNECT_TIMEOUT_SECONDS = 3;
const VECTOR_CHECK_DEADLINE_MS = 6_000;
const VECTOR_CHECK_STATEMENT_TIMEOUT_MS = 3_000;

/** Runs `apply` while holding the store's schema lock, once the `vector` column is known to be `width` wide or absent.
 *  A schema ensure takes the same lock and reads the width afterwards, so it creates the column at what `apply` saved.
 *  A bare connection: `withGlobalKb` would first ensure the schema, creating the column at the saved width. */
async function withVectorWidthLock(
  settings: Awaited<ReturnType<typeof resolveGlobalKbSettings>>,
  width: number,
  apply: () => Promise<void>,
) {
  const conn = await resolveGlobalKbConnection(settings, getDb(), {
    connectTimeoutSeconds: VECTOR_CHECK_CONNECT_TIMEOUT_SECONDS,
    fetchTypes: false,
  });
  let applying = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (!applying)
        reject(new Error('the global KB store did not answer the vector width check in time'));
    }, VECTOR_CHECK_DEADLINE_MS);
  });
  const locked = withGlobalKbSchemaLock(
    conn.pg,
    async (tx) => {
      const current = await readVectorColumnWidth(tx);
      if (current !== null && current !== width) {
        throw new HttpError(
          409,
          "the store's vector column has another width and cannot be resized here; the embedding dimensions must match it",
          'embed_dimensions_locked',
        );
      }
      applying = true;
      await apply();
    },
    { timeoutMs: VECTOR_CHECK_STATEMENT_TIMEOUT_MS },
  );
  void locked.catch(() => {});
  try {
    await Promise.race([locked, deadline]);
  } catch (err) {
    void conn.pg.end({ timeout: 0 }).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
    await conn.close().catch(() => {});
  }
}

globalKbRoutes.get('/config', async (c) => {
  return c.json(await configResponse(await resolveGlobalKbSettings(), c.get('userRole')));
});

// One save at a time, each reading the settings the previous one left: a store switch and a dims
// change from two requests must not both validate against the same saved store.
let configSaves: Promise<unknown> = Promise.resolve();
function serializeConfigSave<T>(run: () => Promise<T>): Promise<T> {
  const next = configSaves.then(run, run);
  configSaves = next.catch(() => {});
  return next;
}

globalKbRoutes.put('/config', (c) => serializeConfigSave(() => putConfig(c)));

// Write the main-DB row first. Main-DB changes join its transaction; log only after commit.
async function auditedChange<T>(event: AuditEvent, change: (tx: DbTx) => Promise<T>): Promise<T> {
  const result = await getDb().transaction(async (tx) => {
    await insertAuditEvent(tx, event);
    return change(tx);
  });
  logAuditEvent(event);
  return result;
}

async function putConfig(c: Context<AppEnv>) {
  const parsed = configSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid global KB config', 'invalid_body');
  const d = parsed.data;
  const isAdmin = c.get('userRole') === 'admin';
  const actorUserId = c.get('userId');
  const saved = await resolveGlobalKbSettings();
  const given = d.connectionString?.trim() ?? '';
  const clearing = d.clearConnectionString === true;
  // The page sends every field on every save, so only a CHANGED value is refused.
  // An unchanged one is accepted and not written, so it cannot undo a concurrent admin change.
  if (!isAdmin) {
    const changed = Object.entries({
      enabled: d.enabled !== undefined && d.enabled !== saved.enabled,
      namespace: d.namespace !== undefined && d.namespace !== saved.namespace,
      mode: d.mode !== undefined && d.mode !== saved.mode,
      connectionString: (given !== '' && given !== saved.connectionString) || clearing,
    })
      .filter(([, differs]) => differs)
      .map(([field]) => field);
    if (changed.length > 0) {
      throw new HttpError(403, `only an admin can change ${changed.join(', ')}`, 'admin_required');
    }
  }
  if (clearing && given !== '') {
    throw new HttpError(
      400,
      'send a new connection string or clear the stored one, not both',
      'connection_string_set_and_clear',
    );
  }
  if (given !== '' && given !== saved.connectionString && (d.mode ?? saved.mode) === 'internal') {
    throw new HttpError(
      400,
      'the built-in store uses no connection string; send it with the external store, or leave it blank',
      'connection_string_unused',
    );
  }
  if (clearing && (d.mode ?? saved.mode) === 'external') {
    throw new HttpError(
      409,
      'the external store needs its connection string; switch the store to the built-in one first',
      'connection_string_in_use',
    );
  }
  if ((d.mode ?? saved.mode) === 'external' && given === '' && !saved.connectionString) {
    throw new HttpError(
      400,
      'external mode needs a connection string, stored already or sent with it',
      'connection_string_required',
    );
  }
  const dimsChange =
    d.embedDimensions !== undefined && d.embedDimensions !== saved.embeddingDimensions;
  if (
    dimsChange &&
    ((d.mode !== undefined && d.mode !== saved.mode) ||
      (given !== '' && given !== saved.connectionString))
  ) {
    // The width check reads the saved store, so it cannot vouch for one this save switches to.
    throw new HttpError(
      409,
      'change the embedding dimensions and the store in separate saves',
      'embed_dimensions_with_store_change',
    );
  }
  const storesString = isAdmin && given !== '' && given !== saved.connectionString;
  const fields: [name: string, key: string, value: string | undefined][] = [
    ['enabled', CONFIG_KEYS.GLOBAL_KB_ENABLED, isAdmin ? d.enabled?.toString() : undefined],
    ['digestEnabled', CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED, d.digestEnabled?.toString()],
    ['mode', CONFIG_KEYS.GLOBAL_KB_MODE, isAdmin ? d.mode : undefined],
    ['namespace', CONFIG_KEYS.GLOBAL_KB_NAMESPACE, isAdmin ? d.namespace : undefined],
    ['ollamaUrl', CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL, d.ollamaUrl],
    ['embedModel', CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL, d.embedModel],
    ['embedDimensions', CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS, d.embedDimensions?.toString()],
    [
      'archiveRetentionDays',
      CONFIG_KEYS.GLOBAL_KB_ARCHIVE_RETENTION_DAYS,
      d.archiveRetentionDays?.toString(),
    ],
  ];
  const write = async () => {
    // The string goes first, so no reader finds the external store without it.
    if (storesString) {
      await auditedChange(
        {
          actorUserId,
          action: 'global_kb.connection_string.update',
          targetType: 'global_kb',
          metadata: { connectionStringSet: true },
        },
        (tx) =>
          secretsService.set(
            SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING,
            given,
            'Global KB external connection string',
            tx,
          ),
      );
    }
    if (fields.every(([, , value]) => value === undefined)) return;
    // Past the cache; serializeConfigSave let the previous save finish, so this is what it left.
    const stored = await Promise.all(fields.map(([, key]) => configService.getFresh(key)));
    const event = (indexes: number[], extra?: { partial: true }): AuditEvent => ({
      actorUserId,
      action: 'config.global_kb',
      targetType: 'system',
      metadata: {
        from: Object.fromEntries(indexes.map((i) => [fields[i]![0], stored[i]])),
        to: Object.fromEntries(indexes.map((i) => [fields[i]![0], fields[i]![2] ?? stored[i]])),
        connectionStringChanged: storesString,
        ...extra,
      },
    });
    const full = event(fields.map((_, i) => i));
    const written: number[] = [];
    const outcome = await getDb().transaction(async (tx) => {
      try {
        await tx.transaction(async (savepoint) => {
          await insertAuditEvent(savepoint, full);
          for (const [i, [, key, value]] of fields.entries()) {
            if (value === undefined) continue;
            await configService.set(key, value);
            written.push(i);
          }
        });
      } catch (error) {
        if (written.length === 0) throw error;
        const partial = event(written, { partial: true });
        await insertAuditEvent(tx, partial);
        // Returned, not rethrown: a throw would roll the partial row back with the transaction.
        return { event: partial, error };
      }
      return { event: full };
    });
    logAuditEvent(outcome.event);
    if ('error' in outcome) throw outcome.error;
  };
  if (dimsChange) await withVectorWidthLock(saved, d.embedDimensions!, write);
  else await write();
  if (isAdmin && clearing) {
    await auditedChange(
      {
        actorUserId,
        action: 'global_kb.connection_string.update',
        targetType: 'global_kb',
        metadata: { connectionStringSet: false },
      },
      (tx) => secretsService.delete(SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING, tx),
    );
  }
  return c.json(await configResponse(await resolveGlobalKbSettings(), c.get('userRole')));
}

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
  const { fetchFn } = await probeEgressFor(c);
  if (!(await probeOllama(ollamaUrl, fetchFn))) {
    return c.json({ ok: false, message: `Ollama unreachable at ${ollamaUrl}` });
  }
  try {
    const [vec] = await ollamaEmbed(ollamaUrl, model, ['healthcheck'], { fetchFn });
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
      message: `Reachable, but model "${model}" failed: ${safeErrorMessage(err)}`,
    });
  }
});

const testDbSchema = z
  .object({
    mode: z.enum(['internal', 'external']).optional(),
    connectionString: z.string().optional(),
  })
  .strict();

globalKbRoutes.post('/test-db', requireAdmin, async (c) => {
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
    return c.json({ ok: false, message: safeErrorMessage(err) });
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
globalKbRoutes.post('/enrich', requireNewWorkAllowed, async (c) => {
  const parsed = enrichSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid enrich request', 'invalid_body');
  const data = parsed.data;
  assertFacetsNameTheirTechnology(data.facets);
  const description = authoredDescription(data.description) ?? null;
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
  await loadUsableProvider(db, userId, data.cliProviderId);

  // Refused here, a disabled type writes no skeleton; the task's transaction reads it again.
  await definitionForCreate(db, 'kb_author', { generic: false });

  const taskId = randomUUID();
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
        description,
        status: 'skeleton',
        source: 'user',
        embedStatus: 'pending',
        // So the UI can offer a "watch task" link. The task is inserted below under this id.
        sourceTaskId: taskId,
      })
      .returning();
    return presentEntry(row!, await houseRuleContext(settings.namespace));
  });

  let queued: Awaited<ReturnType<typeof markQueuedForStart>>;
  let reachedCommit = false;
  try {
    queued = await db.transaction(async (tx) => {
      await admitNewWork(tx);
      // Queuing takes this lock; taken before the insert, it inverts no lock the row's insert holds.
      const lockedRepositoryId = data.repositoryId;
      if (lockedRepositoryId) {
        await boundedLockWait(tx, () => lockRepositoryTasksKey(tx, lockedRepositoryId));
      }
      const { runListSnapshot, customSteps } = await definitionForCreate(tx, 'kb_author', {
        generic: false,
      });
      await tx.insert(schema.tasks).values({
        id: taskId,
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
          authorDescription: description,
          ...(data.egress
            ? { egress: { mode: data.egress.mode, domains: data.egress.domains ?? [], ips: [] } }
            : {}),
        },
        autoContinue: true,
        runListSnapshot,
        customSteps,
        status: 'created',
      });
      const claimed = await markQueuedForStart(tx, taskId);
      reachedCommit = true;
      return claimed;
    });
  } catch (err) {
    // The entry lives in the global KB database, so no transaction spans both writes. An error
    // inside the transaction rolled the task back; a failed commit wrote nothing only if refused.
    if (!reachedCommit || isRefusedStatement(err)) {
      await withGlobalKb(db, ({ db: gdb }) =>
        gdb.transaction(async (tx) => {
          if ((await lockEntry(tx, entry.id))?.status !== 'skeleton') return;
          await tx.delete(globalKbEntries).where(eq(globalKbEntries.id, entry.id));
        }),
      ).catch((cleanupErr) =>
        logger.warn(
          { err: cleanupErr, entryId: entry.id },
          'could not remove the skeleton entry of a failed enrich',
        ),
      );
    }
    throw err;
  }

  if (queued) await enqueueStart(taskId, userId);

  return c.json({ entry, taskId }, 201);
});

/** Each entry's source task status, read from the main database since the global KB is a separate
 *  one. Another user's task reads as null: none of its actions are the caller's to take. */
export async function withSourceTaskStatus<T extends { sourceTaskId: string | null }>(
  db: ReturnType<typeof getDb>,
  userId: string,
  entries: T[],
) {
  const ids = [...new Set(entries.flatMap((e) => (e.sourceTaskId ? [e.sourceTaskId] : [])))];
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({ id: schema.tasks.id, status: schema.tasks.status })
          .from(schema.tasks)
          .where(and(inArray(schema.tasks.id, ids), eq(schema.tasks.userId, userId)));
  const statusById = new Map(rows.map((r) => [r.id, r.status]));
  return entries.map((e) => ({
    ...e,
    sourceTaskStatus: e.sourceTaskId ? (statusById.get(e.sourceTaskId) ?? null) : null,
  }));
}

// Server-side paginated browse. Only one page of rows ever reaches the client,
// so the full-body corpus is never shipped/held in the browser. Search + filters
// run in SQL; the distinct framework list (for the filter dropdown) is computed
// from facets only (tiny — no bodies).
globalKbRoutes.get('/entries', async (c) => {
  const status = c.req.query('status');
  const category = c.req.query('category');
  const framework = c.req.query('framework');
  const sourceTaskId = c.req.query('sourceTaskId');
  if (sourceTaskId && !isUuid(sourceTaskId)) {
    throw new HttpError(400, 'sourceTaskId must be a UUID');
  }
  const q = c.req.query('q')?.trim();
  const page = Math.max(1, Math.floor(Number(c.req.query('page') ?? '1')) || 1);
  const pageSize = Math.min(
    50,
    Math.max(1, Math.floor(Number(c.req.query('pageSize') ?? '12')) || 12),
  );

  const result = await withGlobalKb(getDb(), async ({ db, settings }) => {
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
      .orderBy(desc(globalKbEntries.updatedAt), desc(globalKbEntries.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const facetRows = await db.select({ facets: globalKbEntries.facets }).from(globalKbEntries);
    const frameworks = Array.from(
      new Set(facetRows.flatMap((r) => r.facets?.framework ?? [])),
    ).sort();

    const ctx = await houseRuleContext(settings.namespace);
    return { entries: entries.map((entry) => presentEntry(entry, ctx)), total, frameworks };
  });

  return c.json({
    entries: await withSourceTaskStatus(getDb(), c.get('userId'), result.entries),
    total: result.total,
    page,
    pageSize,
    frameworks: result.frameworks,
  });
});

globalKbRoutes.get('/entries/:id', async (c) => {
  const id = entryIdParam(c.req.param('id'));
  const found = await withGlobalKb(getDb(), async ({ db, settings }) => {
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
    const { usedBytes, entryBytes } = await alwaysBytes(db, settings.namespace, entry);
    return {
      entry: presentEntry(entry, await houseRuleContext(settings.namespace)),
      activeSuccessor: successors[0] ?? null,
      usedBytes,
      capBytes: HOUSE_RULES_ALWAYS_CAP_BYTES,
      entryBytes,
    };
  });
  if (!found) throw new HttpError(404, 'global KB entry not found');
  return c.json(found);
});

globalKbRoutes.post('/entries', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid global KB entry', 'invalid_body');
  const data = parsed.data;
  assertFacetsNameTheirTechnology(data.facets);
  const description = authoredDescription(data.description) ?? null;
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
        description,
        status: data.status ?? 'draft',
        source: 'user',
        embedStatus: 'pending',
      })
      .returning();
    return presentEntry(row!, await houseRuleContext(settings.namespace));
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

/** A description a PERSON typed, ready to store: one line, null when blank, `undefined` when not sent.
 *  Refused over the cap rather than cut, as a silently shortened summary is not what they typed. */
function authoredDescription(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  const line = collapseToLine(raw);
  if (line.length > GLOBAL_KB_DESCRIPTION_MAX) {
    throw new HttpError(
      400,
      `description is ${line.length} characters; the limit is ${GLOBAL_KB_DESCRIPTION_MAX}`,
      'description_too_long',
    );
  }
  return normalizeGlobalKbDescription(line);
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
 *  Enrichment rewrites an entry's title, category, facets, description, body and status when it lands
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
  const id = entryIdParam(c.req.param('id'));
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid update', 'invalid_body');
  const data = parsed.data;
  assertFacetsNameTheirTechnology(data.facets);
  if (Object.keys(data).length === 0) throw new HttpError(400, 'no fields to update');
  const description = authoredDescription(data.description);

  // ONE transaction for read-decide-write-archive. Without it two clients racing the same
  // draft interleave: activation reads `supersedesEntryId` after a concurrent scope edit has
  // decided to clear it but before the clear lands, and archives a predecessor the reviewer
  // had just detached. The UI's button guard cannot prevent that — it only serialises one tab,
  // while a second tab or an API client goes straight at the route.
  const result = await withGlobalKb(getDb(), async ({ db: conn, settings }) =>
    conn.transaction(async (db) => {
      // LOCKED, so a retry's detect — a plain UPDATE to `enriching` — waits for this transaction
      // instead of flipping the status between the check and the write.
      const current = await lockEntry(db, id);
      if (!current) {
        return {
          row: undefined,
          supersededId: null,
          reembed: false,
          namespace: settings.namespace,
        };
      }
      const blocked = enrichmentBlocksEdit(current.status);
      if (blocked) throw new HttpError(409, blocked, 'entry_enrichment_pending');
      const set: Partial<typeof globalKbEntries.$inferInsert> = { updatedAt: new Date() };
      if (data.title !== undefined) set.title = data.title;
      if (data.body !== undefined) set.body = data.body;
      if (data.category !== undefined) set.category = data.category;
      if (data.facets !== undefined) set.facets = normalizeFacets(data.facets as GlobalKbFacets);
      if (data.status !== undefined) set.status = data.status;
      if (description !== undefined) set.description = description;
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
      // Only a changed title or body, or an entry becoming active, has anything to embed; pending
      // is what lets the worker re-queue a sync whose enqueue below is lost.
      const becomesActive = data.status === 'active' && current.status !== 'active';
      const reembed =
        becomesActive ||
        (data.title !== undefined && data.title !== current.title) ||
        (data.body !== undefined && data.body !== current.body);
      if (reembed) set.embedStatus = 'pending';
      // Done here and not by the trigger: a reverted edit must not revive the approval, and the
      // token is blind to the facet order a backfill rewrites.
      if (
        current.enforcedHash != null &&
        houseRuleContentToken({ ...current, ...set }) !== houseRuleContentToken(current)
      ) {
        set.enforcedHash = null;
      }
      // A SCOPE edit invalidates a proposed supersession. The link was decided by comparing this
      // draft's article against the entry it would replace; re-scoping it to another technology
      // makes it a different rule, and activating it would then archive an entry it no longer has
      // anything to do with. Cleared rather than revalidated — revalidating needs an embedding
      // pass, and a stale duplicate the reviewer can archive by hand is a far cheaper mistake than
      // silently retiring the wrong article. Keyed on the FILTER dimensions, so a tags-only edit
      // (tags do not scope retrieval) leaves a valid link alone.
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
        if (current.supersedesEntryId && scopeChanged(current.facets, set.facets)) {
          set.supersedesEntryId = null;
        }
        // The same holds for a link POINTING AT this entry: it was decided against the old scope
        // too. Left in place, activating that replacement — a reactivation included — archives
        // this entry although the two rules no longer share a scope, and the successor lookup
        // keeps warning that it has been replaced. Their `updatedAt` is left alone, for the
        // list-order reason the activation's predecessor archive gives.
        if (scopeChanged(current.facets, set.facets)) {
          await db
            .update(globalKbEntries)
            .set({ supersedesEntryId: null })
            .where(eq(globalKbEntries.supersedesEntryId, id));
        }
      }
      const rekeyed = rescopedTopicKey(current, { category: set.category, facets: set.facets });
      if (rekeyed !== undefined) set.topicKey = rekeyed;
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
      if (row && becomesActive && row.supersedesEntryId) {
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
      return { row, supersededId, reembed, namespace: settings.namespace };
    }),
  ).catch(lockBusyError);

  const entry = result.row;
  if (!entry) throw new HttpError(404, 'global KB entry not found');
  if (result.reembed) await enqueueSync(entry.id, entry.namespace, 'upsert');
  if (result.supersededId) await enqueueSync(result.supersededId, entry.namespace, 'delete');
  return c.json({ entry: presentEntry(entry, await houseRuleContext(result.namespace)) });
});

// Hard delete (single-operator instance; no shared-corpus concern). The UI guards this with a
// confirm since it is irreversible. The row and its vectors go in ONE transaction: a chunk whose
// entry is gone is still served — `expandGlobalHits` returns a global hit it has no body for
// unchanged — so leaving the vectors to the enqueued sync kept a deleted rule retrievable whenever
// that enqueue failed. The sync is still enqueued, and finds nothing left to remove.
globalKbRoutes.delete('/entries/:id', async (c) => {
  const id = entryIdParam(c.req.param('id'));
  const entry = await withGlobalKb(getDb(), async ({ db: conn }) =>
    conn.transaction(async (db) => {
      if (!(await lockEntry(db, id))) return undefined;
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
  ).catch(lockBusyError);
  if (!entry) throw new HttpError(404, 'global KB entry not found');
  await enqueueSync(entry.id, entry.namespace, 'delete');
  return c.json({ ok: true });
});

const enforcementSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('always'), expectedHash: z.string().min(1) }).strict(),
  z
    .object({
      mode: z.literal('files'),
      globs: z.array(z.string()),
      expectedHash: z.string().min(1),
    })
    .strict(),
]);

function enforcementAuditMetadata(namespace: string, spec: EnforceSpec): Record<string, unknown> {
  return {
    namespace,
    mode: spec.mode,
    ...(spec.mode === 'files' ? { globCount: spec.globs.length } : {}),
  };
}

// Enforcing puts the entry's full text into agent prompts as an instruction, so it is an admin's
// call on exactly the text they saw: `expectedHash` is the content token of the entry they read.
globalKbRoutes.put('/entries/:id/enforcement', requireAdmin, async (c) => {
  const id = entryIdParam(c.req.param('id'));
  const parsed = enforcementSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'invalid enforcement request', 'invalid_body');
  const { expectedHash } = parsed.data;
  const spec: EnforceSpec =
    parsed.data.mode === 'always'
      ? { mode: 'always' }
      : { mode: 'files', globs: parsed.data.globs };
  if (spec.mode === 'files') {
    const problem = validateHouseRuleGlobs(spec.globs);
    if (problem !== null) throw new HttpError(400, problem, 'invalid_globs');
  }
  const userId = c.get('userId');

  const result = await withGlobalKb(getDb(), async ({ db: conn, settings }) =>
    auditedChange(
      {
        actorUserId: userId,
        action: 'global_kb.house_rule.enforce',
        targetType: 'global_kb_entry',
        targetId: id,
        metadata: enforcementAuditMetadata(settings.namespace, spec),
      },
      () =>
        conn.transaction(async (db) => {
          const row = await lockEntry(db, id);
          if (!row) throw new HttpError(404, 'global KB entry not found');
          if (row.status !== 'active') {
            throw new HttpError(409, 'only an active entry can be enforced', 'not_active');
          }
          if (row.namespace !== settings.namespace) {
            throw new HttpError(
              409,
              `this entry belongs to the namespace "${row.namespace}", not to the one this instance uses`,
              'other_namespace',
            );
          }
          if (houseRuleContentToken(row) !== expectedHash) {
            throw new HttpError(
              409,
              'the entry changed after it was read; read it again before enforcing it',
              'token_mismatch',
            );
          }
          if (!collapseToLine(row.description ?? '')) {
            throw new HttpError(
              400,
              'an enforced rule is listed by its description, so the entry needs one',
              'description_required',
            );
          }
          for (const field of ['title', 'description', 'body'] as const) {
            const reason = refusedHouseRuleText(row[field] ?? '');
            if (reason !== null) throw new HttpError(400, `${field} ${reason}`, 'refused_text');
          }
          if (spec.mode === 'always') {
            const { usedBytes, entryBytes } = await alwaysBytes(db, settings.namespace, row);
            if (usedBytes + entryBytes > HOUSE_RULES_ALWAYS_CAP_BYTES) {
              // A refusal must throw through both transactions, including the audit row's.
              throw new HTTPException(409, {
                res: c.json(
                  {
                    error: 'the always-on rules would pass their size cap',
                    code: 'always_cap',
                    usedBytes,
                    capBytes: HOUSE_RULES_ALWAYS_CAP_BYTES,
                    entryBytes,
                  },
                  409,
                ),
              });
            }
          }
          const [updated] = await db
            .update(globalKbEntries)
            .set({
              enforce: spec,
              enforcedHash: houseRuleApprovalHash(row, spec),
              enforcedAt: new Date(),
              enforcedBy: userId,
            })
            .where(eq(globalKbEntries.id, id))
            .returning();
          return { row: updated!, namespace: settings.namespace };
        }),
    ),
  ).catch(lockBusyError);

  return c.json({ entry: presentEntry(result.row, await houseRuleContext(result.namespace)) });
});

// Removes the approval and keeps the settings, as the last ones given.
globalKbRoutes.delete('/entries/:id/enforcement', requireAdmin, async (c) => {
  const id = entryIdParam(c.req.param('id'));
  const result = await withGlobalKb(getDb(), async ({ db: conn, settings }) => {
    // Read the audit context before opening the store transaction, then verify it under its lock.
    const [seen] = await conn.select().from(globalKbEntries).where(eq(globalKbEntries.id, id));
    if (!seen) throw new HttpError(404, 'global KB entry not found');
    if (seen.enforce === null) {
      throw new HttpError(404, 'this entry was never enforced', 'not_enforced');
    }
    const metadata = enforcementAuditMetadata(seen.namespace, seen.enforce);
    return auditedChange(
      {
        actorUserId: c.get('userId'),
        action: 'global_kb.house_rule.unenforce',
        targetType: 'global_kb_entry',
        targetId: id,
        metadata,
      },
      () =>
        conn.transaction(async (db) => {
          const row = await lockEntry(db, id);
          if (!row) throw new HttpError(404, 'global KB entry not found');
          if (row.enforce === null) {
            throw new HttpError(404, 'this entry was never enforced', 'not_enforced');
          }
          if (
            JSON.stringify(enforcementAuditMetadata(row.namespace, row.enforce)) !==
            JSON.stringify(metadata)
          ) {
            throw new HttpError(
              409,
              'the enforcement changed; retry the removal',
              'enforcement_changed',
            );
          }
          const [updated] = await db
            .update(globalKbEntries)
            .set({ enforcedHash: null })
            .where(eq(globalKbEntries.id, id))
            .returning();
          return { row: updated!, namespace: settings.namespace };
        }),
    );
  }).catch(lockBusyError);
  return c.json({ entry: presentEntry(result.row, await houseRuleContext(result.namespace)) });
});

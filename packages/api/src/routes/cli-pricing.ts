import { z } from 'zod';
import { Hono } from 'hono';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CLI_EXEC_JOB_NAMES,
  CLI_PROVIDER_LIST,
  DISPLAY_CURRENCIES,
  PRICE_FEEDS,
  logger,
  normalizeModelKey,
  type CliProviderName,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getCliExecQueue } from '../queues.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

const log = logger.child({ module: 'cli-pricing' });

export const cliPricingRoutes = new Hono<AppEnv>();

cliPricingRoutes.use('*', requireAuth);
cliPricingRoutes.use('*', requireAdmin);

const PROVIDER_NAMES = CLI_PROVIDER_LIST.map((p) => p.name) as [
  CliProviderName,
  ...CliProviderName[],
];

/** A rate may price only some buckets — a model with no caching legitimately has no
 *  cache rates — so every field is independently optional. `null` means "no rate",
 *  which is NOT the same as 0: a 0 rate says the tokens are free, and a wrong "free"
 *  is the one error that silently loses money. */
const ratesSchema = z.object({
  inputRate: z.number().min(0).nullable(),
  outputRate: z.number().min(0).nullable(),
  cacheReadRate: z.number().min(0).nullable(),
  cacheWriteRate: z.number().min(0).nullable(),
  cacheWrite1hRate: z.number().min(0).nullable(),
});

const manualPriceSchema = z.object({
  // null = a vendor-wide rate, applying to this model id under any provider.
  provider: z.enum(PROVIDER_NAMES).nullable(),
  modelKey: z.string().min(1).max(200),
  rates: ratesSchema,
  note: z.string().max(500).nullable().optional(),
});

const syncToggleSchema = z.object({
  autoUpdateEnabled: z.boolean().optional(),
  preferredFeed: z.enum(PRICE_FEEDS).nullable().optional(),
});

/** Everything the pricing admin page renders: per-CLI sync state plus the live rates.
 *
 *  Live rows only (`effective_to IS NULL`). The superseded rows are the price HISTORY
 *  and are served separately per model, because the whole table's history is unbounded
 *  while one model's is a handful of rows. */
cliPricingRoutes.get('/', async (c) => {
  const db = getDb();
  const [syncRows, priceRows] = await Promise.all([
    db.select().from(schema.cliPricingSync),
    db
      .select()
      .from(schema.cliModelPrices)
      .where(isNull(schema.cliModelPrices.effectiveTo))
      .orderBy(schema.cliModelPrices.provider, schema.cliModelPrices.modelKey),
  ]);

  const bySync = new Map(syncRows.map((r) => [r.name, r]));
  return c.json({
    currencies: DISPLAY_CURRENCIES,
    feeds: PRICE_FEEDS,
    providers: CLI_PROVIDER_LIST.map((p) => {
      const row = bySync.get(p.name);
      return {
        name: p.name,
        displayName: p.displayName,
        costBasis: p.costBasis,
        // Default true rather than false for a provider with no row yet, matching the
        // column default — an unseeded provider must price normally, not silently stop.
        autoUpdateEnabled: row?.autoUpdateEnabled ?? true,
        preferredFeed: row?.preferredFeed ?? null,
        fetchedAt: row?.fetchedAt ?? null,
        fetchError: row?.fetchError ?? null,
        priceCount: row?.priceCount ?? 0,
      };
    }),
    prices: priceRows.map((r) => ({
      id: r.id,
      provider: r.provider,
      modelKey: r.modelKey,
      source: r.source,
      rates: r.rates,
      currency: r.currency,
      note: r.note,
      effectiveFrom: r.effectiveFrom,
    })),
  });
});

/** Price history for one model: every row ever effective, newest first. This is what a
 *  future price-over-time chart reads; it is per-model because the whole table's
 *  history grows without bound while one model's stays small. */
cliPricingRoutes.get('/history', async (c) => {
  const db = getDb();
  const modelKey = normalizeModelKey(c.req.query('modelKey'));
  if (!modelKey) throw new HttpError(400, 'modelKey is required');
  const providerParam = c.req.query('provider');
  const rows = await db
    .select()
    .from(schema.cliModelPrices)
    .where(
      and(
        eq(schema.cliModelPrices.modelKey, modelKey),
        providerParam
          ? eq(schema.cliModelPrices.provider, providerParam as CliProviderName)
          : sql`true`,
      ),
    )
    .orderBy(desc(schema.cliModelPrices.effectiveFrom));
  return c.json({ modelKey, history: rows });
});

/** Per-CLI auto-update toggle and feed preference.
 *
 *  `autoUpdateEnabled: false` means this provider's rates are ADMIN-OWNED: the sync
 *  stops writing feed rows for it, and — the part that matters — the cost path stops
 *  READING feed rows for it, so only manual rates apply. Enforced on the read side too
 *  precisely so the switch takes effect on the next invocation rather than at the next
 *  12-hourly refresh. */
cliPricingRoutes.put('/providers/:name', async (c) => {
  const db = getDb();
  const name = c.req.param('name') as CliProviderName;
  if (!PROVIDER_NAMES.includes(name)) throw new HttpError(404, 'unknown cli provider');
  const patch = syncToggleSchema.parse(await c.req.json());

  const values = {
    name,
    ...(patch.autoUpdateEnabled !== undefined
      ? { autoUpdateEnabled: patch.autoUpdateEnabled }
      : {}),
    ...(patch.preferredFeed !== undefined ? { preferredFeed: patch.preferredFeed } : {}),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(schema.cliPricingSync)
    .values(values)
    .onConflictDoUpdate({ target: schema.cliPricingSync.name, set: values })
    .returning();
  log.info({ name, patch }, 'cli pricing sync settings updated');
  return c.json(row);
});

/** Create or replace a MANUAL rate — the escape hatch for a negotiated or enterprise
 *  price a public feed cannot know.
 *
 *  A write CLOSES the previous manual row rather than updating it in place, so an
 *  override carries the same effective-dated history as a synced rate and a task priced
 *  last month still reports what it actually cost. */
cliPricingRoutes.post('/prices', async (c) => {
  const db = getDb();
  const body = manualPriceSchema.parse(await c.req.json());
  const modelKey = normalizeModelKey(body.modelKey);
  if (!modelKey) throw new HttpError(400, 'modelKey is required');
  const rates = body.rates;
  if (Object.values(rates).every((v) => v === null)) {
    // A row of nulls prices nothing and would only shadow the feed row it outranks.
    throw new HttpError(400, 'at least one rate must be set');
  }

  const now = new Date();
  const row = await db.transaction(async (tx) => {
    await tx
      .update(schema.cliModelPrices)
      .set({ effectiveTo: now })
      .where(
        and(
          isNull(schema.cliModelPrices.effectiveTo),
          eq(schema.cliModelPrices.source, 'manual'),
          eq(schema.cliModelPrices.modelKey, modelKey),
          body.provider === null
            ? isNull(schema.cliModelPrices.provider)
            : eq(schema.cliModelPrices.provider, body.provider),
        ),
      );
    const [created] = await tx
      .insert(schema.cliModelPrices)
      .values({
        provider: body.provider,
        modelKey,
        source: 'manual',
        rates,
        note: body.note ?? null,
        effectiveFrom: now,
      })
      .returning();
    return created;
  });
  log.info({ provider: body.provider, modelKey }, 'manual model price set');
  return c.json(row, 201);
});

/** Retire a manual rate. Closes it rather than deleting it: the rows that priced past
 *  invocations must stay readable, and reopening the feed rate is what "delete" means
 *  here anyway. A synced row is never retired this way — turn the provider's
 *  auto-update off instead, which is the reversible action. */
cliPricingRoutes.delete('/prices/:id', async (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const existing = await db.query.cliModelPrices.findFirst({
    where: eq(schema.cliModelPrices.id, id),
  });
  if (!existing) throw new HttpError(404, 'price row not found');
  if (existing.source !== 'manual') {
    throw new HttpError(
      400,
      'only manual rates can be retired; disable auto-update for the provider instead',
    );
  }
  if (existing.effectiveTo) return c.json({ ok: true, alreadyRetired: true });
  await db
    .update(schema.cliModelPrices)
    .set({ effectiveTo: new Date() })
    .where(eq(schema.cliModelPrices.id, id));
  log.info({ id, modelKey: existing.modelKey }, 'manual model price retired');
  return c.json({ ok: true });
});

/** Refresh now. Reuses the existing REFRESH_VERSIONS job rather than adding a pricing
 *  job: prices ride that job precisely so one button refreshes versions, the OpenRouter
 *  catalog, rates and FX together. */
cliPricingRoutes.post('/refresh', async (c) => {
  const queue = getCliExecQueue();
  const job = await queue.add(
    CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
    { force: true },
    { removeOnComplete: true, removeOnFail: 10 },
  );
  log.info({ jobId: job.id }, 'manual price refresh enqueued');
  return c.json({ jobId: job.id });
});

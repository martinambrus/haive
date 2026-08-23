import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  isOllamaCloudModel,
  logger,
  normalizeModelKey,
  ollamaModelPageSlug,
  ollamaModelPageUrl,
  parseOllamaModelPage,
  type ModelPriceRates,
} from '@haive/shared';

const log = logger.child({ module: 'ollama-price-refresh' });

/** Shorter than the 30s the LiteLLM and OpenRouter refreshers use, deliberately: those
 *  are ONE request each for a multi-megabyte document, this is one small page per
 *  configured cloud model, run sequentially. At 30s apiece a dozen hung pages would
 *  hold the shared REFRESH_VERSIONS job for six minutes. */
const FETCH_TIMEOUT_MS = 10_000;

/** Identify the crawler. One request per configured model per 12-hourly tick is
 *  negligible traffic, but an anonymous scraper is the kind that gets blocked. */
const USER_AGENT = 'haive-price-sync (+https://github.com/haive)';

export interface OllamaPriceRow {
  /** The full configured model id, normalized — `kimi-k3:cloud`, not the page slug.
   *  The tag is the SKU marker and the cost path looks the rate up under the id the
   *  CLI reports, which carries it. */
  modelKey: string;
  rates: ModelPriceRates;
}

export interface OllamaPriceFetch {
  rows: OllamaPriceRow[];
  errors: string[];
}

/** Scrape the published per-token rates for the Ollama Cloud models this install has
 *  actually configured.
 *
 *  WHY a scrape. Ollama publishes no price document and no pricing API — `/pricing`
 *  lists plans and difficulty grades, not rates — so the model page is the only place
 *  a number is stated. MEASURED 2026-08-23 across all eight configured cloud models,
 *  exactly one (`kimi-k3`) publishes a cost block; the rest are plan-included and
 *  correctly end up unpriced.
 *
 *  Bounded to CONFIGURED CLOUD models, never the whole library. Cloud-only for two
 *  reasons: a local model's cost is electricity rather than tokens, and — the one that
 *  matters — a stored rate on a `local`-basis invocation would be summed as REAL
 *  spend, since only the `subscription` basis is non-billable. Not pricing a local
 *  model is therefore a guard, not just a saved request.
 *
 *  Never throws. Same discipline as its two sibling refreshers: this runs inside the
 *  shared REFRESH_VERSIONS job, and one unreachable page must neither fail that job
 *  nor disturb rates that were good a minute ago. A model that yields nothing this
 *  tick simply contributes no desired row, and `applyDesiredRows` leaves its stored
 *  row open — a page that stopped stating a price does not mean the model became
 *  free. */
export async function fetchOllamaModelPrices(db: Database): Promise<OllamaPriceFetch> {
  const providers = await db
    .select({ model: schema.cliProviders.model })
    .from(schema.cliProviders)
    .where(eq(schema.cliProviders.name, 'ollama'));

  // One page can document several configured tags (`kimi-k3:cloud` and a future
  // `kimi-k3:1t-cloud` are both `/library/kimi-k3`), so fetch per SLUG and fan the
  // result back out to every model id that resolved to it.
  const bySlug = new Map<string, string[]>();
  for (const row of providers) {
    const model = row.model ?? '';
    if (!isOllamaCloudModel(model)) continue;
    const modelKey = normalizeModelKey(model);
    const slug = ollamaModelPageSlug(model);
    if (modelKey === null || slug === null) continue;
    const keys = bySlug.get(slug) ?? [];
    if (!keys.includes(modelKey)) keys.push(modelKey);
    bySlug.set(slug, keys);
  }

  const rows: OllamaPriceRow[] = [];
  const errors: string[] = [];
  let priced = 0;
  let unpublished = 0;

  for (const [slug, modelKeys] of bySlug) {
    const url = ollamaModelPageUrl(slug);
    if (url === null) continue;
    let html: string;
    try {
      const resp = await fetch(url, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // A 404 is a configured model that has no library page (a user's own build, or a
      // renamed model). Not an error worth surfacing on the sync row — there is simply
      // nothing published for it, which is the same answer as a page with no block.
      if (resp.status === 404) {
        unpublished++;
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      html = await resp.text();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn({ slug, error }, 'failed to fetch ollama model page');
      errors.push(`${slug}: ${error}`);
      continue;
    }

    const parsed = parseOllamaModelPage(html);
    if (parsed.kind === 'none') {
      // The COMMON path: plan-included, no published rate. Debug, never warn — this is
      // 7 of 8 models, and logging it as a problem would make every tick cry wolf.
      unpublished++;
      log.debug({ slug }, 'ollama model page publishes no rate');
      continue;
    }
    if (parsed.kind === 'error') {
      // A block that exists and cannot be read. Loud, and nothing is written: a guessed
      // or zeroed rate is worse than no rate, because it looks like money.
      log.error({ slug, reason: parsed.reason }, 'ollama model page has an unreadable cost block');
      errors.push(`${slug}: ${parsed.reason}`);
      continue;
    }
    priced++;
    for (const modelKey of modelKeys) rows.push({ modelKey, rates: parsed.rates });
  }

  if (bySlug.size > 0) {
    log.info({ pages: bySlug.size, priced, unpublished }, 'scraped ollama model prices');
  }
  return { rows, errors };
}

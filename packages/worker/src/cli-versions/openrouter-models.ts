import { schema, type Database } from '@haive/database';
import {
  logger,
  trimOpenRouterModels,
  type RefreshCliVersionsJobResult,
  type OpenRouterModelEntry,
} from '@haive/shared';

const log = logger.child({ module: 'openrouter-model-refresh' });

// Public and unauthenticated — no key needed to list the catalog, which is what
// lets the picker populate before the user has saved a provider secret.
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
// The full payload is ~4 MB; generous but bounded so a hung gateway cannot wedge
// the shared REFRESH_VERSIONS job that also refreshes CLI + tool versions.
const FETCH_TIMEOUT_MS = 30_000;

/** Refresh the cached OpenRouter model catalog.
 *
 *  Mirrors `refreshAllCliVersions` deliberately, including the failure branch that
 *  RECORDS the error on the row instead of throwing: this runs inside the same job
 *  as the CLI/tool version refresh, and a gateway blip must not fail that job or
 *  wipe a previously good catalog. On error the existing `models` array is left
 *  untouched and only `fetch_error` moves, so the picker keeps working from the
 *  last good fetch and the form can surface the staleness.
 *
 *  Returns the shared refresh result shape so the caller can concatenate it with
 *  the CLI and tool results without a special case. */
export async function refreshOpenRouterModels(db: Database): Promise<RefreshCliVersionsJobResult> {
  try {
    const resp = await fetch(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`${OPENROUTER_MODELS_URL} HTTP ${resp.status}`);
    const models: OpenRouterModelEntry[] = trimOpenRouterModels(await resp.json());
    // An empty catalog from a 200 means the payload shape changed under us. Treat it
    // as an error rather than overwriting a good cache with nothing — a picker with
    // no options is indistinguishable from "OpenRouter has no models".
    if (models.length === 0) throw new Error('model catalog parsed to 0 entries');
    await db
      .insert(schema.openrouterModelCache)
      .values({
        name: 'openrouter',
        models,
        fetchedAt: new Date(),
        fetchError: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.openrouterModelCache.name,
        set: {
          models,
          fetchedAt: new Date(),
          fetchError: null,
          updatedAt: new Date(),
        },
      });
    log.info({ count: models.length }, 'refreshed openrouter model catalog');
    return {
      ok: true,
      refreshed: [{ name: 'openrouter', count: models.length, latest: null }],
      errors: [],
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ error }, 'failed to refresh openrouter model catalog');
    await db
      .insert(schema.openrouterModelCache)
      .values({
        name: 'openrouter',
        models: [],
        fetchedAt: null,
        fetchError: error,
        updatedAt: new Date(),
      })
      // Only the error moves on conflict — a previously good `models` array survives.
      .onConflictDoUpdate({
        target: schema.openrouterModelCache.name,
        set: { fetchError: error, updatedAt: new Date() },
      });
    return { ok: false, refreshed: [], errors: [{ name: 'openrouter', error }] };
  }
}

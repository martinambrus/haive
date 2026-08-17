/**
 * OpenRouter's model catalog, trimmed to what Haive actually reads.
 *
 * The gateway fronts 400+ models, so the provider form cannot offer a static list
 * and a hand-typed slug is a 404 that only surfaces on the first run. The worker
 * caches `GET https://openrouter.ai/api/v1/models` into `openrouter_model_cache`
 * on the same job that refreshes CLI package versions; this module owns the shape
 * and the pure trim, so the parsing is testable without a network call.
 */

/** One cached model. Mirrors the `$type` on `openrouter_model_cache.models` — the
 *  database package cannot import this (shared imports database, not the reverse),
 *  so the two are kept in sync by hand, exactly like `cli_providers.model_limits`. */
export interface OpenRouterModelEntry {
  /** OpenRouter slug, e.g. `anthropic/claude-opus-5`. Stored in cli_providers.model. */
  id: string;
  /** Human label, e.g. "Anthropic: Claude Opus 5". */
  name: string;
  /** Max input tokens the gateway reports. Feeds the context-window display. */
  contextLength: number | null;
  /** USD per token. Upstream sends these as decimal STRINGS; parsed on ingest. */
  promptPrice: number | null;
  completionPrice: number | null;
  /** Whether `supported_parameters` advertises a reasoning knob. Drives whether the
   *  effort selector is worth offering — NOT a correctness gate: OpenRouter validates
   *  `output_config.effort` globally and models without reasoning accept every level
   *  with a 200, normalizing it away. See the effort note in cli-adapters/openrouter.ts. */
  supportsReasoning: boolean;
  /** Whether `supported_parameters` advertises `tools`. This one IS load-bearing:
   *  Claude Code drives everything through native tool use, so a model without it
   *  cannot run a Haive step at all. */
  supportsTools: boolean;
  /** Whether `architecture.input_modalities` includes `image`. */
  supportsImages: boolean;
}

/** The subset of OpenRouter's `/api/v1/models` payload this module reads. Everything
 *  is optional because the gateway adds fields freely and a missing one must degrade
 *  to a conservative default rather than throw. */
interface RawOpenRouterModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown };
}

/** Upstream sends prices as decimal strings ("0.00001"). Returns null for anything
 *  non-finite so a malformed price shows as "unknown" rather than 0 — a displayed
 *  0 would read as "free", which is the one wrong answer that costs money. */
function parsePrice(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasStringItem(value: unknown, item: string): boolean {
  return Array.isArray(value) && value.some((entry) => entry === item);
}

/** Trim a raw `/api/v1/models` payload to the cached shape.
 *
 *  Skips entries with no usable `id` (the slug is the only field that is truly
 *  required — it is what gets written to cli_providers.model). Capability flags
 *  default to FALSE when the field is absent: an unknown capability must not be
 *  advertised, since `supportsTools` decides whether a model is offered at all. */
export function trimOpenRouterModels(payload: unknown): OpenRouterModelEntry[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: OpenRouterModelEntry[] = [];
  for (const raw of data as RawOpenRouterModel[]) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (!id) continue;
    const params = raw.supported_parameters;
    out.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : id,
      contextLength:
        typeof raw.context_length === 'number' && Number.isFinite(raw.context_length)
          ? raw.context_length
          : null,
      promptPrice: parsePrice(raw.pricing?.prompt),
      completionPrice: parsePrice(raw.pricing?.completion),
      supportsReasoning: hasStringItem(params, 'reasoning'),
      supportsTools: hasStringItem(params, 'tools'),
      supportsImages: hasStringItem(raw.architecture?.input_modalities, 'image'),
    });
  }
  // Stable order so the picker does not reshuffle between refreshes.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

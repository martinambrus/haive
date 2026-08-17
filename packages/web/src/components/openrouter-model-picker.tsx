'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type OpenRouterModelEntry } from '@/lib/api-client';
import { Input } from '@/components/ui';
import { isUnknownModel, optionLabel, visibleModelOptions } from '@/lib/openrouter-model-options';

/** Model picker for an OpenRouter provider, backed by the cached catalog.
 *
 *  Three behaviours that are deliberate rather than incidental:
 *
 *  1. It DEGRADES to a free-text field whenever the cache is unusable — empty,
 *     never refreshed, or errored. The picker is an affordance; being unable to
 *     reach OpenRouter's catalog must never block creating a provider.
 *  2. The currently saved model is always offered, even when the catalog does not
 *     contain it (removed upstream, or typed before this picker existed). Without
 *     that, opening the form would silently rewrite a working provider's model to
 *     whatever the select defaulted to.
 *  3. Models whose `supported_parameters` lacks `tools` are shown but NOT
 *     selectable. Claude Code drives everything through native tool use, so such a
 *     model cannot run a Haive step at all — offering it would only produce a
 *     provider that fails on its first invocation. They stay visible so the absence
 *     is explained rather than mysterious.
 */
export function OpenRouterModelPicker({
  value,
  onChange,
  onSelectedMetaChange,
}: {
  value: string;
  onChange: (model: string) => void;
  /** Reports the catalog entry for the current value (null when unknown), so the
   *  form can decide whether a reasoning-effort selector is worth showing. */
  onSelectedMetaChange?: (entry: OpenRouterModelEntry | null) => void;
}) {
  const [models, setModels] = useState<OpenRouterModelEntry[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<{
          models: OpenRouterModelEntry[];
          fetchedAt: string | null;
          fetchError: string | null;
        }>('/cli-providers/openrouter/models');
        if (cancelled) return;
        setModels(data.models ?? []);
        setFetchedAt(data.fetchedAt);
        setFetchError(data.fetchError);
      } catch (err) {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(() => models.find((m) => m.id === value) ?? null, [models, value]);

  // Keyed on `selected` only, deliberately: onSelectedMetaChange is defined inline
  // by the parent, so a new identity arrives every render and including it here
  // would re-fire this on every render.
  useEffect(() => {
    onSelectedMetaChange?.(selected);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(
    () => visibleModelOptions(models, filter, value),
    [models, filter, value],
  );

  const unknownValue = isUnknownModel(models, value);

  // Cache unusable: fall back to the plain text field rather than an empty select.
  if (!loading && models.length === 0) {
    return (
      <div>
        <Input
          id="model"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="anthropic/claude-opus-5"
        />
        <p className="mt-1 text-xs text-amber-500">
          Model catalog unavailable{fetchError ? `: ${fetchError}` : ''}. Enter an OpenRouter slug
          by hand (<code className="font-mono">vendor/model</code>), or refresh the catalog with the
          version-refresh button above.
        </p>
      </div>
    );
  }

  return (
    <div>
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={loading ? 'Loading models…' : `Filter ${models.length} models…`}
        disabled={loading}
      />
      <select
        id="model"
        className="mt-2 h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading}
      >
        <option value="">— select a model —</option>
        {unknownValue && <option value={value}>{value} (not in catalog — kept as saved)</option>}
        {visible.map((m) => (
          <option key={m.id} value={m.id} disabled={!m.supportsTools}>
            {optionLabel(m)}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-neutral-500">
        The OpenRouter model this provider runs (required). Models without native tool support are
        listed but cannot be selected — Claude Code cannot run a step without tools.
        {fetchedAt && ` Catalog fetched ${new Date(fetchedAt).toLocaleString()}.`}
      </p>
      {fetchError && (
        <p className="mt-1 text-xs text-amber-500">
          Last refresh failed ({fetchError}); showing the previous catalog.
        </p>
      )}
      {unknownValue && (
        <p className="mt-1 text-xs text-amber-500">
          The saved model <code className="font-mono">{value}</code> is not in the current catalog.
          It has been kept as-is; pick another only if you mean to change it.
        </p>
      )}
    </div>
  );
}

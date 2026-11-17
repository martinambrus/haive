'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { RefreshCliVersionsJobResult } from '@haive/shared/constants';
import { api } from '@/lib/api-client';
import { runPricingRefresh, type QueuedJobPhase } from '@/lib/cli-jobs';
import { Button, Badge, Input, FormError } from '@/components/ui';
import { PromptTierUnknown } from '@/components/prompt-tier-unknown';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { LatestRefresh } from '@/components/latest-refresh';
import { usePageTitle } from '@/lib/use-page-title';

const selectClass =
  'rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-indigo-500';

interface ModelRates {
  inputRate: number | null;
  outputRate: number | null;
  cacheReadRate: number | null;
  cacheWriteRate: number | null;
  cacheWrite1hRate: number | null;
}

interface TierDraft {
  aboveTokens: string;
  inclusive: boolean;
  rates: Record<keyof ModelRates, string>;
}
const RATE_LABELS: [keyof ModelRates, string][] = [
  ['inputRate', 'Input /M'],
  ['outputRate', 'Output /M'],
  ['cacheReadRate', 'Cache read /M'],
  ['cacheWriteRate', 'Cache write /M'],
  ['cacheWrite1hRate', 'Cache write 1h /M'],
];
const rateDraft = (rates: ModelRates) =>
  Object.fromEntries(
    RATE_LABELS.map(([key]) => [
      key,
      rates[key] === null ? '' : String(Number((rates[key]! * 1_000_000).toPrecision(12))),
    ]),
  ) as Record<keyof ModelRates, string>;
const tierDraft = (tier: ModelRates & { aboveTokens: number; inclusive: boolean }): TierDraft => ({
  aboveTokens: String(tier.aboveTokens),
  inclusive: tier.inclusive,
  rates: rateDraft(tier),
});

interface PriceRow {
  id: string;
  provider: string | null;
  modelKey: string;
  source: 'openrouter' | 'litellm' | 'manual' | 'ollama';
  rates: ModelRates & {
    tiers?: (ModelRates & { aboveTokens: number; inclusive: boolean })[] | null;
    pricingState?: 'unsupported';
  };
  currency: string;
  note: string | null;
  effectiveFrom: string;
}

interface ProviderRow {
  name: string;
  displayName: string;
  costBasis: string;
  autoUpdateEnabled: boolean;
  preferredFeed: string | null;
  fetchedAt: string | null;
  fetchError: string | null;
  priceCount: number;
}

interface PricingResponse {
  currencies: string[];
  feeds: string[];
  providers: ProviderRow[];
  prices: PriceRow[];
  unknownTierInvocations?: {
    id: string;
    modelKey: string | null;
    tier: { lowUsd?: number; highUsd?: number };
  }[];
}

const EMPTY_RATES: ModelRates = {
  inputRate: null,
  outputRate: null,
  cacheReadRate: null,
  cacheWriteRate: null,
  cacheWrite1hRate: null,
};

/** Rates are per single token — numbers like 0.0000005 that no one can read. Per
 *  MILLION tokens is how every vendor quotes them, so that is what the table shows and
 *  what the editor takes; the conversion happens only at the edges. */
function perMillion(rate: number | null): string {
  return rate === null ? '—' : `$${(rate * 1_000_000).toFixed(2)}`;
}

function parsePerMillion(value: string): number | null {
  const trimmed = value.trim();
  // Empty means "no rate", which is NOT zero: a 0 rate says the tokens are free.
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) throw new Error('Rates must be non-negative numbers or empty');
  return Number((n / 1_000_000).toPrecision(12));
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function PricingPage() {
  usePageTitle('Model pricing');

  const [data, setData] = useState<PricingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshPhase, setRefreshPhase] = useState<QueuedJobPhase | null>(null);
  const [refreshResult, setRefreshResult] = useState<RefreshCliVersionsJobResult | null>(null);
  const refreshAbort = useRef<AbortController | null>(null);
  useEffect(() => () => refreshAbort.current?.abort(), []);
  const [filter, setFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');

  const [draft, setDraft] = useState<{
    provider: string;
    modelKey: string;
    note: string;
    rates: Record<keyof ModelRates, string>;
    tiers?: TierDraft[];
  }>({
    provider: '',
    modelKey: '',
    note: '',
    rates: {
      inputRate: '',
      outputRate: '',
      cacheReadRate: '',
      cacheWriteRate: '',
      cacheWrite1hRate: '',
    },
  });

  const load = useCallback(async () => {
    try {
      setData(await api.get<PricingResponse>('/cli-pricing'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pricing');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleProvider(name: string, autoUpdateEnabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/cli-pricing/providers/${name}`, { autoUpdateEnabled });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update provider');
    } finally {
      setBusy(false);
    }
  }

  async function refreshNow() {
    if (refreshAbort.current) return;
    const controller = new AbortController();
    refreshAbort.current = controller;
    setRefreshPhase('queued');
    setError(null);
    setRefreshResult(null);
    try {
      const result = await runPricingRefresh(setRefreshPhase, controller.signal);
      if (!controller.signal.aborted) {
        setRefreshResult(result);
        await load();
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Failed to refresh pricing');
      }
    } finally {
      refreshAbort.current = null;
      if (!controller.signal.aborted) setRefreshPhase(null);
    }
  }

  async function saveOverride() {
    setBusy(true);
    setError(null);
    try {
      const rates: ModelRates = { ...EMPTY_RATES };
      for (const key of Object.keys(rates) as (keyof ModelRates)[]) {
        rates[key] = parsePerMillion(draft.rates[key]);
      }
      let previousThreshold = 0;
      const tiers = draftTiers.map((tier) => {
        const aboveTokens = Number(tier.aboveTokens);
        if (!Number.isSafeInteger(aboveTokens) || aboveTokens <= previousThreshold)
          throw new Error('Tier thresholds must be positive whole numbers in ascending order');
        previousThreshold = aboveTokens;
        return {
          aboveTokens,
          inclusive: tier.inclusive,
          ...Object.fromEntries(
            RATE_LABELS.map(([key]) => [key, parsePerMillion(tier.rates[key])]),
          ),
        };
      });
      await api.post('/cli-pricing/prices', {
        provider: draft.provider === '' ? null : draft.provider,
        modelKey: draft.modelKey,
        rates: {
          ...rates,
          ...(tiers.length ? { tiers } : {}),
        },
        note: draft.note === '' ? null : draft.note,
      });
      setDraft({
        provider: '',
        modelKey: '',
        note: '',
        rates: {
          inputRate: '',
          outputRate: '',
          cacheReadRate: '',
          cacheWriteRate: '',
          cacheWrite1hRate: '',
        },
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save rate');
    } finally {
      setBusy(false);
    }
  }

  async function retire(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/cli-pricing/prices/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retire rate');
    } finally {
      setBusy(false);
    }
  }

  const previous = data?.prices.find(
    (p) =>
      p.source === 'manual' &&
      p.provider === (draft.provider || null) &&
      p.modelKey === draft.modelKey.trim().toLowerCase(),
  );
  const draftTiers = draft.tiers ?? (previous?.rates.tiers ?? []).map(tierDraft);
  const prices = (data?.prices ?? []).filter(
    (p) =>
      (providerFilter === '' || (p.provider ?? '') === providerFilter) &&
      (filter === '' || p.modelKey.includes(filter.toLowerCase())),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-neutral-50">Model pricing</h2>
          <p className="max-w-3xl text-sm text-neutral-400">
            Per-model token rates, quoted per million tokens. Synced twice daily from public feeds
            and used to price each CLI invocation. A manual rate always wins over a synced one, and
            turning a CLI&apos;s auto-update off makes its manual rates the only ones that apply —
            immediately, without waiting for a sync. Rates are effective-dated: changing one closes
            the old row rather than overwriting it, so a finished task still reports what it
            actually cost.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={refreshPhase !== null}
          onClick={() => void refreshNow()}
        >
          {refreshPhase === null
            ? 'Refresh now'
            : refreshPhase === 'queued'
              ? 'Queued...'
              : 'Refreshing...'}
        </Button>
      </div>

      <FormError message={error} />
      <LatestRefresh
        endpoint="/cli-pricing/refresh/latest"
        active={refreshPhase !== null}
        result={refreshResult}
      />

      <section className="space-y-2">
        <h3 className="text-base font-semibold text-neutral-100">Auto-update per CLI</h3>
        <div className="overflow-x-auto rounded-md border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-xs uppercase tracking-wider text-neutral-500">
              <tr>
                <th className="px-3 py-2">CLI</th>
                <th className="px-3 py-2">Cost basis</th>
                <th className="px-3 py-2">Auto-update</th>
                <th className="px-3 py-2">Rates</th>
                <th className="px-3 py-2">Last sync</th>
              </tr>
            </thead>
            <tbody>
              {(data?.providers ?? []).map((p) => (
                <tr key={p.name} className="border-t border-neutral-800">
                  <td className="px-3 py-2 font-mono text-neutral-200">{p.name}</td>
                  <td className="px-3 py-2 text-neutral-400">{p.costBasis}</td>
                  <td className="px-3 py-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={p.autoUpdateEnabled}
                        disabled={busy}
                        onChange={(e) => void toggleProvider(p.name, e.target.checked)}
                        className="h-4 w-4"
                      />
                      <span className="text-neutral-400">
                        {p.autoUpdateEnabled ? 'synced' : 'manual only'}
                      </span>
                    </label>
                  </td>
                  <td className="px-3 py-2 text-neutral-400">{p.priceCount}</td>
                  <td className="px-3 py-2 text-neutral-400">
                    {p.fetchError ? (
                      <Badge variant="error" title={p.fetchError}>
                        error
                      </Badge>
                    ) : (
                      ago(p.fetchedAt)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-neutral-500">
          amp and antigravity list no rates on purpose: neither reports which model answered, so
          there is nothing to price against. Both run on flat subscriptions anyway.
        </p>
      </section>

      {(data?.unknownTierInvocations?.length ?? 0) > 0 && (
        <section className="space-y-2">
          <h3 className="text-base font-semibold text-neutral-100">Unpriced prompt tiers</h3>
          <InlineMarkdown body="Up to 50 recent invocations. Each range describes one run and is excluded from cost totals. Missing coverage or rates leave a run unpriced. Saved snapshots keep their original prices." />
          {data!.unknownTierInvocations!.map((run) => (
            <div key={run.id} className="flex gap-3 text-xs">
              <span className="font-mono text-neutral-300">{run.modelKey ?? 'Unknown model'}</span>
              <PromptTierUnknown tier={run.tier} />
            </div>
          ))}
        </section>
      )}
      <section className="space-y-2">
        <h3 className="text-base font-semibold text-neutral-100">Add or replace a rate</h3>
        <p className="text-sm text-neutral-400">
          For a negotiated price, or for a model no feed carries yet. Leave a field empty to say
          there is no rate for that bucket — empty is not zero, and a wrongly-zero rate reads as
          free. Saving replaces any existing manual rate for the same CLI and model.
        </p>
        <div className="flex flex-wrap items-end gap-3 rounded-md border border-neutral-800 p-3">
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            CLI
            <select
              className={selectClass}
              value={draft.provider}
              onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
            >
              <option value="">any (vendor-wide)</option>
              {(data?.providers ?? []).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Model
            <Input
              value={draft.modelKey}
              placeholder="glm-5.3"
              onChange={(e) => setDraft({ ...draft, modelKey: e.target.value })}
            />
          </label>
          {RATE_LABELS.map(([key, label]) => (
            <label key={key} className="flex w-32 flex-col gap-1 text-xs text-neutral-400">
              {label}
              <Input
                value={draft.rates[key]}
                placeholder="—"
                onChange={(e) =>
                  setDraft({ ...draft, rates: { ...draft.rates, [key]: e.target.value } })
                }
              />
            </label>
          ))}
          {draftTiers.length > 0 &&
            RATE_LABELS.every(([key]) => draft.rates[key].trim() === '') && (
              <InlineMarkdown
                className="w-full text-xs text-amber-300"
                body="All base rates are empty. This manual rate overrides the feed, so requests below the first tier will be unpriced."
              />
            )}
          <div className="w-full space-y-3">
            {draftTiers.map((tier, index) => (
              <div
                key={index}
                className="flex flex-wrap items-end gap-3 rounded border border-neutral-800 p-3"
              >
                <label className="flex flex-col gap-1 text-xs text-neutral-400">
                  Prompt threshold
                  <Input
                    value={tier.aboveTokens}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        tiers: draftTiers.map((t, i) =>
                          i === index ? { ...t, aboveTokens: e.target.value } : t,
                        ),
                      })
                    }
                  />
                </label>
                <label className="text-xs text-neutral-400">
                  <input
                    type="checkbox"
                    checked={tier.inclusive}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        tiers: draftTiers.map((t, i) =>
                          i === index ? { ...t, inclusive: e.target.checked } : t,
                        ),
                      })
                    }
                  />
                  Inclusive threshold
                </label>
                {RATE_LABELS.map(([key, label]) => (
                  <label key={key} className="flex w-32 flex-col gap-1 text-xs text-neutral-400">
                    {`Tier ${index + 1} ${label}`}
                    <Input
                      value={tier.rates[key]}
                      placeholder="—"
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          tiers: draftTiers.map((t, i) =>
                            i === index
                              ? { ...t, rates: { ...t.rates, [key]: e.target.value } }
                              : t,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
                <Button
                  variant="secondary"
                  onClick={() =>
                    setDraft({ ...draft, tiers: draftTiers.filter((_, i) => i !== index) })
                  }
                >
                  Remove tier
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              disabled={draftTiers.length >= 4}
              onClick={() =>
                setDraft({
                  ...draft,
                  tiers: [
                    ...draftTiers,
                    { aboveTokens: '', inclusive: false, rates: rateDraft(EMPTY_RATES) },
                  ],
                })
              }
            >
              Add prompt tier
            </Button>
          </div>
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Note
            <Input
              value={draft.note}
              placeholder="contract ref"
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </label>
          <Button
            disabled={busy || draft.modelKey.trim() === ''}
            onClick={() => void saveOverride()}
          >
            Save rate
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-base font-semibold text-neutral-100">Live rates</h3>
          <select
            className={selectClass}
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
          >
            <option value="">all CLIs</option>
            {(data?.providers ?? []).map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <Input
            value={filter}
            placeholder="filter by model"
            onChange={(e) => setFilter(e.target.value)}
            className="w-56"
          />
          <span className="text-xs text-neutral-500">{prices.length} shown</span>
        </div>
        <div className="max-h-[32rem] overflow-auto rounded-md border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-neutral-900 text-left text-xs uppercase tracking-wider text-neutral-500">
              <tr>
                <th className="px-3 py-2">CLI</th>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2 text-right">In /M</th>
                <th className="px-3 py-2 text-right">Out /M</th>
                <th className="px-3 py-2 text-right">Cache read /M</th>
                <th className="px-3 py-2 text-right">Cache write /M</th>
                <th className="px-3 py-2">Since</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => (
                <Fragment key={p.id}>
                  <tr className="border-t border-neutral-800">
                    <td className="px-3 py-2 font-mono text-neutral-300">{p.provider ?? 'any'}</td>
                    <td
                      className="px-3 py-2 font-mono text-neutral-200"
                      title={p.note ?? undefined}
                    >
                      {p.modelKey}
                      {p.rates.pricingState === 'unsupported' && (
                        <Badge variant="error">unpriced</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={p.source === 'manual' ? 'warning' : 'default'}>
                        {p.source}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-neutral-300">
                      {perMillion(p.rates.inputRate)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-neutral-300">
                      {perMillion(p.rates.outputRate)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-cyan-400/80">
                      {perMillion(p.rates.cacheReadRate)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-cyan-400/80">
                      {perMillion(p.rates.cacheWriteRate)}
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{ago(p.effectiveFrom)}</td>
                    <td className="px-3 py-2 text-right">
                      {p.source === 'manual' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            setDraft({
                              provider: p.provider ?? '',
                              modelKey: p.modelKey,
                              note: p.note ?? '',
                              rates: rateDraft(p.rates),
                              tiers: (p.rates.tiers ?? []).map(tierDraft),
                            })
                          }
                        >
                          Edit
                        </Button>
                      )}
                      {p.source === 'manual' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => void retire(p.id)}
                        >
                          Retire
                        </Button>
                      )}
                    </td>
                  </tr>
                  {(p.rates.tiers ?? []).map((tier) => (
                    <tr
                      key={tier.aboveTokens}
                      className="border-t border-neutral-800 bg-neutral-900/40 text-xs"
                    >
                      <td colSpan={3} className="px-3 py-2 text-neutral-400">
                        Prompt {tier.inclusive ? '≥' : '>'}{' '}
                        {tier.aboveTokens.toLocaleString('en-US')} tokens
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-neutral-300">
                        {perMillion(tier.inputRate)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-neutral-300">
                        {perMillion(tier.outputRate)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-cyan-400/80">
                        {perMillion(tier.cacheReadRate)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-cyan-400/80">
                        {perMillion(tier.cacheWriteRate)} (5m)
                        <br />
                        {perMillion(tier.cacheWrite1hRate)} (1h)
                      </td>
                      <td colSpan={2} />
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

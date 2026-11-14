# Model pricing and spend

`cli_invocations.cost` records what a run COST, decided at completion beside `token_usage` and `model_identity` and then immutable. Distinct from `token_usage.costUsd`, which keeps its old meaning (what the CLI itself reported). The split exists because the reported number is real only where the CLI prices its own backend: the claude binary applies ANTHROPIC's table to every backend, so for zai/muse/openrouter/ollama it is fiction, and codex/gemini report no cost at all. MEASURED before the feature: of ~12,800 USD reported across 12,438 invocations, 31.68 USD was the only amount the product could count as real.

Precedence per invocation (`resolveCostDecision`): manual rate > CLI-reported where `costBasis` is `metered` > computed from a synced rate. Subscription auth short-circuits to non-billable regardless — a flat plan's per-token dollars are notional. `resolveCostBasis` demotes BOTH per-token bases under subscription auth, `metered` AND `estimate`, so a claude-binary wrapper on a flat plan (a GLM coding plan) is non-billable too; its counterfactual is then computed from Haive's own feed rate, never from the binary's Anthropic-table total, and an unpriced model there is `none` rather than fiction. `billable` is decided at WRITE time, where provider, auth mode, model and price source are all in hand, so reads honor a flag instead of re-deriving the rule (it had been duplicated across three SQL filters). A partial computation is recorded `source: 'none'`, never as a cost: a total missing one bucket looks like money and is not.

`ollama` is the one provider whose basis is per-MODEL rather than per-CLI, so `resolveCostBasis` takes an optional model key. One catalog entry covers the local daemon and Ollama Cloud alike, and the catalog says `local` because that is what `ollama` used to mean; a `-cloud`/`:cloud` model runs on ollama.com under a plan that is plan-included up to a limit and metered beyond it, which is neither free nor per-token-billed, so it resolves `subscription` (non-billable, priced only as the counterfactual). Keyed on the model TAG via `isOllamaCloudModel`, the same test the base-URL routing and the boot provisioner already use — NOT on the base URL, which a cloud provider row does not set at all because the local daemon proxies cloud models. Both tag forms matter: the common one is `<size>-cloud`, and every zero-rate cloud row the LiteLLM feed carried wore it, so a `:cloud`-only check would have missed all of them. A caller with no model in hand (the per-provider usage rollup groups by provider, not by model) keeps the catalog answer.

The non-billable half is not discarded, it is the SUBSCRIPTION COUNTERFACTUAL: `notionalCostUsdSql` (`shared/src/stats-server/cost.ts`) sums what those same tokens would have cost at list API rates, rendered grey and labelled on the task's provider card, never added to real spend. Two halves, each the exact complement of the real-spend rule: snapshot rows flagged non-billable minus `source: 'none'` (whose 0 means unpriced, not free), plus legacy `cost IS NULL` rows from a METERED provider on subscription auth. The claude-binary wrappers are excluded from the legacy half because their reported total is Anthropic-table fiction in either direction (5,968 USD of it against local ollama tokens), and codex/gemini report no cost at all, so both contribute 0 rather than a guess. MEASURED on the dev install: 29.63 USD real against 3,236 USD notional.

Rates live in `cli_model_prices`, effective-dated and append-only. A sync CLOSES the live row and inserts a replacement ONLY when a rate actually moved, so an unchanged 12-hourly tick writes nothing (verified: `inserted 0, closed 0, unchanged 651`). Three feeds, refreshed by the existing `REFRESH_VERSIONS` job (`cli-versions/model-prices.ts`), sequentially after `refreshOpenRouterModels` because it reads that cache rather than re-fetching 4 MB:

- **LiteLLM** `model_prices_and_context_window.json` for direct-vendor rates. The feed publishes one entry per (host, model), so `PROVIDER_LITELLM_VENDORS` maps each Haive provider to the vendors that ARE its backend and everything else is rejected — `azure_ai/claude-opus-5` and `vertex_ai/claude-opus-5` are different rows at different prices, and `azure/us/gpt-5.6-sol` really is 10% over list. MEASURED 2026-08-18: anthropic 26 chat models, openai 90, gemini 50 + vertex_ai-language-models 29, xai 44, zai 13, meta 3. `ollama` is deliberately NOT mapped here: all 21 of its rows are priced 0, which is the truth for a local model and a LIE for the four CLOUD models the feed also carries under that vendor (`deepseek-v3.1:671b-cloud`, `gpt-oss:20b-cloud`, `gpt-oss:120b-cloud`, `qwen3-coder:480b-cloud`). A stored 0 is not "unpriced", it is a PRICE — it makes an invocation record a real $0.00 — so those rows were retired by migration 0126 and the vendor mapping dropped.
- **OpenRouter** `/api/v1/models` for the gateway's OWN resale rates, provider-scoped to `openrouter` and never priced from a vendor rate — it bills its margin at the routed model's price, wrong by a different factor per model.
- **Ollama** the model pages themselves (`cli-versions/ollama-model-prices.ts` fetching, `cli-providers/ollama-pricing.ts` parsing), because Ollama publishes no price document and no pricing API — `ollama.com/pricing` lists plans and difficulty grades, not rates. Bounded to CONFIGURED CLOUD models, one page each per tick, never the whole library; cloud-only is a GUARD, since a stored rate on a `local`-basis run would be summed as real spend. MEASURED 2026-08-23 across the 10 configured cloud models: 1 (`kimi-k3`, $3.00 input / $0.30 cached / $15.00 output per 1M) publishes a cost block and 9 do not. Absence is a RESULT, not a failure — it is the common path and must never log an error or every tick cries wolf. A block that EXISTS and cannot be read fails loud and writes nothing. Amounts are paired with the label that follows them, never by position (an automated read of that page during diagnosis returned input $0.30 / cached $3.00, the two swapped), and `cached <= input` is asserted because a violation means the pairing is wrong. Selectors live in ONE constant marked volatile — this is HTML, it will reword.

Prompt-size price tiers are stored inside each rate jsonb as complete rate sets: `tiers: [{ aboveTokens, inclusive, inputRate, outputRate, cacheReadRate, cacheWriteRate, cacheWrite1hRate }]`. The shared ingress schema (`modelPriceRatesSchema` / `normalizePriceRates`) accepts finite nonnegative rates or explicit nulls, rejects unsafe, nonpositive or duplicate thresholds, caps tiers at four and sorts them ascending. Missing, null and empty tier arrays compare equal in `ratesEqual`, so untiered rows do not churn. This is a jsonb type extension only: no SQL migration or snapshot backfill. PR 1 stores tiers; it does not select tiers in `computeInvocationCost`. `tierRatesFor` is a pure helper with no production caller until per-request pricing lands.

PR 2 captures request evidence on the worker's in-process `ExecutionOutcome.requestUsage`
(`cli-executor/request-usage.ts`), beside the unchanged `tokenUsage`. A request keeps its
stable identity, turn when observable, model, input/cache buckets, nullable output and
observable 5-minute/1-hour cache-write split. The capture declares its input convention:
Claude input excludes cache; Codex/Gemini input includes it. Collection never subtracts
cache from inclusive input; only a future pricer may do so, once.

Coverage is conservative. Claude deduplicates by assistant message id, checks each prompt
bucket against whole-run result usage, and requires one result, valid identity/model and
intact evidence. Per-request output is known only when every output is observable and
their sum equals the result's observed output. Missing output is null, including a zero
sum next to an absent result output. Unknown cache-write TTL, contradictory events and
mixed request models prevent complete coverage. Duplicate message events are compared
across all request fields, including output; differing output is conservatively contradictory.
The result's `num_turns` is not a request count.

Billing keys alone never establish an unseen priced model. The collector reconciles each
observed model's input, cache-read and cache-creation sums with its same-name
`result.modelUsage` entry; output is checked only when the request output sum is independently
observable and reconciles with `result.usage`. A readable same-name entry must CONTAIN the
observed sum in every checked bucket (input, cache read, cache creation and known output).
A deficit in any checked bucket still withholds coverage, even if another entry matches.
Only otherwise complete captures expose same-name excess in `unobservedSameModel`, with per-bucket totals
and model but no invented request count, size or identity. Unobservable output and cache-write
TTL stay null; zero cache-write excess has zero TTL buckets. Exact entries need no excess
block. Sequential sub-step aggregation preserves these blocks only when the aggregate is complete;
incomplete sub-steps and aggregates expose no excess. Request sizes and legacy
`tokenUsage` remain unchanged. With no same-name entry, a differently named entry must carry exactly
the observed vector, corroborating it without renaming the served model (Grok's build suffix,
GLM's context variant). Ledger-only tokens outside the priced totals, such as Claude's Haiku
titling call, do not block coverage beside a matching main-model or alias entry, but a
ledger holding only other calls cannot corroborate the observed model, so coverage stays
incomplete. Two billing aliases splitting the priced totals cannot pass as one model. Each
prompt bucket must still equal `result.usage`, regardless of aliases or ledger-only calls.
The collector already sums each steered turn's `result.usage` (#1160); cost and model time
remain the last cumulative values. Several result events still mean incomplete request
coverage: a reconciled run total alone does not independently prove each turn's inventory.

Codex app-server uses the measured 0.154.0 notification shapes already covered by the
session tests. They carry no stable request id and several requests share a turn, so the
request identity uses the cumulative input/cache-read/cache-write/output watermark.
Each accepted `last` must equal the increase in every cumulative bucket, and all accepted
requests must reconcile to final usage. Gaps, resets, repeated watermarks, invalid counts,
missing start/completion evidence or malformed lines prevent complete coverage. Repeats
are deduplicated without claiming completeness. Cache writes with no observable TTL
remain unknown; the legacy Codex token mapping is unchanged.

Codex `exec --json`, Gemini and antigravity return no request list. Gemini additionally
carries the sum of `stats.models.*.api.totalRequests`, only when every count is a safe
nonnegative integer; a missing or invalid count stays null. Sequential sub-agent runs
namespace request ids across processes and carry coverage and counts through both the
success and early-failure returns. Request evidence is kept outside the serialized trace.
Mixed-model runs remain incomplete, preserving every observed request model for the
later pricing work rather than assigning all tokens to the invocation's model.

Nothing new is persisted in PR 2: no schema, `token_usage`, raw trace, cost, snapshot or
statistics change. `handleCliExecJob` now returns an in-memory outcome to direct callers:
`exitCode`, `rawOutput`, `parsedOutput`, `errorMessage`, `tokenUsage` and `requestUsage`.
It copies those fields explicitly, retaining neither `streamLog` nor `cleanTranscript` in
the returned outcome. The BullMQ processor discards its return value. A finalized invocation
recovered after worker death returns that outcome with unknown request coverage
(`recovered-completion`), preserving its stored tokens. Redelivery still performs no writes
or model calls, and does not resume the linked step again.
It does not reconstruct requests from totals, write a snapshot, or rerun a model.
The existing Ollama recording has a byte comparison of full exec `tokenUsage` and the
resolved cost snapshot against a baseline captured on unchanged code. Generated fixtures
cover every other channel; no account or development stack is used.

LiteLLM's standard `*_above_<N>k_tokens` fields inherit absent buckets from the base at each threshold, with explicit nulls kept unknown. Service-tier variants and 12-hour cache-write rates are ignored. The VOLATILE `LITELLM_NON_TEXT_RATE_FAMILIES` list also ignores non-text base families `*_audio_*`, `*_image_*`, `*_video_*`, `*_character_*`, `*_per_second_*` and `*_per_query_*` (including a family at the end of the base name). Classification examines the base before `_above_`; an unknown text-token threshold or an unclassified base still fails loud, as does `tiered_pricing`. No additional non-text `_above_` family was found in the saved live feed. `litellmRowsForProviders` marks xAI thresholds inclusive; other LiteLLM vendors are strict.

OpenRouter overrides are materialized in the model cache as complete tiers: at each unique `min_prompt_tokens`, all matching overrides apply in feed order, later entries winning per bucket. Its boundaries remain strict, including x-ai. The VOLATILE `IGNORED_OVERRIDE_PRICE_FIELDS` list ignores the price keys outside Haive's five text buckets: `audio`, `audio_output`, `input_audio_cache`, `image`, `image_output`, `web_search` and `internal_reasoning`. An override whose only condition is `min_prompt_tokens` remains a tier when it carries those fields. `utc_start`, `utc_end` and unknown non-price keys remain conditions; numeric-looking values never turn an unknown key into a recognized price. `overrides: null` means no overrides; other malformed non-array values fail loud. Inheritance never occurs during cost computation. Fixtures include the live vertex Gemini flash audio shape, Gemma modality thresholds and Google's Gemini 2.5 Pro override. Tests use local fixtures, never network requests.

A positively unsupported model is different from a failed feed fetch. Unsupported models replace their live feed row transactionally with `pricingState: 'unsupported'` and a bounded `pricingReason`. The known unsupported reasons `time-window` (a rate depends on UTC time) and `variable-price` (OpenRouter's finite negative-rate sentinel, commonly `-1`) are returned in the price refresh result's `unsupported: [{ model, reason }]`, carried through the job result and stored refresh run, and do not add to `errors` or make an otherwise successful refresh `ok: false`. A negative base or tier rate never becomes a usable price; `parseRate` keeps negatives null, the picker shows null as `?`, and the sync also recognizes negative values in an older catalog cache so an existing negative live price is closed and replaced with a marker. The catalog retains unsupported metadata and override counts but emits no `price:openrouter` errors; the price sync alone emits those diagnostics, and only when OpenRouter's per-CLI auto-update switch is enabled.

Unreadable or unclassifiable data (`unsupported-tier`, `invalid-tier`, `unsupported-condition`) still produces a model-specific `price:<provider>` error and `ok: false`. Every new refresh error uses `safeErrorMessage` at its own sink and is bounded to 2,000 characters, including the joined `fetch_error`. A provider's `fetch_error` contains only failures from the feed producing that provider's rows: a LiteLLM outage applies only to `PROVIDER_LITELLM_VENDORS`, never to OpenRouter or Ollama. A successful sync clears its own prior error even when it returns zero models. `priceCount` and the price refresh's per-provider counts exclude unsupported markers.

`pickLivePrice` refuses the selected marker rather than falling through to another stale feed. Computed pricing then resolves to `source: 'none'`, while manual rates and valid CLI-reported totals retain precedence. A supported refresh removes the marker. Whole-feed network failures retain last-good rows/cache, and stored invocation snapshots are untouched. New snapshots copy nested rates by value. MEASURED on the saved public feeds fetched 2026-11-14 with the real parsers: LiteLLM 232 mapped rows, 64 tiered, zero unsupported; OpenRouter 471 models, 77 tiered, 11 unsupported (three time-window, eight variable-price), zero unreadable.

Manual prices round-trip complete tiers through the admin API. `/admin/pricing` displays tiers read-only below base rates, including the boundary and both cache-write TTL rates; unsupported rows are labelled unpriced. Replacing a manual row's base rates in the existing form preserves its stored tiers. Existing manual rows without tiers remain untiered; admins can enter tiered manual rates through the API, with the tier editor deferred to the later pricing work.

Lookup is EXACT on a normalized model key (trim + lowercase, nothing else), deliberately NOT the longest-substring matcher `resolveContextWindow` uses: a wrong context window skews a cosmetic percentage, a wrong price is wrong money, and `claude` alone matches both opus and haiku (~15x apart). Variant markers are kept verbatim (`glm-5.3[1m]`, `deepseek-v4-pro:cloud`) because a context or hosting variant is usually its own SKU. An unmatched id is UNPRICED, never guessed — which is why the manual-override path is load-bearing rather than a nicety (`glm-5.3` is in no feed).

One arithmetic trap: Anthropic-shaped usage reports `input_tokens` EXCLUSIVE of the cache buckets, while codex and gemini report it INCLUSIVE of the cached prefix (`INPUT_INCLUDES_CACHE_PROVIDERS`). Pricing those two without subtracting charges cached tokens at the full input rate. Separately, cache-WRITE rates are frequently absent from the feeds, which costs nothing in practice: MEASURED, only claude-code (which uses its reported cost anyway) and amp (subscription) ever report cache-creation tokens — 0 across 6,204 invocations for every other provider.

A run that never reaches its `result` event (killed, exit 137) has no CLI-reported cost, and its `token_usage` is the stream collector's fallback (`createStreamJsonCollector.getTokenUsage`): one usage per assistant `message.id`, all four buckets summed, which is what a finished run's `result` reports. MEASURED in the installed claude 2.1.309: the `result` usage is its cost ledger's total over every billed call, so sub-agent calls count and the fallback does not filter them. An event with no `message.id` counts once; amp reports no result usage at all, so for amp this fallback is the stored figure. An assistant event carries one message's usage once per content block, which is why summing events over-counted. Rows stored before that fix summed per event and kept `cacheReadTokens` as a running max; they were not recomputed, and their `cost` snapshots are immutable. The fallback reads `message.usage` off the events, and the ollama-backed binary puts message_start values there (`test/fixtures/streams/ollama.jsonl`: input 1490 and output 0 on the events, 1357 and 141 on the result), so a killed ollama run still under-reports output. The same per-message map yields `token_usage.peakPromptTokens`, the largest single prompt, which feeds the step context badge (see [CLI adapter system](cli-adapters.md)).

Admin control is two-level. The global `CONFIG_KEYS.PRICING_AUTO_UPDATE_ENABLED` switch stops the sync and freezes stored rates, which remain in use. Only the per-CLI `cli_pricing_sync.auto_update_enabled` switch is enforced at lookup (`loadFeedGate`): off means "this provider's rates are admin-owned", so feed rows are ignored and only manual rates apply immediately on the next invocation. The global switch does not enforce manual-only pricing. Manual rates are effective-dated the same way (a write closes the previous one), and retiring one closes it rather than deleting, since the rows that priced past invocations must stay readable. Admin UI: a card on `/admin` for the global switch plus display currency, and `/admin/pricing` for per-CLI toggles, the rate table and overrides.

A refresh reports per source. The refresh job (`handleRefreshCliVersionsJob`) does not fail for one bad source: it completes with `ok: false` and an `errors` list of `{ name, error }`, one per failed source (a CLI's name, `price:<provider>`, `fx`, ...), each error sanitized at the worker. "Refresh now" on `/admin/pricing` and the version Refresh on the provider form wait for the job and, when `result.ok` is false, list the failed sources with their reasons (`RefreshFailures`; identical reasons merge, since a feed outage fails one `price:<provider>` per enabled CLI), while the sources that refreshed still reload. The notice gates on `result.ok`, never on message presence. `GET /cli-providers/catalog/:name/refresh-versions/:jobId` hands the result to an admin only, because its errors carry the price and FX failures that `/cli-pricing` keeps admin-only; a non-admin's form shows the refreshed versions and no notice. The job also keeps its latest run in `refresh_runs` (one row per kind: trigger, start and finish time, the result with its sanitized per-source errors and any source the kill switch skipped), so a scheduled refresh, or a manual one that outlasted the browser's poll, shows on `/admin/pricing` and the provider form (`LatestRefresh`, `GET /cli-pricing/refresh/latest`, admin only). A run a crash interrupted stays unfinished; an older overlapping run never replaces a newer one, neither by its start write (it updates only a row that started no later) nor by its completion (matched on its run id). Both writes are best-effort: a database error is logged and never fails the refresh. After its own job's result arrives, the page prefers that result over an older stored run.

Costs are stored canonically in USD. `fx_rates` holds daily ECB USD-per-unit rates and a task converts at the rate effective on ITS OWN date (`resolveCostDisplay`), so re-rendering a finished task yields the same figure; dated on the task rather than per invocation because FX drift within one task is far below the displayed precision. ECB publishes only the current day, so past rows cannot be re-fetched — do not truncate that table. A task older than FX collection converts at the earliest rate on record and is flagged `approximate`.

## Refresh serialization and request-coverage inventory

Feed price batches take the transaction-scoped advisory lock `model-price-refresh`
before reading live rows, and keep that lock through the diff, close and replacement.
A row lock alone cannot protect a model that has no price row yet. Fetches finish before
this section; its lock wait is bounded to 30 seconds. Closing a price also requires
`effective_to IS NULL`. An overlapping refresh of the same rates reads the winner's
replacement and writes nothing. An `applyDesiredRows` failure returns a failed
`price:database` source with a bounded, sanitized error; SQLSTATE `55P03` identifies a lock
timeout through driver causes. The rolled-back batch preserves last-good prices and sync
metadata. The job still refreshes FX and finishes `refresh_runs` with `ok: false` (subject to
the result store's existing best-effort writes). This changes neither manual prices nor historical snapshots.

`refresh_runs.result` includes the optional `unsupported` list. The shared `LatestRefresh`
component displays each model and its reason for a completed stored or manual result,
including on `/admin/pricing`. Known unsupported pricing is informational rather than a
refresh failure; models remain unpriced unless a manual rate or valid reported total applies.

`packages/worker/scripts/replay-request-usage.ts` is an explicit, SELECT-only operator tool:

```bash
cd packages/worker
pnpm exec tsx scripts/replay-request-usage.ts --since 2026-11-01T00:00:00Z --limit 1000
pnpm exec tsx scripts/replay-request-usage.ts --cli claude-code --limit 100
```

Supply `DATABASE_URL` in the environment; the script never loads `.env`. Its server-enforced
`REPEATABLE READ READ ONLY` transaction selects non-null retained logs through a cursor,
newest first with an id tie-breaker. The default is all matching rows; `--limit` optionally
narrows the inventory. Cursor batches stay bounded at 50 rows. Output is one aggregate JSON
with invocation coverage counts and reason histograms per CLI and per main model, without
invocation ids, prompts or stream bodies. Main model comes from served/requested stream
identity, falling back to stored invocation identity; billing keys never supply it.

Replay uses the real stream-json collector and Codex app-server session parser, with all
outgoing handshake data discarded in memory. Codex exec, Gemini and antigravity have no
request list and count as `none`.

The stored transcript contains the header and raw stdout/stderr interleaved without stream
markers. Replay feeds only complete single-line JSON objects with a string `type` or an
app-server `method`/`id`. Object-prefixed lines that fail this filter increment
`skippedNonEventLines` per CLI (and in totals and model buckets). General `malformed-stream`
evidence is unobservable from this mixed source and excluded. Replay complete-coverage
rates are therefore an upper bound: stdout malformed lines cannot be distinguished from
stderr noise in stored logs, whereas the live collector sees the stdout channel. An explicitly event-prefixed
broken line such as a cut-off `{"type":` is separately counted in `malformedEventLines` and
withholds coverage as `malformed-event-line`; it is never fed to either live parser. A
complete stderr object shaped like an event remains indistinguishable from stdout.

The writer retains 2 Mi characters of head and 2 Mi characters of tail. A log bearing its
elision marker, or reaching the conservative combined 4 MiB byte threshold, increments
`truncatedLogs` with coverage `unknown-truncated`. It never counts as complete, incomplete
or none, and contributes no request diagnostic counters. The byte threshold also refuses
large Unicode logs conservatively even if their character count is below the writer cap.
The counts describe retained evidence in the selected sample, not logs already expired or
recovered completions whose in-memory request evidence was lost.

`sameNameSideModelCandidates` identifies same-name ledger excess on the measured Haiku
titling family; `sameNameLedgerExcessRuns` catches other families too. These remain candidates,
since streams do not label a CLI-owned side call. The collector now accepts per-bucket
containment for same-name entries and records the excess; replay's `unobservedSameModelRuns`
counts only complete captures bearing those blocks. All three excess counters exclude
incomplete and truncated captures. A differently named alias still needs exact equality.
Other-model ledger-only titling was already ignored beside a corroborating main-model or
alias entry; this applies the same treatment when the side call shares the main model's name.
`absentModelUsageAcceptedComplete` counts a missing `modelUsage` key accepted as complete;
`emptyModelUsageAcceptedComplete` counts an explicitly empty object accepted as complete.
They are separate, mutually exclusive counters, both restricted to complete replay captures.
Their sum inventories accepted captures lacking ledger corroboration; the empty-object
counter alone does not measure that population. Null or other malformed ledger values are
neither absent keys nor empty objects.
Per main model, `sameModelExcess.histogram` counts complete captures bearing excess by
its aggregate prompt total `inputTokens + cacheReadTokens + cacheCreationTokens`. Buckets
are half-open at 0, 1,000, 10,000, 100,000, 200,000 and 272,000; the final bucket is unbounded
(`maxExclusive: null`). Output-only excess has a zero prompt and enters the first bucket;
exact ledgers with no excess enter none. `atOrAboveTierThreshold` counts complete runs whose
excess prompt total reaches 100,000 / 200,000 / 272,000, conservatively including equality
for inclusive tiers. These are aggregate potential-ambiguity bounds, not inferred request
sizes or a pricing decision; strict tiers still require `>` at pricing time.

`outputOnlyContradictoryRuns` counts conflicting duplicate requests with identical prompt,
model and TTL fields and differing output; it informs whether output comparison is too strict.
`killedFallbackRuns` counts nonzero-usage, no-result fallbacks with exit 137/143 or a finalized
null exit; active null-exit rows do not count as killed. `noResultFallbackRuns` includes other
exit codes, and `fallbackOutputZeroRuns` isolates the zero-output population.

The retained Ollama recording proves assistant output values of 0 and completed result output
of 141. Its thinking counter is an estimate ending at 198. Without the result, 141 cannot be
reconstructed from this evidence; replay counts that under-reporting rather than manufacturing
an exact output count. No real database was replayed during this fix.

MEASURED 2026-11-14 by the session, read-only across all 6,444 retained logs
(`TPR-S/measure-2.json`, before this containment change): claude-code had 2,748/3,153
complete captures. Main model `claude-haiku-4-5-20251001` had 0/191 complete, with 185
`model-usage-mismatch` runs. `sameNameSideModelCandidates` was 185 and
`sameNameLedgerExcessRuns` was 689 before the complete-only diagnostic gate.
`emptyModelUsageAcceptedComplete` and `outputOnlyContradictoryRuns` were both 0; the former
measured explicit empty objects only, not absent ledgers. Haiku main-model entries also
contain unobserved titling calls, so exact equality rejected them.

MEASURED 2026-11-14 by the session after containment (`TPR-S/measure-3.json`): claude-code
had 2,941/3,153 complete captures; Haiku main model `claude-haiku-4-5-20251001` had 178/191.
Claude-code `model-usage-mismatch` fell from 208 to 0. These replay coverage rates are upper
bounds for the retained sample because malformed stdout lines are unobservable in stored
mixed logs. The session's `unobservedSameModelRuns` / `sameNameLedgerExcessRuns` value 689
predates the complete-only gate and must not be read as a complete-run excess count.
The absent-ledger counter and excess magnitude inventory were added later; neither has
been measured against a real database in this fix. The measurements above are supplied
session evidence, not a new database run.

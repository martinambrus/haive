# Context-tiered model pricing: prices that change with prompt size

> **NOT STARTED.** Written 2026-11-10 from the tree at `a79a84bf3`, the live LiteLLM and OpenRouter
> feeds fetched that day, the vendors' pricing pages, and read-only queries on the dev install.
> Four PRs in the order below. PR 1 stores tier rates and changes no computed cost; PR 3 is the
> first that changes a number.

## Context

Claude Haiku 5.5 is priced by prompt length. Anthropic's pricing page (fetched 2026-11-10):

| Haiku 5.5, per MTok | Input | 5m cache write | 1h cache write | Cache read | Output |
| --- | --- | --- | --- | --- | --- |
| prompt up to 100,000 tokens | $0.10 | $0.125 | $0.20 | $0.01 | $0.50 |
| prompt over 100,000 tokens | $0.50 | $0.625 | $1.00 | $0.05 | $2.50 |

The rule, quoted: "a request whose prompt is over 100,000 tokens pays higher prices. A request's
prompt length counts all of its input tokens, including cache reads and cache writes. Each request
is priced on its own: a request over the threshold pays the higher prices even when part of its
prompt is a cache hit, and earlier requests keep the prices they were billed at." So the higher
price covers every bucket of that request, output included. Every other current Claude model bills
its full 1M window at standard rates ("Claude 4.6 and later models (except Claude Haiku 5.5) ...
include the full 1M token context window at standard pricing"), so on Anthropic's own API Haiku 5.5
is the only tiered model.

Haive prices an invocation from its summed token buckets at one rate set
(`computeInvocationCost`, `packages/shared/src/cli-providers/model-pricing.ts`). A tier cannot be
expressed: the parsers read five base fields (`parseLitellmPrices`; the OpenRouter parser in
`openrouter-models.ts`), `ModelPriceRates` has no place for a second rate set, and the cost path
never sees a request, only the invocation total. Every request over a threshold is therefore priced
at the base rate. For Haiku 5.5 that understates such a request five times over, for both real spend
and the subscription counterfactual.

## Which models are tiered (measured 2026-11-10)

Haiku 5.5 is not alone. Both feeds Haive already syncs publish tiers, and the sync drops them.

**LiteLLM, vendors in `PROVIDER_LITELLM_VENDORS`** (fields `input_cost_per_token_above_<N>k_tokens`,
`output_...`, `cache_read_input_token_cost_above_...`, `cache_creation_input_token_cost_above_...`,
`cache_creation_input_token_cost_above_1hr_above_...`):

| Haive provider (vendor) | Threshold | Models | Above-threshold rates |
| --- | --- | --- | --- |
| claude-code (`anthropic`) | 100k | `claude-haiku-5-5` | every bucket 5x |
| codex (`openai`) | 272k | 18 entries: `gpt-5.4`, `gpt-5.5`, `gpt-5.6` and its `-sol`/`-terra`/`-luna`/`-cyber` variants, `gpt-6-astra`/`-sol`/`-luna`/`-rosalind`/`-cyber`, `gpt-6.1-sol`/`-terra`, `daybreak-*` | input, cache read and cache write 2x, output 1.5x |
| gemini (`gemini`, `vertex_ai-language-models`) | 200k | `gemini-2.5-pro`, `gemini-3.1-pro-preview` (+ `-customtools`), `gemini-pro-latest`, `gemini-2.5-computer-use-preview` (4 more entries are zero-rate experimental models with a zero 128k tier) | input and cache read 2x, output 1.5x |
| grok (`xai`) | 200k | 36 entries: `grok-4.20*`, `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-4.7`, `grok-build-*`, `grok-code-fast*` | every bucket 2x |
| muse (`meta`) | 200k | `muse-ember-1.0` | every bucket 3x |
| zai (`zai`) | none | | |

**OpenRouter** `/api/v1/models`: 83 of 465 models carry `pricing.overrides`. 82 entries are prompt
tiers (`min_prompt_tokens`): openai 272k (44 incl. `~openai/*`), x-ai 200k (11), google 200k (5),
anthropic 100k (`claude-haiku-5.5`, its `:batch`, `~anthropic/claude-haiku-latest`), anthropic 200k
(`claude-sonnet-4.5` and `:batch`, the legacy 1M price of $6 / $22.50), qwen 32k/128k/256k (10,
two models with two thresholds each), bytedance-seed 128k (5), sakana 272k (2). The other 6 entries
are time windows (`utc_start`/`utc_end`, 3 models), which are not prompt tiers.

Vendors no Haive provider maps (dashscope, qwencloud and others) use a `tiered_pricing` range
table; nothing reachable today reads one. Ollama Cloud rates come from the model pages, and the one
page with a cost block (`kimi-k3`) states a single rate set.

**Threshold semantics, per source:**

- Anthropic: "over 100,000" (strictly greater), prompt = input + cache reads + cache writes, per request.
- OpenRouter: "applies when the total prompt tokens of a request are strictly greater than this
  threshold"; "price keys absent from an entry inherit the base price"; later entries win per key.
- LiteLLM's own calculator (`_get_token_base_cost`, `litellm_core_utils/llm_cost_calc/utils.py`):
  `prompt_tokens > threshold` on the full prompt including cached tokens, thresholds walked in
  ascending order so the highest one crossed wins, an absent tier key keeps the base rate, and
  `threshold_is_inclusive` (`>=`) exists for xAI.
- xAI: "requests whose prompt reaches the listed token threshold are billed at the higher rate for
  all tokens in the request" (inclusive).
- OpenAI: "Long context: >272K input tokens". The page does not say whether that is per request.
- Gemini: "prompts <= 200k tokens" / "prompts > 200k tokens"; Flash and Flash-Lite have no size tier.

## Measured on the dev install

Per-request prompt sizes, re-derived from `cli_invocations.stream_log` (one prompt per assistant
`message.id`, input + cache read + cache write):

| Model | Requests | Invocations | > 100k | Invocations with one > 100k | > 200k | > 272k | p50 / p90 prompt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5 | 11,408 | 1,027 | 3,915 (34%) | 372 (36%) | 302 | 30 | 82k / 158k |
| claude-sonnet-5 | 3,478 | 358 | 1,059 (30%) | 81 | 146 | 7 | 74k / 161k |
| claude-opus-4-6 | 7,141 | 1,128 | 329 | 38 | 0 | 0 | 51k / 83k |
| grok-4.6 | 2,114 | 212 | 537 | 96 | 0 | 0 | 70k / 129k |

The same workloads moved to Haiku 5.5 would put about a third of their requests on the 5x price, so
the tier dominates what Haiku 5.5 costs Haive. It is not an edge case.

Which channel reports per-request usage, compared with the run's own total:

| CLI | Per-request channel | Prompt side | Output |
| --- | --- | --- | --- |
| claude-code | assistant events, deduped by `message.id` | matches the result in 2,962 of 3,011 invocations | NOT per request: the events carry message_start values, 0.75% of the result's output |
| grok | assistant events | matches in 210 of 212 | matches in 212 of 212 |
| ollama | assistant events | 95% of the result | 0.65% of the result |
| muse, openrouter | assistant events | zero on every event (1,674 and 157 requests) | zero |
| codex app-server | one `thread/tokenUsage/updated` per request; `last` holds `inputTokens` (incl. cached), `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens` | exact | exact |
| codex `exec --json` | `turn.completed` totals only | none | none |
| gemini | `stats.models` totals only (plus `api.totalRequests`) | none | none |

Since 2026-10-26 every codex invocation (9 of 9) ran on the app-server; the 574 `exec --json` runs
since 2026-08-15 are all older. No invocation on this install has a request over its model's threshold: the codex
app-server peak is 30,909 tokens, grok's largest prompt is 176,217 (under 200k), and no Haiku 5.5,
Gemini Pro or muse-ember run exists. Nothing stored here is mispriced yet, so no backfill is
planned. `token_usage.peakPromptTokens` is absent on all but a handful of rows, because it is newer
than most of them, so it cannot measure history.

Side finding for T369 item 1: the killed-run fallback under-reports output for claude-code too, not
only for ollama. The assistant events of the claude binary itself carry message_start usage.

## Decisions

1. **Tiers live inside the rate jsonb**, as `ModelPriceRates.tiers`, not as new columns or extra
   price rows. A tier means nothing apart from its base set, and the effective-dated history and the
   invocation snapshot carry it with no extra work. No SQL migration: `cli_model_prices.rates` and
   `cli_invocations.cost` are jsonb, so only the Drizzle `$type` changes.
2. **Tier shape:** `{ aboveTokens: number; inclusive: boolean; inputRate; outputRate; cacheReadRate;
   cacheWriteRate; cacheWrite1hRate }`, sorted ascending by `aboveTokens`. A request uses the
   highest tier it crosses (`prompt > aboveTokens`, or `>=` when `inclusive`). Inheritance is
   resolved at PARSE time (an absent tier key takes the base value, as both feeds define it), so a
   stored tier is complete and the pricing code never inherits. `inclusive` is true for LiteLLM rows
   of vendor `xai` (xAI's "reaches") and false everywhere else, OpenRouter's x-ai rows included,
   since OpenRouter documents its own boundary.
3. **`tiers` absent, `null` and `[]` are one value.** `ratesEqual` normalizes them before
   comparing. Otherwise the first sync after deploy would close and re-insert every untiered live row
   (871 on the dev install); with normalization only the tiered rows move, once.
4. **Prompt size is per request and counts every input-side token**: input + cache read + cache
   write for Anthropic-shaped usage, `inputTokens` alone for `INPUT_INCLUDES_CACHE_PROVIDERS`
   (codex, gemini). That is the definition `peakPromptTokens` already uses. A tier is never chosen
   from an invocation total.
5. **A tier is applied only where it can be decided; otherwise the row is unpriced and shows a
   range.** This follows the existing rule that a partial computation is recorded `source: 'none'`
   rather than as a cost. A row's tier split counts as decided when:
   - every request's four buckets are known (codex app-server, grok); or
   - every request's prompt side is known and all requests fall in one tier, so the output belongs
     to that tier (claude-code, ollama); or
   - the run's total prompt-side tokens are at or under the lowest threshold, which proves every
     request was too (each request's prompt is at most the sum). Only valid when that total covers
     the whole run: not for a steered run whose usage comes from more than one `result` event
     (T369 item 5 keeps only the last one); or
   - the run made exactly one request (one assistant `message.id`, or gemini `api.totalRequests`
     of 1).

   Any other row (requests in more than one tier with per-request output unknown; muse, openrouter,
   codex `exec --json` or gemini runs over the threshold with several requests) is recorded
   `source: 'none'`, `billable: false`, with `tier.state: 'unknown'` and the low and high bounds,
   shown as a range and never summed. On this install that population is zero today. If it grows,
   the fix is a per-request channel for that CLI, not a summed guess.
6. **Reported totals keep precedence until PR 4 measures them.** claude-code and grok cost runs at
   their own reported totals (`resolveCostDecision`), so tiers first change computed rows: codex,
   gemini, openrouter and muse, plus every subscription counterfactual priced from a
   feed rate, and claude-code runs that never reached their `result`.
7. **No backfill of stored snapshots.** They are immutable by design, and none is affected here (see
   Measured). Rates reach every install through the normal 12-hourly sync, with no manual database
   step. A manual rate entered for a tiered model before this lands has no tiers; the rollout notes
   tell admins to re-enter it once PR 3's form exists.

## PR 1: store tiers (no cost changes)

- `packages/shared/src/cli-providers/model-pricing.ts`: `PriceTier`, `ModelPriceRates.tiers?`,
  `ratesEqual` with the normalization of Decision 3, and a pure `tierRatesFor(rates, promptTokens)`
  for PR 3 to use.
- `parseLitellmPrices`: read the standard `*_above_<N>k_tokens` keys. Ignore the service-tier
  variants (`_batches`, `_flex`, `_priority`, `_ultrafast`, `_decisions`) and the 12-hour TTL keys,
  which no Haive invocation uses. Resolve inheritance there, then set `inclusive` for vendor `xai`
  inside `litellmRowsForProviders`, where the vendor is known.
- Fail loud on a tier the parser cannot read. A mapped-vendor entry that carries a `tiered_pricing`
  table, or an `_above_` key outside the recognized set, writes NO row for that model and lands in
  the refresh `errors` as `price:<provider>` with the model named. That is the Ollama rule: "a block
  that EXISTS and cannot be read fails loud and writes nothing". Storing its base rates alone would
  misprice every request over the threshold without anyone noticing. No mapped entry triggers this
  on today's feed.
- `trimOpenRouterModels` (`openrouter-models.ts`) and the `openrouter_model_cache` entry type
  (`database/src/schema/cli-providers.ts`): keep the override entries whose only condition is
  `min_prompt_tokens` (later entries win per key, absent keys inherit). Skip time windows and any
  unknown condition, and count them in the refresh result. `refreshModelPrices` copies them into
  `rates.tiers`.
- Types: `cli_model_prices.rates` and `cli_invocations.cost.rates` `$type`
  (`database/src/schema/pricing.ts`, `tasks.ts`); the api `ratesSchema`
  (`api/src/routes/cli-pricing.ts`) accepts optional `tiers`: at most 4, ascending positive integer
  `aboveTokens`, rates `>= 0` or null. Manual rows round-trip them, so an edit never drops them.
- `/admin/pricing` lists each row's tiers read-only under its base rates.
- Tests: parser fixtures cut from the 2026-11-10 feeds (Haiku 5.5, `gpt-5.6-sol`, `gemini-2.5-pro`,
  `xai/grok-4.6`, `meta/muse-ember-1.0`, an OpenRouter time-window model, a two-threshold qwen
  model); `ratesEqual` normalization; a sync test where untiered rows stay
  `inserted 0, closed 0` and tiered rows close and re-insert once, then stay put on a second run.

## PR 2: capture per-request usage (no cost changes)

- `RequestUsage = { inputTokens; cacheReadTokens; cacheCreationTokens; outputTokens: number | null }`,
  with null meaning the CLI did not report this request's output. It is returned beside `tokenUsage`
  on the in-process exec result (`exec-core.ts` return branches, `handlers.ts`) with a coverage
  flag, and is NOT persisted: `stream_log` already keeps the raw evidence, and the cost snapshot
  keeps the per-tier totals.
- claude stream collector (`queues/cli-exec/stream.ts`): build it from `assistantUsageByMessage`.
  Coverage is `complete` when the per-request prompt sum equals the result's prompt side and there
  was one `result` event. Output counts as known only when the per-request output sum equals the
  result's output. That is a structural check, not a provider list, and it is what separates grok
  (equal) from the claude binary (message_start values).
- codex app-server (`cli-executor/codex-app-server.ts`): append `last` from each
  `thread/tokenUsage/updated`. That gives exact buckets, `cacheWriteInputTokens` included.
- codex `exec --json`, gemini and antigravity report no per-request usage, so they pass none. gemini
  passes its request count so that a one-request run is decided.
- Tests: the existing stream fixtures plus one fixture per channel above.

## PR 3: tier-aware pricing and snapshot

- `computeInvocationCost` takes the per-request list and the coverage flag. A rate with no tiers
  goes down today's path unchanged, pinned by a test that compares the result to the pre-change
  output. With tiers, it buckets each request by prompt, prices each tier at its own rates, applies
  Decision 5, and computes `lowUsd`/`highUsd` when the split cannot be decided.
- `InvocationCost.tier?: { state: 'exact' | 'unknown'; split: { aboveTokens: number | null;
  requests: number; inputTokens; outputTokens; cacheReadTokens; cacheCreationTokens; costUsd }[];
  lowUsd?: number; highUsd?: number }`, mirrored in the `cost` `$type` in `tasks.ts`. A missing
  1h-write rate in a tier still makes the bucket unpriced, as it does today.
- `resolveInvocationCost` passes the list through; the precedence in `resolveCostDecision` does not
  change. `realCostUsdSql` and `notionalCostUsdSql` need no change, because they read `costUsd`,
  `billable` and `source`, and both already exclude `source: 'none'`.
- UI: where an unpriced invocation is shown (task provider card, admin pricing), state "prompt tier
  unknown" with the range. The `/admin/pricing` manual form edits tiers.
- Docs: a tiers section in `docs/architecture/model-pricing.md`, including the threshold semantics
  above.
- Tests: boundaries (100,000 base and 100,001 tier for Haiku 5.5; 200,000 tier for xAI-inclusive,
  base for OpenRouter x-ai); a claude-code run with mixed tiers (input exact, output range, `none`);
  a claude-code run with every request in one tier (exact); codex app-server with mixed tiers
  (exact); a steered run with two results (aggregate proof refused); a gemini run with one request
  (exact).

## PR 4: check the CLIs' own totals on tiered models

`reported` wins for claude-code and grok, so a CLI whose price table ignores the tier would still
understate. A subscription run is enough to check: the binary prices its notional total with the
same table it uses for API-key runs, so the check spends no real money.

- claude-code on `claude-haiku-5-5`, one invocation with a request over 100,000 prompt tokens:
  compare `total_cost_usd` with PR 3's computation (input side exact, output as a range).
- grok on `grok-4.6`, one invocation with a request at or over 200,000.
- If a CLI's total matches the base price rather than the tier, that CLI's tiered runs use
  `computed` whenever the split is decided (a rule inside `resolveCostDecision` keyed on the price
  row having tiers, unit-tested). If it matches the tier, record that in the topic file and change
  nothing.

## Verification

1. `pnpm --filter @haive/shared test`, worker and api tests, `pnpm typecheck`.
2. After PR 1, on the dev install: "Refresh now" on `/admin/pricing`, then count live rows with
   tiers per provider. Expected from the 2026-11-10 feeds: claude-code 1, codex 18, gemini 9 (5
   priced models and 4 zero-rate experimental ones, after vendor rows collapse onto one key), grok
   36, muse 1, openrouter 80 or fewer (only models in the cache). A second refresh writes nothing.
3. After PR 3: a codex app-server run and a claude-code run on an untiered model each produce a
   `cost` identical to the pre-change computation, plus `tier` absent. The implementer runs this
   check, not the user.
4. PR 4's two live comparisons, recorded in `docs/architecture/model-pricing.md`.

## Rollback

- PR 1 revert: rows written with `tiers` stay in `cli_model_prices`. The old parser and `ratesEqual`
  read only the five base fields, so those rows compare equal to the feed and nothing churns. Pricing
  is base-only again, which is today's behavior. Nothing to undo in the database.
- PR 2 revert: in-process data only, nothing stored.
- PR 3 revert: snapshots keep a `tier` key that old readers ignore. Rows recorded `none` because the
  tier was unknown stay unpriced, since snapshots are immutable. That is acceptable, because today's
  measured population is zero; a re-snapshot script would be a separate, reviewed change if that
  ever matters.
- No step is destructive, and none needs a SQL migration.

## Out of scope

Batch pricing (Haive sends no batch requests), fast-mode premiums, Anthropic's 1.1x US-only
inference multiplier, OpenAI flex/priority service tiers and 12-hour cache writes, OpenRouter
time-window overrides, and `tiered_pricing` range tables. None of them is a prompt-size tier on a
path Haive uses today. Each would be its own change to the same rate shape.

## Open questions

1. OpenAI's ">272K input tokens" does not say per request. LiteLLM and OpenRouter both price it per
   request, and this plan follows them. Confirm against an OpenAI usage export if a metered codex
   install exists. Codex is subscription-only on this install, so the risk here is notional.
2. muse and openrouter put zero usage on assistant events, so a multi-request run of a tiered model
   over the threshold is always `unknown`. If a tiered model is configured there, measure whether
   the claude binary's `--include-partial-messages` `message_delta` usage gives exact per-request
   figures before building on it. The flag also multiplies stream volume.
3. Whether Gemini counts cached tokens toward the 200k threshold is not stated. The plan assumes
   it does, as LiteLLM's calculator does.

## Critical files

- `packages/shared/src/cli-providers/model-pricing.ts`: `ModelPriceRates`, `parseLitellmPrices`,
  `ratesEqual`, `computeInvocationCost`, `InvocationCost`, `resolveCostDecision`
- `packages/shared/src/cli-providers/openrouter-models.ts`: `trimOpenRouterModels`
- `packages/worker/src/cli-versions/model-prices.ts`: `refreshModelPrices`, `applyDesiredRows`
- `packages/worker/src/queues/cli-exec/invocation-cost.ts`: `resolveInvocationCost`
- `packages/worker/src/queues/cli-exec/stream.ts`: `createStreamJsonCollector`
- `packages/worker/src/cli-executor/codex-app-server.ts`: `thread/tokenUsage/updated`
- `packages/worker/src/cli-executor/usage-extract.ts`: `extractGeminiJsonOutput`
- `packages/worker/src/queues/cli-exec/exec-core.ts`, `handlers.ts`: exec result to cost pass
- `packages/database/src/schema/pricing.ts`, `tasks.ts` (`cost`), `cli-providers.ts` (OpenRouter cache)
- `packages/api/src/routes/cli-pricing.ts`: `ratesSchema`
- `packages/web/src/app/(app)/admin/pricing/page.tsx`
- `docs/architecture/model-pricing.md`

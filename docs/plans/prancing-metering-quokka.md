# Ollama Cloud is not free local compute

> Status: IMPLEMENTED 2026-08-23. Verified live against ollama.com and this install's DB.
>
> Three deviations from the plan as written, each measured rather than reasoned:
>
> - **Keyed on `isOllamaCloudModel`, not on `:cloud`.** The existing shared helper matches
>   BOTH `-cloud` and `:cloud`, and it has to: all four zero-rate cloud rows named below
>   wear the `<size>-cloud` form, so a `:cloud`-only test would have missed every one of
>   the models this plan calls the latent bug.
> - **FOUR zero-rate cloud rows, not three.** `gpt-oss:20b-cloud` is a fourth. All 21
>   ollama LiteLLM rows were live and priced 0; migration 0126 closed them.
> - **The scraper is scoped to CLOUD models, not to every configured one.** A stored rate
>   on a `local`-basis invocation would be summed as REAL spend, since only the
>   `subscription` basis is non-billable. Cloud-only is a guard, not a saved request.
>
> Also: no worker egress change was needed. Squid fronts the cli-exec sandbox, not the
> worker, which already fetches LiteLLM and ECB directly; the ollama ADAPTER already lists
> `ollama.com` for the sandbox side. Verified by the live scrape succeeding.
>
> Live result of the first refresh tick: `pages:10 priced:1 unpublished:9`, zero errors,
> and `kimi-k3:cloud` stored at input 3e-6 / cached 3e-7 / output 1.5e-5 per token —
> exactly the measured table below, labels paired the right way round. A second tick wrote
> nothing (`inserted 0, closed 0, unchanged 645`).

## Context

Haive treats every `ollama` invocation as free local compute. That was true when `ollama`
meant a local daemon; it is not true of this install, which runs Ollama **Cloud** almost
exclusively — 583 minimax-m3, 475 glm-5.2, 352 kimi-k2.7-code, and 18.15M tokens recorded since
cost capture began, all at no cost.

MEASURED against Ollama's own pages on 2026-08-23:

- `ollama.com/library/kimi-k3` publishes real per-token API rates: **$0.30 / 1M input,
  $15.00 / 1M output, $3.00 / 1M cached input**.
- `ollama.com/library/minimax-m3` and `.../kimi-k2.7-code` publish **no** rate.
- `ollama.com/pricing` publishes no per-token rates at all. Plans are Free / Pro $20 / Max $100
  / Team $25-per-seat, with "usage limits based on the model and the number of input, cached
  input, and output tokens processed", models graded by difficulty level 1-4, and Pro/Max able
  to buy "extra usage balance" beyond the plan limit.

So Ollama Cloud is **plan-included up to a limit, then metered**, and the overage rate is
published for some models and not others. Neither "free" nor "flat subscription" describes it.

## The three layers of the bug

**1. `costBasis: 'local'` on the ollama catalog entry** (`packages/shared/src/cli-providers/catalog.ts:315`).
Documented as "free local compute; the claude binary reports Anthropic-price FICTION against a
local endpoint". One entry covers the local daemon and Ollama Cloud alike, so every cloud run
inherits "free".

**2. Every LiteLLM ollama row is priced 0, and that is stored as a rate.**
`PROVIDER_LITELLM_VENDORS` maps `ollama: ['ollama']`
(`packages/shared/src/cli-providers/model-pricing.ts:215`) with the comment "Every ollama row is
priced 0, which is correct for local inference and harmless for Ollama Cloud, whose plan is a
flat subscription rather than per-token". Three CLOUD models carry such a row:

```
deepseek-v3.1:671b-cloud   {"inputRate": 0, "outputRate": 0, ...}
gpt-oss:120b-cloud         {"inputRate": 0, "outputRate": 0, ...}
qwen3-coder:480b-cloud     {"inputRate": 0, "outputRate": 0, ...}
```

A stored 0 is not "unpriced", it is a PRICE. If one of those runs, the invocation records a real
cost of $0.00 — the exact failure the "an unmatched id is UNPRICED, never guessed" rule exists to
prevent. Currently latent only by luck: `gpt-oss:120b-cloud` last ran 2026-06-22 and
`qwen3-coder:480b-cloud` 2026-06-26, both long before cost capture started on 19 August.

**3. The models actually in use have no row at all.**
kimi-k3, kimi-k2.7-code, minimax-m3, glm-5.2, deepseek-v4-flash/pro, gemma4, nemotron-3-ultra are
absent from the feed, so they resolve `source: 'none'` — honest, but 18.15M tokens of real cloud
usage are invisible to spend reporting. Verified: all 21 ollama cost rows are
`source: 'none', billable: false, amountUsd: null`.

## Approach

Key on the `:cloud` suffix. That is a structural marker Ollama itself uses in the model id, and
`cli_model_prices` already keeps it verbatim (the codebase deliberately does not strip ollama's
colon marker). It is not prose and it does not reword.

1. **Reject ollama feed rows rather than storing a 0 rate.** A vendor row whose input AND output
   are both 0 tells us nothing about a cloud model; storing it converts "unknown" into "free".
   Drop `ollama` from `PROVIDER_LITELLM_VENDORS`, or filter zero-rate rows for this provider.
   A local model then resolves `source: 'none'`, which is the truth for it too — its cost is
   electricity, not tokens.
2. **Split the cost basis on the model id, not the provider.** `costBasis` is currently one value
   per CLI in `CLI_PROVIDER_CATALOG`. Ollama needs it resolved per model: a `:cloud` model is
   `subscription` (flat plan, notional counterfactual computed from list rates), a local one stays
   `local`. This is the only structural change; everything else is data.
3. **Add a THIRD price feed that scrapes Ollama's model pages.** Manual rates do not scale and go
   stale, and these pages are the only published source — there is no rate table on
   `ollama.com/pricing` and no pricing API. Rates land as normal effective-dated
   `cli_model_prices` rows (`source: 'ollama'`), refreshed by the existing `REFRESH_VERSIONS`
   job alongside LiteLLM and OpenRouter, and feed the subscription counterfactual
   (`notionalCostUsdSql`) rather than real spend — the plan is what was paid, the per-token
   figure is what it would otherwise have cost.

### The scraper contract

MEASURED 2026-08-23 against all eight configured cloud models. The prices ARE server-rendered,
in a labelled block — no JS, no API needed:

```html
<span ...>Cost</span> <span ...>/1M tokens</span>
<div class="... tabular-nums">$3.00</div><div ...>input</div>
<div class="... tabular-nums">$0.30</div><div ...>cached</div>
<div class="... tabular-nums">$15.00</div><div ...>output</div>
```

- **URL**: `ollama.com/library/<id>` where `<id>` is the model with everything from the first `:`
  stripped (`kimi-k3:cloud` -> `kimi-k3`).
- **Bounded set**: only models that are CONFIGURED as ollama providers (12 here), never the whole
  library. One request each per refresh tick.
- **Absence is a RESULT, not a failure.** 7 of the 8 models have NO cost block; that means
  plan-included and must resolve `source: 'none'`. This is the common path and must never log as
  an error, or every tick cries wolf.
- **Fail LOUD, never 0.** A page that HAS a cost block the parser cannot read, or whose unit is
  not `/1M tokens`, must log an error and write NOTHING. Writing 0 is the layer-2 bug again.
  Keep the selectors in ONE named constant marked volatile — this is HTML, it will reword.
- **Pair by LABEL, never by position, and assert `cached <= input`.** This guard is not
  theoretical: an automated read of this exact page during diagnosis returned input $0.30 /
  cached $3.00 — the two swapped, understating input 10x. Positional parsing produces a
  plausible, wrong, silently-stored rate. Cached is cheaper than fresh input at every vendor, so
  a violation means the parse is wrong; reject it.
- **Egress**: `ollama.com` needs adding to the worker allow-list.

MEASURED result of the parse (the fixture set for the tests):

| model | cost block |
|---|---|
| `kimi-k3` | input $3.00, cached $0.30, output $15.00 per 1M |
| `kimi-k2.7-code`, `minimax-m3`, `glm-5.2`, `gpt-oss`, `qwen3-coder`, `deepseek-v4-flash`, `nemotron-3-ultra` | none (plan-included) |

## Files

| File | Change |
|---|---|
| `packages/shared/src/cli-providers/model-pricing.ts` | drop/zero-filter the ollama LiteLLM vendor mapping; correct the comment at :212 |
| `packages/shared/src/cli-providers/catalog.ts` | resolve ollama `costBasis` per model (`:cloud` -> subscription), correct the `local` doc at :78-86 |
| `packages/worker/src/queues/cli-exec/invocation-cost.ts` | consume the per-model basis |
| `packages/worker/src/cli-versions/ollama-model-prices.ts` (new) | the page scraper; sibling of `openrouter-models.ts` |
| `packages/worker/src/cli-versions/model-prices.ts` | run it as a third feed after the existing two |
| `packages/database/src/schema/` | add `'ollama'` to the `price_feed` enum (numbered idempotent `.sql`) |
| egress allow-list | `ollama.com` |
| admin `/admin/pricing` | manual override stays the escape hatch, no longer the mechanism |

Touches `@haive/shared`, so it needs the libs-first ordering: `pnpm docker libs`, verify dist in
the containers, then save the importers.

## Rollback

Behaviour-only plus data. `git revert` restores today's behaviour; retiring a manual rate closes
the row rather than deleting it, so past invocations stay readable. No migration.

## Verification

1. A run on `gpt-oss:120b-cloud` records `source: 'none'`, NOT a $0.00 cost.
2. A run on `kimi-k3:cloud` records the manual rate as a NOTIONAL figure, non-billable, and it
   appears in the subscription counterfactual rather than in real spend.
3. A local (`qwen3.5:0.8b`) run still records `source: 'none'` and stays non-billable.
4. `select provider, model_key, rates from cli_model_prices where provider='ollama'` contains no
   all-zero rate row after a refresh.
5. Scraper, against saved page fixtures rather than the live site: `kimi-k3` yields input 3.00 /
   cached 0.30 / output 15.00; the other seven yield "no published rate" WITHOUT logging an
   error; a fixture with the labels reordered still pairs correctly; a fixture with cached >
   input is REJECTED; a fixture whose unit is not `/1M tokens` is rejected; a 200 with a cost
   block the parser cannot read logs loudly and writes nothing.
6. A second refresh tick with unchanged upstream rates writes nothing (`inserted 0, closed 0`),
   matching the existing feeds' behaviour.

## Known limitation

Ollama publishes no rate for most models and no rate table at all on its pricing page, so the
counterfactual will be partial by construction. That is the correct outcome — a partial
computation is recorded `source: 'none'`, never as a cost, because a total missing one bucket
looks like money and is not. Do not fill the gaps by inferring a rate from a model's difficulty
level; that would be a guess wearing a number.

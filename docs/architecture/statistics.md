# Statistics

The statistics module's page at `/m/statistics` (`modules/statistics/src/web/stats-page.tsx`; `/stats`
redirects there) and its dashboard widget (`src/dashboard/stats-widget.tsx`) both read the
statistics module's api (`modules/statistics/src/routes.ts`, mounted by the module loader at
`/m/statistics/*` behind the same auth), nine endpoints sharing one query parser
(`query.ts`: 30-day default, `MAX_RANGE_DAYS` 731, IANA zone validated against `Intl`, repo /
task-class / provider facets, and an `allUsers` flag each ROUTE re-checks against the caller's
role because the parser has no access to it). Every arithmetic answer is a pure function in
`@haive/shared/stats` — the api fetches and scopes, `computeBusySpan` / `buildTaskTimeBreakdown`
/ `buildEstimationAccuracy` do the maths, and none of them needs a database to test.

**DEFAULT WINDOW.** The module's one global setting, `defaultWindow` (7d, 30d, 90d, 1y or all; 30d
when unset), is declared in its manifest and edited on the generic `/settings/m/statistics` page:
every signed-in user reads it, only an admin writes it. It picks the page's window ONLY when the URL
names no valid `preset` — an explicit `?preset=` always wins, so a shared link shows what its sender
saw (`pickPreset`). Without a URL preset the page waits for the setting before requesting anything,
so it never fires a 30-day request and then the real one; a failed read falls back to 30 days. The
dashboard widget is not governed by it and keeps the api's own 30-day default.

**ONE BUCKETER.** Day buckets are cut in JS with `Intl` (`dayKey`), never with `date_trunc` in
SQL, because the busy-span union already needs a bucketer in JS and two that must agree
eventually will not. The correct SQL form is recorded in `timelineFor`'s comment (`modules/statistics/src/routes.ts`), which the `/timeline` handler calls, for the day that
changes, along with the trap: the columns are `timestamp without time zone` holding UTC wall
clock, so a single `AT TIME ZONE $tz` reads them as already-local and MEASURED moves 5-10% of
rows into the wrong day. The consequence for new features is that anything day-shaped rides the
existing `/m/statistics/timeline` payload rather than adding a day-aggregate endpoint.

**The Overview page (`/m/statistics/overview`) is a DECLARED dashboard**, the reference example of a
module page rendered by the host's `DashboardRenderer` with no compiled React: its spec is
`pages.overview` in the module manifest, and its widgets read `/m/statistics/overview/kpi/*` and
`/overview/activity`. Those endpoints reuse the `/summary` and `/timeline` queries, are scoped to
the caller's own rows, and take the module's `defaultWindow` setting as the window. A declared spec
carries fixed endpoint strings, so they cannot follow the page's time zone: days are cut in UTC.

**`/summary` + `/timeline` are fetched for every tab; the other five endpoints are lazy**, so an
unopened tab costs nothing. A new section belongs on a tab that already pays for its data —
`/m/statistics/tasks` exists as its own endpoint for exactly this reason rather than as extra fields on
`/timeline`. Both pages resolve `timeZone` and the relative-preset clock on the CLIENT only and
leave them null until then, because `Intl` reports the container's zone during SSR and
`Date.now()` differs by milliseconds; both nulls GATE the first fetch. That mismatch, not a chart
bug, is what used to blank the charts.

**Under-sampling is disclosed, not smoothed.** `sampledRatio` carries `n` and `formatSampledRatio`
prints `n=3` INSTEAD of a percentage below `MIN_SAMPLES_FOR_TREND` (5); a figure that cannot be
computed renders as an em dash and never as zero. `computeDelta` returns a null `changeRatio`
against a zero baseline, which the UI shows as "new" — growth from nothing is neither infinite
percent nor 100%.

## The heatmap and the token bar

`ActivityHeatmap` and `StackedShareBar` (`modules/statistics/src/web/components/`) are plain DOM and STATICALLY
imported; only the three recharts charts are behind `next/dynamic`, and only because recharts is
a ~7 MB package with a d3/redux tree. Both render fields `/m/statistics/timeline` and `/m/statistics/summary`
had always computed and nothing had ever displayed — the per-day token series, `invocations`,
`tasksStarted`/`tasksCompleted`, and all four `tokens.*` buckets.

**Shading is by quantile of the WORKED days, not by a fraction of the maximum.** Nearest-rank
quartiles over the non-zero days, so every cut point is a value that actually occurred. MEASURED
on the real day series (agent-hours 44.76, 20.78, 16.36, 15.87, 13.19, 12.61, 8.35), dividing by
the maximum puts five of seven days under 0.37, and a fixed 0.3/0.6 threshold on that then
collapses them into one or two shades — a skewed week is the normal case here, since one long day
sets the maximum. Zero days are excluded from the quantiles and get their own colour and their own
legend swatch: "nothing ran" and "the quietest day that had work" are different claims.
`heat-scale.ts` also owns `localDayRange`, the INVERSE of the shared bucketer (a local day back to
an instant range) for the per-day drill-through — duplicated rather than imported because web must
not pull the `@haive/shared` barrel into the bundle, and tested against both DST days
(23h and 25h, which a single naive offset guess renders as 24).

**A tooltip's position cannot be inferred from an index.** The month blocks are `flex-wrap`, so
neither the month index nor the weekday column says where a block actually sits — MEASURED on a
one-year window, 15 blocks wrap and the LAST one starts a new row at the card's LEFT edge, where
an "it must be the rightmost block" rule hung the tooltip 105px outside the card. Tooltips
therefore open rightwards from the cell and the grid container RESERVES a right strip (`pr-44`,
against a measured 144px widest tooltip) so they fit by construction. Verified zero overflow past
the card and past the viewport at 366 cells / 15 blocks, at both 1600px and 900px wide.

**Chart colour is computed, not chosen**, with the `dataviz` skill's validator against the page
surface `#0a0a0a` (the app is dark-only: `globals.css` has one unconditional `:root`, zero `dark:`
variants, no `prefers-color-scheme`). Two sets, and both REJECTED alternatives are worth keeping:

- `HEAT_RAMP` is indigo-700/500/300/100, running deep to pale as magnitude RISES because on a dark
  surface lightness is prominence. The obvious Tailwind run indigo-900/800/600/400/300 FAILS —
  900↔800 are 0.04 apart in lightness and 800 sits at 1.73:1 against the surface, i.e. a busy day
  rendering as background.
- `TOKEN_COLORS` is sky-600/orange-600/emerald-600/violet-500 (worst adjacent CVD ΔE 10.1,
  normal-vision 28.8, all ≥ 3:1). Reusing the existing `tokens`/`cached`/`fresh` trio FAILS
  outright — sky-300 vs cyan-300 measure CVD ΔE 4.6 and normal-vision ΔE 5.6, indistinguishable to
  everyone. Those three were picked for the task page's total-time card, where each figure has its
  own text label doing the identifying; adjacent fills in one bar have no such crutch, which is why
  the task page keeps them unchanged.

Colour binds to the ENTITY and never to rank, so a filter that reorders segments repaints nothing.

**The token mix is a bar, not a donut,** and that is a measurement: cache reads are 73.4% of all
tokens on the dev install and output is 1.7%, which as a pie is a six-degree slice beside an arc
three-quarters of the way round. Segments carry no inline labels — a 1.7% segment cannot hold a
legible one, and a label clipped by its own segment is worse than one in the legend beneath. Note
the two different denominators on that tab: the bar's cache-read share is of all four buckets while
the "cached" tile is `cacheHitRatio`, of the prompt side alone, so the card says so.

## Ranked bar lists

`RankedBars` (`modules/statistics/src/web/components/ranked-bars.tsx`) replaces the two-column count tables on the
quality and reliability tabs, and `InlineBar` adds a scan aid to the per-task agent-hours column.
Tracks are sized against the LARGEST row, not the total: these lists answer "which of these is
biggest", which is a different question from `StackedShareBar`'s, and a share denominator
flattens every row once the list is long.

**One hue per list, and never one per rank.** These are magnitude comparisons, so colour carries
no identity; `COLORS[index % COLORS.length]` — the obvious shortcut, and what the upstream design
this borrows from does — repaints every surviving row whenever a filter changes the set. Where a
row's colour does mean something, the caller passes a function keyed on the ROW.

**Severity is a SCALE, so it is not sorted by count** (`order="given"` plus `SEVERITY_RANK`,
imposed on the page because the endpoint groups without an `ORDER BY`). Two consequences: the
colours are the reserved status steps, each read beside its own label rather than from hue alone;
and the rank number is SUPPRESSED whenever the order is not by value. MEASURED on the dev install,
numbering the scale reads "1 high, 2 medium, 3 low" against counts of 4, 35 and 33 — a rank
column on a non-ranked list states the opposite of the truth.

Provider bars were considered and left out: three providers on this install, and the table is
already ordered by tokens, so a second ranking on the same card would compete with it.

**Per-provider token bars are served normalised, and that is the whole reason they exist.**
`spend.byProvider` ships the RAW `inputTokens` its `TaskProviderUsage` shape has always carried,
so a bar built from that column would double-count cache reads for exactly the two providers the
normalisation exists for — MEASURED live, codex reads 46.5% cached raw against 86.9% normalised.
`/m/statistics/summary` therefore attaches a `tokens` object per provider, and `toRawTotals` is SHARED
between that map and the window total, so Σ the rows equals `tokens` structurally rather than by
two call sites happening to agree (VERIFIED live: all five fields match exactly). It is attached
to the response and NOT folded into `TaskProviderUsage`, which the task detail page mirrors and
which has no business carrying a statistics concern. Doing it in the browser was never an option:
`inputIncludesCache` lives in `@haive/shared`, which web must not import.

Every bar in that card — the window total included — shares one left edge and one
`tokenSegments` definition. Each is normalised to its OWN total, so the card compares
COMPOSITION and never size (size is the figure beside the name), and a segment that changed
colour or position between the total and a provider row would make that reading wrong rather
than merely inconsistent. The legend is rendered once, on the total.

## Per-step spend and model identity

`GET /m/statistics/steps` (lazy, behind its own tab) answers the question nothing else could: which
STEP the money and the hours go to. MEASURED on the dev install, `01-plan-build` alone is 38.3
of ~82 agent-hours.

Attribution is `coalesce(task_step_id, summary_for_step_id)` joined back to `task_steps` for the
human `step_id` — the same fold `enrichStepsWithCliStats` applies per task, so the window
reconciles with the per-step badges. VERIFIED live against `/summary` and `/tasks`: agent-ms
295,679,567, notional $1,237.56 and 1,718 invocations, identical across all three.

Three things this endpoint does differently from its neighbours, each for a reason:

- **`invocationAttributionFilter` APPLIES**, unlike on `/reliability`, which deliberately counts
  superseded and unattributed rows because those rows ARE the waste it measures. A spend rollup
  is the opposite case and has to reconcile.
- **agentMs is summed from the TIMESTAMPS, not from `duration_ms`.** That matches how every other
  agent-hours figure here is defined, and MEASURED, 17 rows carry both timestamps and a null
  `duration_ms` — the column form would silently drop them. Summed and never unioned: the
  busy-span union is per task and does not decompose by step.
- **Step failure counts stay OUT.** `task_steps` is windowed on its own `created_at` (a step has
  no `started_at` until it runs) while this rollup is windowed on the invocation clock, so one
  row carrying both would report a "runs" and a "failed" describing different sets.
  `/reliability` already ranks failing steps on the correct clock.

The model rollup groups on `model_identity ->> 'served'` — the same `->>` access `/reliability`
already uses, so no new pattern. A NULL `served` is rendered as **not recorded**, never folded
into a model or into a zero: codex and amp report no model at all and are permanently
`match: 'unknown'` by design. That bucket is not small and not a gap to chase — MEASURED, 162 of
1,718 invocations, and the LARGEST agent-hours of any row (34.3), because those are the long
codex runs. `billed` is not exposed at all: grok bills `grok-4.6-build` while serving
`grok-4.6`, so it is not an identity source. There is no index on `model_identity`, so this
group-by is a filtered scan narrowed by `cli_invocations_started_at_idx`; if that ever matters
the fix is an expression index on `(model_identity ->> 'served')`, not a denormalised column.

**Mining-agent ranking was evaluated and dropped.** `task_step_agent_minings` holds 1,486 rows
across 1,467 distinct `agent_id`s — 321 are generated `plan-expand-<nodeId>-p<N>` ids and the rest
are near-unique too — so a "most used agents" list is ~1,400 entries tied at n=1-2. Grouping on
`agent_title` is worse (1,456 distinct), because those are per-node prose rather than persona
names. The only signal in that table is failure rate, which belongs on the reliability tab.

## Throughput

Output tokens per second is reported TWO ways, and neither stands in for the other.
`summarizeThroughput` (`@haive/shared/stats`) is the one rule, used by `/m/statistics/steps` (per provider
× served model), `/m/statistics/timeline` (per day) and the task page's per-step badge:

- **Per model second** divides by `cli_invocations.api_duration_ms`: the claude family's
  (claude-code, zai, ollama, muse, grok) own `duration_api_ms`, and for gemini the sum of
  `stats.models.*.api.totalLatencyMs`, which gemini-cli 0.63 adds up from every API response's
  duration. It includes prompt processing and time to first token, so it is not pure decode
  speed. codex reports no timing and amp's stream carries none, so their rows are NULL and render
  a dash, never a rate estimated from wall time. antigravity's `duration_seconds` is agy's whole
  run, i.e. wall time, so it is not read as model time either.
- **The sequential sub-agent runner** (codex, gemini, amp) sums its sub-steps' model time, and
  records NULL when any sub-step that reported tokens reported no time, so the tokens divided
  always cover the same sub-steps.
- **Per wall-clock second** divides by `ended_at - started_at`, tool calls and sandbox included.

MEASURED on the dev install over 30 days, claude-opus-5-5 reads 93 tok/s per model second against
31 per wall-clock second, since model time was 33% of its runs. Wall time alone misstates model
speed by 3x.

**The value is cumulative, so the LAST result event wins**, like the cost beside it; the result
usage is per turn and is summed across a steered run's result events: a
steered run carried 27,366 then 35,255 ms against 39,571 ms of wall clock. Migration `0182`
backfilled 2,719 rows from `stream_log` by parsing each line as JSON and keeping the last `type:
"result"` line, never by key position; the binary writes `duration_api_ms` BEFORE `type`. gemini
rows are NOT backfilled: gemini-cli pretty-prints its JSON across many lines, and no gemini row
existed on the dev install to test a parser against, so only runs after 0181 carry it.

**Each side's numerator and denominator cover the same runs.** A run with no recorded usage enters
neither side; a run without model time enters only the wall side. Σtokens / Σtime is the headline
and the per-run median rides beside it on the model side, because one long run dominates the
aggregate: MEASURED, gemma4:31b-cloud reads 53 aggregate against a 15 median. On `/m/statistics`, rates
below `MIN_SAMPLES_FOR_TREND` render as `n=…` and the trend chart leaves such a day as a gap
rather than a point, because there a rate stands for a model's or a day's speed in general. The
task page does NOT apply the floor, on purpose: a step badge is the exact rate of that step's own
runs and a terminal header that of one run, so `n=1` there would hide a true figure, not flag a
weak one. The badge's tooltip states how many runs each side covers. Colours are `THROUGHPUT_COLORS`: model speed keeps the output-token violet, validated
as a pair with teal-600 against `#0a0a0a`.

## Agents, skills and MCP tools

`GET /m/statistics/tool-usage` and `GET /tasks/:id/tool-usage` read `cli_invocations.tool_usage` through
ONE SQL rollup (`shared/src/stats-server/tool-usage-rollup.ts`). The caller composes the predicate and the
rollup never decides which rows count; its LATERAL `jsonb_array_elements` / `jsonb_each_text`
reads are guarded INSIDE the function argument because both throw on a JSON null, which `loaded`
IS for every codex, amp and gemini row. `invocationAttributionFilter` APPLIES, as on `/steps`: a
reconciling rollup whose `total` must equal the runs the other tabs count.

**Denominators are stated, never implied.** `total` is the reconciliation figure; `unrecorded`
(an ended run with a NULL column), `inFlight` (a run not ended yet, so not recorded yet: the task
panel and the statistics page name them apart, never as "ran before the record existed") and
`unobservable` (`coverage: 'none'`) enter no "not used" sentence;
`observable` (full + partial, the partial ones flagged as floors) is the ONLY denominator such a
sentence may cite, and `share` is `sampledRatio(runs, observable)` so a three-run window renders
`n=3`. Assigned personas are counted on any RECORDED row — an assignment is a dispatch fact,
valid on a `none` row — and `assignedRecordedSince` says from when they exist at all, so the UI
says "not yet recorded" instead of rendering an empty list as "unused". The task endpoint groups
by the same `coalesce(task_step_id, summary_for_step_id)` fold as the step badges and sums its
per-step rows with `sumToolUsageSteps` (`@haive/shared/stats`), so the browser does no
arithmetic.

**The task endpoint also carries the two brokers' call logs**, which the rollup does not read:
per step `customTools` (from `custom_tool_calls`, by tool and action) and `integrations` (from
`integration_calls`, by provider, tool and access), each entry with its ok, refused, error and
running count, plus `callTotals` over every row of the task, rows whose step row is gone
included (`api/src/routes/tasks/_call-log.ts`, merged by `sumCustomToolCalls` /
`sumIntegrationCalls`). They count EVERY row, runs since replaced included, because the call
happened (and for an integration the vendor saw it); so they need not match the MCP column, which
counts the CLI's own events on runs not replaced, and the panel says so. A step with calls but no
attributed run still gets a row. `GET /tasks/:id` also answers `loggedCallCount`, the task's rows in
both logs with detached ones included, so the panel opens for a task whose only runs were replaced or
whose step rows are gone (`showsToolUsage`, `web/src/lib/call-log-cells.ts`); with no run in the
rollup the total row shows a dash, not 0, in every column read from runs, and the footer says so
(`web/src/components/task-tool-usage-table.tsx`). It also answers `runningCallCount`, those rows still
`running`, from the same query, and `finishedRunsRevision` (`loadFinishedRunsRevision`,
`api/src/routes/tasks/_helpers.ts`): an md5 over the rollup's own runs (`rolledUpRunsOf`, the predicate
both routes share) that have an `ended_at`, each as its id, its end and whether its `tool_usage` is
written. It is a digest, not a count: a retry supersedes a finished run and its replacement finishes
later, and both can land between two polls and leave the number as it was. The panel
(`TaskToolUsagePanel`) reads the usage again whenever any of the three changes on the page's 2 s poll,
so a call that settles, a new call, a run that finishes or is replaced, or a record the boot backfill
fills shows while the task runs. A run still in flight, or one cancelled in flight (ended and
superseded together, so it never joins the rollup), leaves the revision as it was; the panel catches up
when the next signal moves or the task ends. A `running` count that never settles is a call a crash
left unfinished.

**The unused report compares what is installed with what the runs used, and it reads the
installed half from disk by NAME only.** `shared/src/stats-server/tool-inventory.ts` walks the catalog's
`projectAgentsDir` / `projectSkillsDir` union through `@haive/shared/fs-safe` from the repository
root (`storagePath ?? localPath`, never a task worktree): a symlink anywhere is counted under
`skippedLinks` and never followed, no file content is opened, and an anchor that is not a
directory answers `unreadable` — never "nothing installed", which is what a lenient `readdir` on
a missing path would have said. `classifyInstalledItem` (`@haive/shared/stats`) decides from
four facts and nothing else: on disk plus a live `onboarding_artifacts` row on one of its paths
or an `agent.<id>` row in `template_manifest_cache` is `haive` (an upgrade writes it back, so
never a purge candidate); on disk and nobody's is `unmanaged`, the candidates; named in a run's
`loaded` inventory but not on disk and not a template is `cli-builtin` — claude's `Explore` and
`general-purpose`, or a file removed since the run — where the lever is a flag, not a deletion.
"Used" is judged over the WINDOW and `lastSeenAt` over the caller's whole history
(`toolUsageLastSeen`), because "not seen in this window" and "never seen since install" are
different claims and only the second supports deleting a file; a window with no observable run
reports NO rows, since nothing can then be called unused. MCP rows are offered-minus-called from
the runs' own `loaded.mcpServers`, never from `.claude/mcp_settings.json`, which is user-owned
and not read here. The three failures — `no-repository`, `no-path`, `unreadable` — are answers,
never a 404, so the rest of the tab still renders.

## Plan-page attention

`GET /m/statistics/summary` reports `time.planActiveMs` separately from the completed-task
`userActiveMs` and `effortMs`. It sums `plan_active_time.active_ms` for the caller, or all
users when an administrator requests `allUsers`, and honours the repository facet. Only All
classes and Plan include it; other classes return null. Plan attention has no provider, so
the provider facet does not apply: `scope.planActiveTime.cliProviderId` is always null even
when `scope.cliProviderId` selects a provider for the invocation figures. There is no task
join, task allocation or addition to completed-task effort, task rows, or task deltas.

`scope.planActiveTime.windowAttribution` is `utc-hour-start`: a whole row counts iff its
UTC `hour_start` falls in the half-open `[from, to)` window. An hour straddling the lower
edge is excluded in full; one straddling the upper edge is included in full. There is no
proration or invented event time. UTC wall-clock storage is interpreted independently of
the requested display zone, and window edges are accurate to the hour. Recording attributes
a flush wholly to its server receipt hour, adding up to one flush interval of displacement.

No matching row produces null, not zero: periods before measurement are unmeasured. A
recorded zero row remains zero. The Time tab shows a separate **Plan page** tile beside the
human figures, a dash for null, and discloses the activity window, all-provider scope and
UTC hour-start attribution. A dash can also mean the selected class excludes plan work.

Attention follows the shared [human active time](human-time.md) allowance: visible, focused
visits count while present, with visible words at 150 words/minute clamped to 1–5 minutes;
pending work or editor focus can extend a still-present epoch to 15 minutes. Content changes
restart only with recent real input. The task and plan pages share a browser-profile attention
lease; additive delivery is best-effort without retries and the server caps each user/repo/hour
at one hour. These are attention estimates, never proof of reading or completed-task effort.

## Time & cost report

The **Time & cost report** tab lazily loads `GET /m/statistics/time-cost` and caches a
loaded report while the window and facets stay unchanged. Reopening the tab reuses it;
a changed window or facet fetches a new report when the tab opens. Every figure
covers the same population as `/summary` effort: tasks completed in the half-open window,
filtered by owner, repository and class. The route re-checks `allUsers` against the caller's
admin role. Provider filtering is ignored and disclosed because step work has no provider.
Costs and form events cover each completed task's whole history, so report costs can differ
from Money's invocation-window totals. FX uses the window-end rate, as on `/summary`.

`TIME_CATEGORY_BY_STEP` in the import-free `@haive/shared/timing` module classifies persisted
workflow ids. Unknown, onboarding, module and custom ids are Other. A worker control walks
the real workflow registry, including ids set through constants. The plan's omitted
`11d-skill-sync` belongs in Delivery: it persists reusable guidance after implementation.
`computeWorkByCategory` shares task-wide park suppression and carried timing with
`computeTaskTiming`; category work sums exactly to workflow work. Each task is evaluated at
its completion instant. Work is elapsed step work, including deterministic setup and tests;
agent-hours separately sum concurrent invocation spans.

Test phase covers the six test-category steps, including setup and skipped commands. It
never proves test execution. Before check-run recording, surviving `08-phase-5-verify`
`output.test.ran` outcomes provide execution coverage: true is recorded execution, false
is **not run**, and missing evidence is **execution not recorded**. Reset outputs cannot
recover earlier attempts. The aggregate reports per-task ran, not-run and unrecorded counts
over the full population before the display cap. Commands agents run during implementation stay in Implementation.
The task page's Total time card shows **tests** after work, with the tooltip **part of work**,
only when its steps include a test phase. A recorded zero-duration test phase remains visible.

Human active is task-form attention, including carried time. Plan-page attention remains
separately reported on the Time tab and is never added here. Steering, testing another tab
and forge review are outside this measurement. Waiting for a person pairs each park with
its submit over the full lifecycle stream, per task and step-row id, ordered by timestamp
and event id. The event projection preserves PostgreSQL microseconds: converting to `Date`
first could reverse an auto-submit within one millisecond when ids break the tie. Retry,
automatic retry, revise/reset, loop-back, skip, abort, failure, stop, cancellation and
replacement parks invalidate open waits. Orphan submits, open waits and detached attribution
are unmeasured and their count is disclosed; a measured zero remains zero.

Money reuses the shared real/notional helpers and `pricedCostRowSql` coverage, which accepts
usable legacy reported costs without a snapshot and distinguishes an unpriced run from a
recorded zero. A task with no invocations has no recorded cost measurement: Billed and
At API rates remain dashes, while a priced invocation recording zero renders zero.
Billed stays separate from At API rates (real plus notional), with a lower-bound
mark when any included run is unpriced. Recaps join through
`coalesce(task_step_id, summary_for_step_id)`. Superseded and legacy unattributed runs are
excluded as on task provider cards; excluded legacy counts and included runs whose step
cannot be resolved are disclosed. Missing snapshots are counted separately from missing prices. Retained snapshots after a
provider is deleted can differ from older task provider cards, which omit those providers;
the report discloses this pre-existing card limitation rather than dropping known costs.

All task-id reads use batches of 200. Totals and category sums cover every completed task;
only displayed rows are capped at the 200 with most work, with `taskCount` and `truncated`.
Titles and repository names load after the cap. The lifecycle query filters to the 20
event types read by the reducer, exported from the reducer's own event sets as
`FORM_WAIT_EVENT_TYPES`. The query uses the migrated
`task_events_task_id_idx` (verified with a migrated two-year fixture population and EXPLAIN:
a 200-task batch retained 3,949 of 5,919 events and executed in 4.551 ms); events
are not window-filtered. Null renders as a dash, never zero. Fixed category colours are
contrast-checked against `#0a0a0a`; report text is neutral-400 or lighter, including the share legend.

# Human time: plan page timing and idle detection

> **NOT STARTED.** Written 2026-11-09 from the tree at `7591d9f2a` and read-only queries on the dev
> install. Three independent PRs, in the order below. Replaces the five-minute cutoff that
> `time-and-cost-report` PR 3 used to carry.

## Context

Two gaps make the human figure unreliable.

Time a person spends on the plan page of a repository (reading the plan, working with Claude on it)
is not recorded at all. `useUserActiveTimer` runs only on the task page, and only while a form waits.

The timer that does exist cannot tell a person from an empty chair. It counts while the page is
visible and focused, so a tech spec left on screen overnight counts for as long as it stays there.

## What exists today

- `useUserActiveTimer` (`tasks/[id]/page.tsx`) samples every second, adds elapsed time when
  `document.visibilityState === 'visible'` and `document.hasFocus()`, and posts deltas of at most
  60 s to `POST /tasks/:id/steps/:stepRowId/user-active`. It is the only caller of `postUserActive`.
  Sampling drops gaps of 5 s or more, so a sleeping machine adds nothing. A locked or idle desktop
  with the window still focused can keep counting.
- The plan page (`repos/[id]/plan/page.tsx`) has no timer. Its chat is `plan-chat.tsx`, which answers
  parked `01-plan-chat` forms in place, so that form time never reaches the task page timer either.
- A prose body (`MarkdownView`) renders in a `max-h-96` scroller until its Maximize button makes it
  `fixed inset-0`. The diff viewer has a similar mode.
- The Editor is a cross-origin `iframe`, so its input never reaches the parent page. The noVNC panel
  and the terminal are in the page, so their input does.

Measured on the dev install: `01-plan-chat` agent turns are p50 0.7 min, p90 4.5 min, max 10.5 min
(n=20). `01-advisory-research` is 4.5 to 6.4 min (n=4). Active time per step is small (p90 about
1 min at both spec gates), but those are mostly automated benchmark runs, so these numbers do not
tell us how real people read and were not used to set the limits below.

## Decisions

**One idle rule for both pages.** A person counts as present until an allowance has passed since
their last real input. The time up to that point counts, and the rest does not. An absence
therefore overcounts by at most one allowance.

**Base the allowance on how much text is visible.** `allowance = visibleWords / 150 wpm`, clamped to
60 s and 300 s. This is the "you would have read what is on screen by then" reasoning, measured
rather than configured per step, and it needs no list of steps to maintain.

- A spec body in its 384 px scroller shows an estimated 250 to 300 words, so about 2 minutes.
- The same spec maximized fills the screen and reaches the 5 minute limit.
- A short form gets 1 minute. The plan page gets at most 5 minutes, by the same rule.

150 wpm is a deliberate assumption for technical text, below general reading speed. It, and both
clamps, are named constants. Confirm the estimates above in a browser when building PR 1.

**What counts as input** is chosen so that the page cannot keep itself alive:

- `keydown`, `pointerdown`, `wheel` and `touchmove`, as capture listeners on `window` so that xterm
  and noVNC cannot swallow them.
- `pointermove` only when the coordinates changed. A browser can dispatch mouse events under a still
  cursor after a layout change, and these pages re-render on a poll.
- `scroll` only while a pointer is held down (a scrollbar drag). Otherwise a page's own auto-scroll
  would read as a person.
- Regaining window focus.

**Work in progress extends the allowance but does not remove it.** While the screen shows work the
person is waiting on, the allowance is `PENDING_WORK_IDLE_MS`, 15 minutes. That sits above the longest
measured chat turn (10.5 min). Pending means: the open chat has a turn running, a plan build, ordering
pass or plan merge is in flight, or the selected node has an open task. A plain "no limit while
pending" would count a whole multi-hour task left running in front of an empty chair, which is the
exact problem this plan exists to fix.

**New content restarts the allowance only for someone recently present.** When a chat answer arrives
or a task step starts waiting on a form, the clock restarts if the last real input is within
`PENDING_WORK_IDLE_MS`. Someone who sent a message and sat reading the answer is counted. A form that
parks at 3 a.m. after a person left at midnight adds nothing.

**Editor iframe focus uses `IFRAME_IDLE_MS`, 15 minutes.** Input there cannot be seen, so while
`document.activeElement` is an `IFRAME` the only evidence is that focus entered it. Someone editing
for longer is undercounted, and the page's note says so.

**Store plan time per repository, per user, per UTC hour.** A plan has no task or step row to attach
to, and it is not owned by one task. An hourly row keeps the table small and still gives it a place
in time. Node-level detail is not requested.

**No double count.** Only one document can hold focus, so a person is counted either on a task page
step or on the plan page. A plan chat opened on the task page counts against its step, and the same
chat on the plan page counts as plan time.

## Not in scope

- Recomputing history. Existing `user_active_ms` totals stay as recorded, so figures before and
  after PR 1 are not strictly comparable.
- Per-step or per-repository limit settings. The constants are one file; add settings if real use
  shows a need.
- Browser Idle Detection API. It needs a permission prompt and sees only the machine.
- Time spent on other Haive pages, or testing the app in a separate tab.

## PR 1: idle-aware timer on the task page

Web only. Rollback: revert the PR. No stored data changes shape.

New `packages/web/src/lib/active-time/`:

- `activity-clock.ts`, pure and tested with no DOM: tracks last input and last restart, and answers
  `isPresent(now)` from the allowance. Holds the constants and `readingAllowanceMs(words)`.
- `visible-words.ts`: walks text nodes under `document.body`, takes per-line rects, and counts a
  line only if it is in the viewport and `elementFromPoint` at its centre hits that node's parent.
  The hit test handles clipped scrollers and a maximized body covering the page. Runs once about 2 s
  after input stops, and again when content arrives. Never on the 1 s tick. Measure it on the largest
  real gate form and keep it under about 10 ms.
- `use-active-time.ts`: the existing sampling, flushing and display logic, moved out of the page, with
  `counting()` also requiring `isPresent`. Takes `enabled`, `pending`, `contentKey` and a flush sink.

`useUserActiveTimer` keeps its signature and becomes a thin wrapper, so its three uses in the task
page are unchanged. `contentKey` is the waiting step row id. A capped timer simply stops, and the
per-step display stops with it.

Verify:

- Unit tests with fake timers: stops at the allowance, resumes on input, counts nothing further in an
  absence, a same-coordinates `pointermove` is ignored, an unassisted `scroll` is ignored, `contentKey`
  restarts only with recent input, pending uses the longer allowance, iframe focus uses its own.
- `readingAllowanceMs` at 0 words, at the clamp edges and in between.
- Browser check on a real gate 1 spec: allowance about 2 min inline, 5 min maximized, 1 min on a short
  form; timer stops with the mouse still; a poll or auto-scroll does not restart it.

## PR 2: record plan page time

Additive. Rollback: revert the code and leave the table, which nothing else reads. If dropped for
good, remove it with a later numbered migration, never by editing an applied one.

**Migration** (next free number), guarded with `IF NOT EXISTS`, and `plan.ts` in the Drizzle schema:

`plan_active_time`: `repository_id` (cascade), `user_id` (cascade), `hour_start`, `active_ms`, primary
key on all three of the first columns. Stored as UTC wall clock like the other timestamps.

**API**: `POST /repositories/:id/plan/user-active` in `routes/plan.ts`, through `requireOwnedRepo`,
same `deltaMs` bounds as the step route. The hour is the server's. Upsert adds to `active_ms`, clamped
to one hour's worth of milliseconds so a misbehaving client cannot inflate a row.

**Web**: `postPlanUserActive` in `api-client.ts` beside `postUserActive`, and `useActiveTime` on the
plan page, enabled whenever the page is open. `pending` comes from a small page-level registry that
`plan-chat.tsx`, `PlanMergePanel`, `PlanStarter`, the ordering state and the detail panel's open task
report into, because those states live in separate components. `contentKey` changes when a chat
answer lands.

Verify: route tests for ownership, bounds, the upsert and the clamp, plus the existing
`upgrade-origin` and anonymous-route guards; `schema-parity`; a browser check that plan time
accumulates during input, stops at the allowance, keeps counting through a running chat turn up to
15 minutes, and that a deleted repository removes its rows.

## PR 3: plan time in statistics

No schema change. Rollback: revert the PR.

- `/m/statistics/summary`: `time.planActiveMs`, summing `plan_active_time` over the window, the
  caller's rows unless `allUsers`, honouring the repository facet. It counts only for the "All classes"
  and "Plan" facets, because it is plan work. The provider facet does not apply.
- Time tab: tile "Plan page" beside the human figures. A dash, never 0, when no row exists for the
  window, since older periods were not measured.
- If `time-and-cost-report` has shipped by then, its Human active tile becomes tasks plus plan, with
  the two parts in the hint, and its note mentions the idle limits. Step time attaches to tasks by
  completion and plan time by the hour it happened, so the note states that too.
- `docs/architecture/statistics.md`: what counts, the allowance rule, and that window edges are
  accurate to the hour for plan time.

Verify: scope tests for own rows, all users and the repository facet; live, the tile equals a direct
`SUM` for the same window; browser check of the tile with and without data.

## Critical files

- `packages/web/src/app/(app)/tasks/[id]/page.tsx`, `packages/web/src/lib/active-time/` (new)
- `packages/web/src/app/(app)/repos/[id]/plan/page.tsx`, `packages/web/src/components/plan/`
- `packages/web/src/lib/api-client.ts`
- `packages/api/src/routes/plan.ts`
- `packages/database/migrations/`, `packages/database/src/schema/plan.ts`
- `modules/statistics/src/routes.ts`, `modules/statistics/src/web/stats-page.tsx`
- `docs/architecture/statistics.md`

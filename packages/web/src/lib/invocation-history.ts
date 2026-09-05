import type { CliInvocationSummary } from '@/lib/api-client';

/** Completed runs fetched per page — the initial head page and every "load older" click.
 *  Small on purpose: each expanded run mounts an xterm and pulls its whole persisted
 *  stream log, so the page size is what bounds the browser's worst case, not the step. */
export const INVOCATION_HISTORY_PAGE = 20;

/** Newest-first, matching the api's `(created_at desc, id desc)`. The id tiebreak is not
 *  cosmetic: `created_at` defaults to `now()`, the TRANSACTION timestamp, so a fan-out that
 *  inserts its invocations together gives every row the same value. */
export function compareInvocationsDesc(a: CliInvocationSummary, b: CliInvocationSummary): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export interface MergeInvocationPageArgs {
  /** Rows already held, newest-first. */
  prev: CliInvocationSummary[];
  /** The page just fetched, newest-first. */
  page: CliInvocationSummary[];
  /** Completed-row limit that was requested for this page. */
  limit: number;
  /** True when the page was fetched WITH a cursor — an older slice appended to the tail.
   *  False for a head refresh (the poll), which is authoritative for everything it covers. */
  append: boolean;
}

/**
 * Fold one fetched page into the rows already on screen.
 *
 * A head refresh is authoritative over two ranges, and only those two:
 *
 *  - every ACTIVE run, wherever it sits in the ordering — the api always returns the
 *    complete active set, so a held active row missing from the page has stopped being
 *    active and its stale `running` badge must not survive;
 *  - every run at or newer than the page's oldest COMPLETED row — a held row missing from
 *    that range was superseded (a retry) and has to disappear, which is what the old
 *    wholesale replace got right.
 *
 * Rows strictly older than that floor are outside the refresh's knowledge and are kept, so
 * polling never discards pages the user deliberately loaded. When the page came back short
 * of its limit there is nothing older on the server at all, so the floor is unbounded and
 * the page is authoritative for the whole step.
 *
 * The one row this can drop is an active run that both ENDED and sits older than the
 * refresh floor — possible only when a long agent outlives a full page of faster siblings.
 * It is dropped rather than kept stale, and comes back with the next "load older" page:
 * showing a finished run as still running is the worse of the two.
 */
export function mergeInvocationPage({
  prev,
  page,
  limit,
  append,
}: MergeInvocationPageArgs): CliInvocationSummary[] {
  const byId = new Map<string, CliInvocationSummary>();
  if (append) {
    // The page is strictly older than everything held, so there is nothing to invalidate.
    for (const row of prev) byId.set(row.id, row);
    for (const row of page) byId.set(row.id, row);
  } else {
    for (const row of page) byId.set(row.id, row);
    const pageCompleted = page.filter((r) => !r.isActive);
    // Short page ⇒ the server had nothing older ⇒ authoritative to the very first run.
    const coversAll = pageCompleted.length < limit;
    const floor = pageCompleted[pageCompleted.length - 1] ?? null;
    for (const row of prev) {
      if (byId.has(row.id)) continue;
      if (row.isActive) continue;
      if (coversAll) continue;
      if (floor !== null && compareInvocationsDesc(row, floor) <= 0) continue;
      byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort(compareInvocationsDesc);
}

/**
 * Drop held rows outside the window the user actually asked for.
 *
 * `mergeInvocationPage` keeps everything older than the head page's floor, which is right for a
 * single poll and wrong over a long one: a fan-out step dispatches a wave every few minutes and
 * each wave's rows join the held set for good, so a tab left open all night converges on the
 * step's whole history (20 -> 31 -> ... -> 585 on the reported task). Polling must not be able
 * to grow the window; only a "load older" click may.
 *
 * `keepCompleted` is that budget — the head page plus every page the user clicked for. ACTIVE
 * rows are never trimmed: the api always returns the complete active set, their number is
 * bounded by the agent concurrency cap, and a live terminal must never be paged away.
 *
 * Expects `rows` newest-first, as the merge leaves them, and preserves that order.
 */
export function trimInvocationWindow(
  rows: CliInvocationSummary[],
  keepCompleted: number,
): CliInvocationSummary[] {
  let completed = 0;
  return rows.filter((row) => {
    if (row.isActive) return true;
    completed += 1;
    return completed <= keepCompleted;
  });
}

/** How many runs may keep a mounted terminal body on the default rule (live runs, plus the ones
 *  the user watched finish). An explicit click sits outside this cap — it is the user's own
 *  doing and is bounded by how often they can click.
 *
 *  MEASURED on `02-plan-coverage` (585 runs, 97 MB of stream logs): one mounted body costs
 *  ~6 MB of heap and ~570 DOM nodes, against 11 nodes for a collapsed row. So the bodies are the
 *  entire cost, and 24 of them is ~145 MB — while still covering two full 12-wide waves, so a
 *  run the user watched finish stays readable until the wave after next pushes it out. */
export const MAX_KEPT_OPEN_RUNS = 24;

/**
 * Record the runs seen ACTIVE on this poll, keeping only the most recent `cap` of them.
 *
 * The set this maintains is what `isInvocationExpanded` reads to keep a run the user watched
 * finish from collapsing under them. Unbounded, it was the leak: on a fan-out step EVERY run
 * passes through active, so the set — and with it the number of mounted xterms, live sockets and
 * fetched stream logs — converges on the whole step. The paging in `mergeInvocationPage` bounds
 * what a fresh mount loads; this bounds what a long-lived one accumulates.
 *
 * Each active id is re-inserted (delete then add) so `Set` insertion order is last-seen-active
 * recency rather than first-seen. That is what makes a STILL-ACTIVE run un-evictable: it is
 * re-added on every poll, so it is always among the newest entries and the eviction walks off
 * the other end. A run only starts ageing out once it stops being reported active.
 *
 * Mutates in place — the caller holds it in a ref, and every call site is immediately followed
 * by the poll's `setInvocations`, so the render that reads it always follows.
 */
export function rememberActiveRuns(
  seen: Set<string>,
  activeIds: readonly string[],
  cap: number = MAX_KEPT_OPEN_RUNS,
): void {
  for (const id of activeIds) {
    seen.delete(id);
    seen.add(id);
  }
  while (seen.size > cap) {
    const oldest = seen.values().next();
    if (oldest.done === true) break;
    seen.delete(oldest.value);
  }
}

export interface InvocationHistoryPaging {
  /** Completed runs currently held. */
  loaded: number;
  /** Completed runs the step has that are NOT held yet. */
  remaining: number;
  /** `historyCursor` for the next older page — the oldest completed row held. Null when
   *  nothing older remains. */
  cursor: string | null;
}

/** What the "load older runs" control needs, derived from the held rows plus the step's
 *  total completed count. Derived rather than taken from the server so a poll of the HEAD
 *  page cannot walk the cursor back over pages the user already loaded. */
export function invocationHistoryPaging(
  rows: CliInvocationSummary[],
  historyTotal: number,
): InvocationHistoryPaging {
  const completed = rows.filter((r) => !r.isActive);
  const loaded = completed.length;
  const remaining = Math.max(0, historyTotal - loaded);
  // rows are newest-first, so the last completed entry is the oldest one held.
  const oldest = completed[completed.length - 1] ?? null;
  return { loaded, remaining, cursor: remaining > 0 ? (oldest?.id ?? null) : null };
}

/** Per-invocation open/closed overrides the user has set by clicking a run's header.
 *  Absent id = no opinion, so the default rule below decides. */
export type InvocationOpenOverrides = Record<string, boolean>;

/**
 * Whether one run's terminal body should be mounted.
 *
 * The default is the whole point of the feature: an ACTIVE run is expanded (it owns a live
 * WebSocket and the user is watching it), a COMPLETED one is a collapsed summary row that
 * fetches nothing until clicked. A step with 500 finished runs therefore mounts zero
 * xterms and issues zero output requests on load.
 *
 * `seenActive` is the exception that keeps that from being annoying: a run the user watched
 * go from running to finished stays open, because collapsing the terminal the moment a run
 * exits would hide exactly the output the user was waiting for. It holds ids seen active
 * during this mount only, so a reload starts collapsed again — and only the most recent
 * `MAX_KEPT_OPEN_RUNS` of them (see `rememberActiveRuns`), so a step that runs wave after wave
 * cannot turn "stays open" into every run it ever dispatched.
 *
 * An explicit click always wins, in both directions — including collapsing a LIVE run,
 * which is how a user drops an xterm they do not want.
 *
 * `autoCloseSuccessful` (the user's opt-in preference, default off) drops the `seenActive`
 * exception for a run that exited 0, so a fan-out step stops accumulating finished xterms
 * under the user as each wave lands. It never touches an explicit click, and never a
 * running, queued or FAILED run — a failure is exactly the output still worth reading.
 */
export function isInvocationExpanded(
  invocation: CliInvocationSummary,
  overrides: InvocationOpenOverrides,
  seenActive: ReadonlySet<string>,
  autoCloseSuccessful = false,
): boolean {
  const override = overrides[invocation.id];
  if (override !== undefined) return override;
  if (invocation.isActive) return true;
  // exitCode === 0 is the same test the panel's green/red badge uses, so "successful" means
  // one thing across the UI: a null exit (killed, never started) reads as failed and stays.
  if (autoCloseSuccessful && invocation.exitCode === 0) return false;
  return seenActive.has(invocation.id);
}

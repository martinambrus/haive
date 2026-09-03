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
 * during this mount only, so a reload starts collapsed again.
 *
 * An explicit click always wins, in both directions — including collapsing a LIVE run,
 * which is how a user drops an xterm they do not want.
 */
export function isInvocationExpanded(
  invocation: CliInvocationSummary,
  overrides: InvocationOpenOverrides,
  seenActive: ReadonlySet<string>,
): boolean {
  const override = overrides[invocation.id];
  if (override !== undefined) return override;
  return invocation.isActive || seenActive.has(invocation.id);
}

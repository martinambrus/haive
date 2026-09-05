'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type CliInvocationListResponse,
  type CliInvocationOutput,
  type CliInvocationSummary,
} from '@/lib/api-client';
import { usePersistedToggle } from '@/lib/use-persisted-toggle';
import { CliStreamViewer } from './CliStreamViewer';
import { describeInvocationStatus } from './cli-stream-status';
import {
  INVOCATION_HISTORY_PAGE,
  invocationHistoryPaging,
  isInvocationExpanded,
  mergeInvocationPage,
  rememberActiveRuns,
  trimInvocationWindow,
  type InvocationOpenOverrides,
} from '@/lib/invocation-history';
import {
  type ActiveTerminalIds,
  scrollToNewestActiveTerminal,
  shouldFollowActiveTerminals,
  useAutoScrollTerminals,
} from '@/lib/terminal-autoscroll';
import { useAutoCloseSuccessfulTerminals } from '@/lib/terminal-autoclose';
import { formatDuration, formatTimeoutBudget } from '@/lib/format-duration';
import { formatTokens } from '@/lib/format-tokens';
import { invocationBanner } from '@/lib/step-banners';
import { useGlobalPause } from '@/lib/use-global-pause';

interface StepTerminalProps {
  taskId: string;
  /** UUID of the task_steps row (NOT stepId slug). The cli-invocations route
   *  joins on this column. */
  stepRowId: string;
  /** When true, default to expanded on mount and keep polling the invocation
   *  list while the step is active. Caller should pass step status === running
   *  || waiting_cli. */
  autoExpand: boolean;
  /** The step's live status_message — duplicated below run 2+ terminals so the
   *  status stays visible next to the active output when the top line scrolls off. */
  statusMessage: string | null;
}

export function StepTerminal({ taskId, stepRowId, autoExpand, statusMessage }: StepTerminalProps) {
  // Persisted per task so a reload restores whether this step's terminal was open.
  // autoExpand is only the fallback; the autoExpand-transition effect below still
  // fires on status changes (guarded against mount, so it never clobbers a restore).
  const [expanded, setExpanded, setExpandedAuto] = usePersistedToggle(
    `task-ui:${taskId}:term:${stepRowId}`,
    autoExpand,
  );
  const [invocations, setInvocations] = useState<CliInvocationSummary[] | null>(null);
  // The step's full non-superseded / completed counts, straight from the api. Held apart
  // from `invocations`, which is only the window currently loaded.
  const [totalCount, setTotalCount] = useState(0);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Explicit per-run open/closed clicks. Absent id = no opinion, and the default (live runs
  // expanded, finished ones collapsed) decides — see isInvocationExpanded.
  const [openOverrides, setOpenOverrides] = useState<InvocationOpenOverrides>({});
  // The most recent MAX_KEPT_OPEN_RUNS ids seen ACTIVE during this mount, so a run the user
  // watched finish keeps its output on screen instead of collapsing the instant it exits — but
  // only until newer runs push it out. A ref, not state: it is always populated by the poll
  // BEFORE the poll that reports the run ended, so the render that needs it already has it and
  // no extra re-render is required. Bounded by rememberActiveRuns; see its comment for why an
  // unbounded set is what put every run of a 48-wave step on screen at once.
  const seenActiveRef = useRef<Set<string>>(new Set());
  // Completed pages the user has deliberately loaded ("load older" clicks), starting at the head
  // page. It is the window budget handed to trimInvocationWindow, so POLLING can never grow the
  // held set — only a click can. A ref rather than state because `reload` reads it: as state it
  // would be a dependency, and re-creating `reload` restarts the poll interval on every click.
  const historyPagesRef = useRef(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useAutoScrollTerminals();
  const [autoCloseSuccessful, setAutoCloseSuccessful] = useAutoCloseSuccessfulTerminals();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const prevActiveRef = useRef<ActiveTerminalIds | null>(null);

  // Sync expanded state to autoExpand transitions only — not on every render.
  // This way: a step starts running → terminal pops open; the step finishes →
  // terminal collapses so focus moves to the next active step. Uses the EPHEMERAL
  // setter so these programmatic transitions never touch localStorage — only an
  // explicit user toggle (the button below) persists. Otherwise the auto-collapse
  // when the step ends would store '0', and a retry — which supersedes the step's
  // invocations (count → 0) so this terminal unmounts, then remounts once the
  // re-run's invocation appears while the step is already running — would restore
  // that stale '0' and stay hidden (the open-on-running guard can't fire: there's
  // no false→true transition at mount). A user's manual toggle still persists and
  // wins across reloads.
  const prevAutoExpand = useRef(autoExpand);
  useEffect(() => {
    if (autoExpand !== prevAutoExpand.current) {
      setExpandedAuto(autoExpand);
      prevAutoExpand.current = autoExpand;
    }
  }, [autoExpand]);

  /** Fetch the HEAD page: every active run plus the newest page of finished ones. The poll
   *  calls this, so it must never walk the cursor back over history the user has already
   *  loaded — mergeInvocationPage folds it in, keeping older pages and dropping only what
   *  the page is authoritative for. */
  const reload = useCallback(async () => {
    try {
      const data = await api.get<CliInvocationListResponse>(
        `/tasks/${taskId}/steps/${stepRowId}/cli-invocations?historyLimit=${INVOCATION_HISTORY_PAGE}`,
      );
      rememberActiveRuns(
        seenActiveRef.current,
        data.invocations.filter((inv) => inv.isActive).map((inv) => inv.id),
      );
      setInvocations((prev) =>
        trimInvocationWindow(
          mergeInvocationPage({
            prev: prev ?? [],
            page: data.invocations,
            limit: INVOCATION_HISTORY_PAGE,
            append: false,
          }),
          historyPagesRef.current * INVOCATION_HISTORY_PAGE,
        ),
      );
      setHistoryTotal(data.historyTotal ?? 0);
      setTotalCount(data.totalCount ?? data.invocations.length);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message ?? 'Failed to load CLI invocations');
    }
  }, [taskId, stepRowId]);

  /** One page older, from the oldest finished run currently held. Appends only — nothing
   *  already on screen is invalidated, and nothing here mounts a terminal: the runs it adds
   *  arrive collapsed, exactly like the ones already there. */
  const loadOlder = useCallback(
    async (cursor: string) => {
      setLoadingOlder(true);
      try {
        const data = await api.get<CliInvocationListResponse>(
          `/tasks/${taskId}/steps/${stepRowId}/cli-invocations` +
            `?historyLimit=${INVOCATION_HISTORY_PAGE}&historyCursor=${cursor}`,
        );
        // Widen the window BEFORE folding the page in, or the rows just fetched would be
        // trimmed straight back off and the button would look inert.
        historyPagesRef.current += 1;
        setInvocations((prev) =>
          trimInvocationWindow(
            mergeInvocationPage({
              prev: prev ?? [],
              page: data.invocations,
              limit: INVOCATION_HISTORY_PAGE,
              append: true,
            }),
            historyPagesRef.current * INVOCATION_HISTORY_PAGE,
          ),
        );
        // Keep the counts we have if an older api omits them — zeroing them here would hide
        // the very button that was just clicked.
        setHistoryTotal((prevTotal) => data.historyTotal ?? prevTotal);
        setTotalCount((prevTotal) => data.totalCount ?? prevTotal);
        setLoadError(null);
      } catch (err) {
        setLoadError((err as Error).message ?? 'Failed to load CLI invocations');
      } finally {
        setLoadingOlder(false);
      }
    },
    [taskId, stepRowId],
  );

  useEffect(() => {
    if (!expanded) return;
    void reload();
  }, [expanded, reload]);

  // Light polling so a fresh invocation row appears without manual refresh.
  // Poll while the STEP is active (autoExpand), not merely while a known
  // invocation is active. A multi-CLI step (e.g. 07b validate → implement-fix)
  // has a gap between two runs where the fetched list shows zero active; keying
  // the stop on anyActive alone cleared the interval in that gap, so the next
  // run's terminal never appeared until a manual page refresh. Keep polling
  // until the step goes idle AND nothing is still streaming.
  useEffect(() => {
    if (!expanded) return;
    if (!invocations) return;
    const anyActive = invocations.some((i) => i.isActive);
    if (!autoExpand && !anyActive) return;
    const t = setInterval(() => void reload(), 2000);
    return () => clearInterval(t);
  }, [expanded, invocations, autoExpand, reload]);

  // Follow the newest ACTIVE run whenever the set of running OR queued runs
  // CHANGES — a fresh run starts, a queued one finally gets a slot, a run ends
  // while its siblings keep going, or a new run is ENQUEUED behind the
  // concurrency cap. Tracking the SETS, not just the count, is what makes the
  // scroll follow the last active terminal as the queue drains, instead of
  // stalling on whichever ran first (e.g. landing on terminal 7 when 7 AND 8 go
  // active) — and reacting to a LOSS is what stops the view from staying parked on
  // the terminal that just exited when no replacement starts in the same tick.
  // Watching the QUEUED set too covers the case where the replacement cannot
  // start: run 1 ends and run 2 is enqueued with no slot free, which empties the
  // running set, so a running-only trigger read it as "step wrapping up" and never
  // moved. Target choice stays in scrollToNewestActiveTerminal — a running run
  // always outranks a queued one.
  // Not on the initial load (the page-level effect scrolls to the first terminal
  // when the step becomes active). Gated on the user's preference.
  useEffect(() => {
    if (invocations === null || !autoScroll) return;
    // "running" = started and not yet ended (mirrors data-cli-running); "queued" =
    // active with no startedAt (mirrors data-cli-queued). isActive alone conflates
    // the two, because endedAt is null for both.
    const active: ActiveTerminalIds = {
      running: invocations.filter((i) => i.isActive && i.startedAt !== null).map((i) => i.id),
      queued: invocations.filter((i) => i.isActive && i.startedAt === null).map((i) => i.id),
    };
    const prev = prevActiveRef.current;
    prevActiveRef.current = active;
    if (!shouldFollowActiveTerminals(prev, active)) return;
    // The new panel and its xterm mount a tick later; retry briefly.
    const timers = [80, 300, 700].map((delay) =>
      setTimeout(() => {
        const root = containerRef.current;
        if (root) scrollToNewestActiveTerminal(root);
      }, delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [invocations, autoScroll]);

  const loadedCount = invocations?.length ?? 0;
  const count = Math.max(totalCount, loadedCount);
  const activeCount = invocations?.filter((i) => i.isActive).length ?? 0;
  const paging = invocationHistoryPaging(invocations ?? [], historyTotal);
  const toggleInvocation = useCallback((id: string, open: boolean) => {
    setOpenOverrides((prev) => ({ ...prev, [id]: open }));
  }, []);

  return (
    <div ref={containerRef} className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 self-start text-xs text-indigo-400 hover:text-indigo-300"
      >
        <span>{expanded ? '▼' : '▶'}</span>
        <span className="underline">{expanded ? 'Hide' : 'Show'} terminal</span>
        {count > 0 && (
          <span className="rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-300">
            {count} run{count === 1 ? '' : 's'}
            {activeCount > 0 ? ` · ${activeCount} live` : ''}
          </span>
        )}
      </button>

      {expanded && (
        <div className="flex flex-col gap-3">
          {loadError && (
            <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {loadError}
            </div>
          )}
          {invocations !== null && invocations.length === 0 && (
            <div className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-400">
              No CLI invocations recorded for this step yet.
            </div>
          )}
          {/* Older history sits ABOVE the loaded runs, matching the oldest-on-top order
              below — "load older" grows the list upward, the way a chat scrollback does. */}
          {paging.remaining > 0 && paging.cursor !== null && (
            <LoadOlderRuns
              cursor={paging.cursor}
              remaining={paging.remaining}
              loading={loadingOlder}
              onLoad={loadOlder}
            />
          )}
          {/* API returns newest-first; reverse so the oldest run sits on top
              and subsequent runs flow downward in execution order. Run 1 is
              always the earliest invocation for the step — the number comes from the
              api, because the loaded window is bounded and cannot be counted from. */}
          {invocations
            ?.slice()
            .reverse()
            .map((inv) => (
              <InvocationPanel
                key={inv.id}
                taskId={taskId}
                invocation={inv}
                total={count}
                statusMessage={statusMessage}
                label={count > 1 && inv.runNumber ? `Run ${inv.runNumber}` : null}
                expanded={isInvocationExpanded(
                  inv,
                  openOverrides,
                  seenActiveRef.current,
                  autoCloseSuccessful,
                )}
                onToggle={toggleInvocation}
              />
            ))}
          {invocations !== null && invocations.length > 0 && (
            // data-cli-autoscroll sits on the ROW, not one label: it is the auto-scroll's
            // last-resort target, and framing the whole row keeps both toggles on screen.
            <div
              data-cli-autoscroll
              className="flex flex-wrap items-center justify-end gap-2 self-end text-[11px] text-neutral-500"
            >
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="h-3 w-3 rounded border-neutral-700 bg-neutral-900"
                />
                Auto-scroll to the newest run
              </label>
              <span className="h-3 w-px bg-neutral-700" aria-hidden />
              <label
                className="flex items-center gap-1.5"
                title="Collapse each run's terminal as soon as it exits 0. Running, queued and failed runs stay open, and a run you opened yourself stays open."
              >
                <input
                  type="checkbox"
                  checked={autoCloseSuccessful}
                  onChange={(e) => setAutoCloseSuccessful(e.target.checked)}
                  className="h-3 w-3 rounded border-neutral-700 bg-neutral-900"
                />
                Auto-close successful runs
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** "Load 20 older runs · 136 older" — the only way older history enters the DOM. The runs it
 *  adds arrive COLLAPSED like every other finished run, so loading history never mounts a
 *  terminal or fetches an output blob. */
function LoadOlderRuns({
  cursor,
  remaining,
  loading,
  onLoad,
}: {
  cursor: string;
  remaining: number;
  loading: boolean;
  onLoad: (cursor: string) => Promise<void>;
}) {
  const batch = Math.min(INVOCATION_HISTORY_PAGE, remaining);
  return (
    <button
      type="button"
      disabled={loading}
      onClick={() => void onLoad(cursor)}
      className="self-start rounded border border-neutral-800 bg-neutral-900/60 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
    >
      {loading ? 'Loading…' : `Load ${batch} older run${batch === 1 ? '' : 's'}`}
      <span className="pl-1.5 text-neutral-500">· {remaining} older</span>
    </button>
  );
}

interface InvocationPanelProps {
  taskId: string;
  invocation: CliInvocationSummary;
  label: string | null;
  /** Total runs in this step (api-wide, not the loaded window). The in-panel status box only
   *  renders for 2+ runs; single-terminal steps already show their status above the terminal. */
  total: number;
  /** Step's live status_message, shown below this panel when it's an active run
   *  past the first (the top status line is off-screen by then). */
  statusMessage: string | null;
  /** Whether this run's terminal body is mounted. Live runs default open, finished ones
   *  collapsed — a finished panel that stays collapsed costs no xterm and no output fetch,
   *  which is the whole point on a step with hundreds of runs. */
  expanded: boolean;
  onToggle: (id: string, open: boolean) => void;
}

function InvocationPanel({
  taskId,
  invocation,
  label,
  total,
  statusMessage,
  expanded,
  onToggle,
}: InvocationPanelProps) {
  // Which state this invocation's copy belongs to — decided on startedAt, not on the words.
  // Under global pause a QUEUED run says so instead of claiming a slot is coming; a run that
  // already started is left alone, because pause never interrupts work in flight.
  const globalPaused = useGlobalPause();
  const banner = invocationBanner(invocation, { paused: globalPaused });
  // Persistent provider verdict (refusal / model swap), read from the row so it outlives the
  // stream. Null for a clean run, which is nearly all of them.
  const statusVerdict = describeInvocationStatus(invocation);
  // "Past the first run" — from the api's run number, not a position in the loaded window,
  // which is bounded and would call run 137 the first one after a plain page load.
  const isLaterRun = (invocation.runNumber ?? 1) > 1;

  // "running" = started and not yet ended. isActive alone is true for a QUEUED
  // run too (endedAt is null), so the auto-scroll target must exclude those.
  const isRunning = invocation.isActive && invocation.startedAt !== null;
  // Enqueued but not yet picked up. invocationBanner always speaks for one of these, so the
  // queued branch below never falls through to the step-status fallback. Also the
  // auto-scroll fallback target (data-cli-queued) when nothing on the step is running.
  const isQueued = invocation.isActive && invocation.startedAt === null;
  return (
    // scroll-mt-12: the auto-scroll aligns a panel's TOP with the viewport top and a
    // fixed 39px bar spans the content column — without the margin this panel's run
    // label and status badges land behind it.
    <div
      data-cli-terminal
      data-cli-running={isRunning ? '' : undefined}
      data-cli-queued={isQueued ? '' : undefined}
      className="flex scroll-mt-12 flex-col gap-1.5 rounded border border-neutral-800 p-2"
    >
      {/* The header row is the expand control. Collapsed, this is ALL a finished run
          renders: no xterm, no output request. */}
      <button
        type="button"
        onClick={() => onToggle(invocation.id, !expanded)}
        aria-expanded={expanded}
        className="flex w-full flex-wrap items-center gap-2 text-left text-[11px] text-neutral-400"
      >
        <span className="text-neutral-500">{expanded ? '▼' : '▶'}</span>
        {label && <span className="font-medium text-neutral-200">{label}</span>}
        {/* Fan-out titles name the specific finding an agent works ("Refuter 2/4
            [reachability] — high installer/actions_step_4.php:36 · <issue>"), long enough to
            push the badges and the runtime onto their own line. Capped and ellipsized; the
            full string stays readable on hover. */}
        {invocation.agentTitle && (
          <span
            className="max-w-[24rem] truncate font-medium text-indigo-300"
            title={invocation.agentTitle}
          >
            {invocation.agentTitle}
          </span>
        )}
        <span className="rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5 uppercase tracking-wider">
          {invocation.mode === 'agent_mining' ? 'mining' : invocation.mode.replace(/_/g, ' ')}
        </span>
        {invocation.providerLabel && (
          <span className="font-medium text-neutral-200">{invocation.providerLabel}</span>
        )}
        {invocation.effort && invocation.effort.source !== 'none' && (
          // Skipped only for 'none' — a CLI with no effort knob has nothing to report. A
          // 'dropped' level IS rendered, in amber, because that is the case a user most needs
          // to see: they set a level this adapter does not have, so the CLI silently used its
          // own default. The source is shown at all because the level alone cannot tell a
          // deliberate setting from an adapter default that happens to be the same value.
          <span
            className={
              invocation.effort.source === 'dropped'
                ? 'rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-300'
                : 'rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5 text-violet-300'
            }
            title={
              invocation.effort.source === 'step'
                ? 'Effort set for this step'
                : invocation.effort.source === 'provider'
                  ? "Effort from the CLI provider's own setting"
                  : invocation.effort.source === 'dropped'
                    ? 'The configured effort level is not one this CLI has, so it was not sent and the CLI used its own default'
                    : 'Adapter default — nobody set a level for this run'
            }
          >
            {invocation.effort.source === 'dropped'
              ? 'effort not applied'
              : `effort ${invocation.effort.level}`}
          </span>
        )}
        {isRunning ? (
          <span className="rounded border border-yellow-500/40 bg-yellow-500/10 px-1.5 py-0.5 uppercase tracking-wider text-yellow-300">
            running
          </span>
        ) : invocation.isActive ? (
          // isActive alone is endedAt === null, which is ALSO true before the run starts, so
          // this badge used to call a queued invocation running — the same conflation the
          // status bar below made. Split on startedAt, exactly as invocationBanner does.
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 uppercase tracking-wider text-amber-300">
            queued
          </span>
        ) : invocation.exitCode === 0 ? (
          <span className="rounded border border-green-500/40 bg-green-500/10 px-1.5 py-0.5 uppercase tracking-wider text-green-300">
            exit 0
          </span>
        ) : (
          <span className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 uppercase tracking-wider text-red-300">
            exit {invocation.exitCode ?? '?'}
          </span>
        )}
        <InvocationRuntime
          startedAt={invocation.startedAt}
          durationMs={invocation.durationMs}
          timeoutMs={invocation.timeoutMs}
          isActive={invocation.isActive}
        />
        {invocation.tokenUsage &&
          (() => {
            const tu = invocation.tokenUsage;
            const cache = (tu.cacheReadTokens ?? 0) + (tu.cacheCreationTokens ?? 0);
            return (
              <span
                className="rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5 text-sky-300"
                title={
                  `Token usage (provider-native): in ${tu.inputTokens.toLocaleString()}` +
                  ` / out ${tu.outputTokens.toLocaleString()}` +
                  (tu.cacheReadTokens
                    ? ` / cache read ${tu.cacheReadTokens.toLocaleString()}`
                    : '') +
                  (tu.cacheCreationTokens
                    ? ` / cache write ${tu.cacheCreationTokens.toLocaleString()}`
                    : '') +
                  ` = total ${tu.totalTokens.toLocaleString()}`
                }
              >
                in {formatTokens(tu.inputTokens)} / out {formatTokens(tu.outputTokens)}
                {cache > 0 ? ` / cache ${formatTokens(cache)}` : ''} tok
              </span>
            );
          })()}
        {invocation.startedAt && <span>{new Date(invocation.startedAt).toLocaleTimeString()}</span>}
      </button>
      {expanded && <InvocationBody taskId={taskId} invocation={invocation} />}
      {/* Persistent provider-verdict banner, BELOW the terminal and read from the invocation row
          (not the stream), so it survives the CLI ending and the 600s stream expiry: a provider
          refusing the prompt, or silently swapping the served model. See cli-stream-status.ts. */}
      {statusVerdict && (
        <div className="flex items-start gap-2 rounded-md border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          <span className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full bg-amber-400" />
          <span>
            <span className="font-semibold">{statusVerdict.headline}</span>
            {statusVerdict.detail ? <> {statusVerdict.detail}</> : null}
          </span>
        </div>
      )}
      {isQueued && banner ? (
        // Queued: enqueued but no slot yet. Amber so the user sees the run is waiting rather than
        // a silent "connected" terminal. invocationBanner (lib/step-banners) splits queued from
        // running on startedAt, so a started invocation can never present itself as waiting for a
        // slot even when a gate's waiting line is still on the row — and it always returns copy
        // for a queued one, so this branch is what every queued run renders.
        <div className="flex items-center gap-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          {banner.text}
        </div>
      ) : (
        // isRunning, not isActive: the STEP's status_message describes whatever is running
        // right now, so lending it to a run that has not started yet makes that terminal report
        // another terminal's work as its own. A queued run is handled by the branch above.
        total > 1 &&
        isRunning &&
        (banner?.kind === 'running' || isLaterRun) &&
        (banner?.text ?? (isLaterRun ? statusMessage : null)) && (
          <div className="flex items-center gap-2 rounded-md border border-indigo-900/50 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-300">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
            {banner?.text ?? statusMessage}
          </div>
        )
      )}
    </div>
  );
}

/**
 * One run's terminal, mounted ONLY while its panel is expanded.
 *
 * Its own component so collapsing genuinely tears the run down: unmounting drops the xterm
 * instance, closes the live WebSocket, releases the fetched stream log, and — through this
 * effect's cleanup — cancels an output request still in flight. Leaving the body inside
 * InvocationPanel behind a `&&` would have kept the fetched megabytes alive in the parent's
 * state, which is the cost this whole change exists to avoid.
 */
function InvocationBody({
  taskId,
  invocation,
}: {
  taskId: string;
  invocation: CliInvocationSummary;
}) {
  const [replay, setReplay] = useState<CliInvocationOutput | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  // Active invocation → live WebSocket via CliStreamViewer (no fetch needed).
  // Ended invocation → fetch persisted rawOutput once and render statically.
  useEffect(() => {
    if (invocation.isActive) {
      setReplay(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get<CliInvocationOutput>(
          `/tasks/${taskId}/cli-invocations/${invocation.id}/output`,
        );
        if (!cancelled) setReplay(data);
      } catch (err) {
        if (!cancelled) setReplayError((err as Error).message ?? 'Failed to load output');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, invocation.id, invocation.isActive]);

  return (
    <>
      {replayError && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {replayError}
        </div>
      )}
      {invocation.isActive ? (
        <CliStreamViewer
          invocationId={invocation.id}
          taskId={taskId}
          height="h-[400px]"
          cleanSupported={invocation.mode !== 'subagent_sequential'}
          // Null while this run is queued, which is what keeps the stream-health badge quiet
          // until the CLI is actually launched.
          startedAt={invocation.startedAt}
        />
      ) : replay ? (
        <CliStreamViewer
          invocationId={invocation.id}
          taskId={taskId}
          staticOutput={replay.streamLog}
          staticCleanOutput={replay.cleanOutput}
          staticExitCode={replay.exitCode}
          cleanSupported={invocation.mode !== 'subagent_sequential'}
          height="h-[400px]"
        />
      ) : (
        !replayError && <div className="text-xs text-neutral-500">Loading output…</div>
      )}
    </>
  );
}

// Per-invocation runtime: ticks every second while the CLI runs, then freezes at
// the recorded total (durationMs) once it ends — so each terminal keeps its final
// wall-time on screen, making it easy to compare CLI speed across runs.
function InvocationRuntime({
  startedAt,
  durationMs,
  timeoutMs,
  isActive,
}: {
  startedAt: string | null;
  durationMs: number | null;
  timeoutMs: number | null;
  isActive: boolean;
}) {
  const ticking = isActive && !!startedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  let ms: number | null = null;
  if (isActive && startedAt) ms = Math.max(0, now - new Date(startedAt).getTime());
  else if (durationMs !== null) ms = durationMs;
  if (ms === null) return null;
  return (
    <span
      className={isActive ? 'text-yellow-300' : 'text-neutral-400'}
      title={
        isActive && timeoutMs !== null
          ? `Running time / ${formatTimeoutBudget(timeoutMs)} hard timeout`
          : isActive
            ? 'Running for'
            : 'Total runtime'
      }
    >
      {formatDuration(ms, { alwaysSeconds: isActive })}
      {isActive && timeoutMs !== null && (
        <>
          <span className="font-normal text-yellow-300"> / </span>
          <span className="font-normal text-neutral-400">{formatTimeoutBudget(timeoutMs)}</span>
        </>
      )}
    </span>
  );
}

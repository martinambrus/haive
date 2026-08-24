'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CliInvocationOutput, type CliInvocationSummary } from '@/lib/api-client';
import { usePersistedToggle } from '@/lib/use-persisted-toggle';
import { CliStreamViewer } from './CliStreamViewer';
import {
  type ActiveTerminalIds,
  scrollToNewestActiveTerminal,
  shouldFollowActiveTerminals,
  useAutoScrollTerminals,
} from '@/lib/terminal-autoscroll';
import { formatDuration } from '@/lib/format-duration';
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useAutoScrollTerminals();
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

  const reload = useCallback(async () => {
    try {
      const data = await api.get<{ invocations: CliInvocationSummary[] }>(
        `/tasks/${taskId}/steps/${stepRowId}/cli-invocations`,
      );
      setInvocations(data.invocations);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message ?? 'Failed to load CLI invocations');
    }
  }, [taskId, stepRowId]);

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

  const count = invocations?.length ?? 0;
  const activeCount = invocations?.filter((i) => i.isActive).length ?? 0;

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
          {/* API returns newest-first; reverse so the oldest run sits on top
              and subsequent runs flow downward in execution order. Run 1 is
              always the earliest invocation for the step. */}
          {invocations
            ?.slice()
            .reverse()
            .map((inv, idx) => (
              <InvocationPanel
                key={inv.id}
                taskId={taskId}
                invocation={inv}
                idx={idx}
                total={count}
                statusMessage={statusMessage}
                label={invocations.length > 1 ? `Run ${idx + 1}` : null}
              />
            ))}
          {invocations !== null && invocations.length > 0 && (
            <label
              data-cli-autoscroll
              className="flex items-center gap-1.5 self-end text-[11px] text-neutral-500"
            >
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="h-3 w-3 rounded border-neutral-700 bg-neutral-900"
              />
              Auto-scroll to the newest run
            </label>
          )}
        </div>
      )}
    </div>
  );
}

interface InvocationPanelProps {
  taskId: string;
  invocation: CliInvocationSummary;
  label: string | null;
  /** Zero-based position in the run list (0 = first/oldest run). */
  idx: number;
  /** Total runs in this step. The in-panel status box only renders for 2+ runs;
   *  single-terminal steps already show their status above the terminal. */
  total: number;
  /** Step's live status_message, shown below this panel when it's an active run
   *  past the first (the top status line is off-screen by then). */
  statusMessage: string | null;
}

function InvocationPanel({
  taskId,
  invocation,
  label,
  idx,
  total,
  statusMessage,
}: InvocationPanelProps) {
  const [replay, setReplay] = useState<CliInvocationOutput | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  // Which state this invocation's copy belongs to — decided on startedAt, not on the words.
  // Under global pause a QUEUED run says so instead of claiming a slot is coming; a run that
  // already started is left alone, because pause never interrupts work in flight.
  const globalPaused = useGlobalPause();
  const banner = invocationBanner(invocation, { paused: globalPaused });

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
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
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
      </div>
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
        (banner?.kind === 'running' || idx > 0) &&
        (banner?.text ?? (idx > 0 ? statusMessage : null)) && (
          <div className="flex items-center gap-2 rounded-md border border-indigo-900/50 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-300">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
            {banner?.text ?? statusMessage}
          </div>
        )
      )}
    </div>
  );
}

// Per-invocation runtime: ticks every second while the CLI runs, then freezes at
// the recorded total (durationMs) once it ends — so each terminal keeps its final
// wall-time on screen, making it easy to compare CLI speed across runs.
function InvocationRuntime({
  startedAt,
  durationMs,
  isActive,
}: {
  startedAt: string | null;
  durationMs: number | null;
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
      title={isActive ? 'Running for' : 'Total runtime'}
    >
      {formatDuration(ms)}
    </span>
  );
}

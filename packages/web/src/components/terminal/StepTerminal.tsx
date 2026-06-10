'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CliInvocationOutput, type CliInvocationSummary } from '@/lib/api-client';
import { CliStreamViewer } from './CliStreamViewer';
import { useAutoScrollTerminals } from '@/lib/terminal-autoscroll';
import { formatDuration } from '@/lib/format-duration';

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
  const [expanded, setExpanded] = useState<boolean>(autoExpand);
  const [invocations, setInvocations] = useState<CliInvocationSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useAutoScrollTerminals();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef<number | null>(null);

  // Sync expanded state to autoExpand transitions only — not on every render.
  // This way: a step starts running → terminal pops open; the step finishes →
  // terminal collapses so focus moves to the next active step. Manual toggles
  // in between persist until the next autoExpand transition.
  const prevAutoExpand = useRef(autoExpand);
  useEffect(() => {
    if (autoExpand !== prevAutoExpand.current) {
      setExpanded(autoExpand);
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

  // Light polling while any invocation is active so a fresh row appears
  // without manual refresh. Stops once nothing is active.
  useEffect(() => {
    if (!expanded) return;
    if (!invocations) return;
    const anyActive = invocations.some((i) => i.isActive);
    if (!anyActive) return;
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [expanded, invocations, reload]);

  // Scroll the newest run into view when a NEW invocation appears (the count
  // grows). Not on the initial load — the page-level effect scrolls to the first
  // terminal when a step becomes active; this handles subsequent runs (e.g. the
  // spec-quality review/correct passes). Gated on the user's preference.
  useEffect(() => {
    if (invocations === null) return;
    const count = invocations.length;
    const prev = prevCountRef.current;
    prevCountRef.current = count;
    if (prev === null || count <= prev || !autoScroll) return;
    // The new panel and its xterm mount a tick later; retry briefly.
    const timers = [80, 300, 700].map((delay) =>
      setTimeout(() => {
        const root = containerRef.current;
        // Scroll to the auto-scroll toggle, which sits just below the newest run,
        // so the checkbox stays visible and the user can see they can turn this
        // off. Fall back to the last run panel if the toggle isn't rendered yet.
        const toggle = root?.querySelector('[data-cli-autoscroll]');
        if (toggle) {
          toggle.scrollIntoView({ behavior: 'smooth', block: 'end' });
        } else {
          const panels = root?.querySelectorAll('[data-cli-terminal]');
          panels?.[panels.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
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
  /** Step's live status_message, shown below this panel when it's an active run
   *  past the first (the top status line is off-screen by then). */
  statusMessage: string | null;
}

function InvocationPanel({ taskId, invocation, label, idx, statusMessage }: InvocationPanelProps) {
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
    <div data-cli-terminal className="flex flex-col gap-1.5 rounded border border-neutral-800 p-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
        {label && <span className="font-medium text-neutral-200">{label}</span>}
        <span className="rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5 uppercase tracking-wider">
          {invocation.mode.replace(/_/g, ' ')}
        </span>
        {invocation.providerLabel && (
          <span className="font-medium text-neutral-200">{invocation.providerLabel}</span>
        )}
        {invocation.isActive ? (
          <span className="rounded border border-yellow-500/40 bg-yellow-500/10 px-1.5 py-0.5 uppercase tracking-wider text-yellow-300">
            running
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
        {invocation.tokenUsage && (
          <span
            className="rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5"
            title={`Token usage (provider-native semantics): total ${invocation.tokenUsage.totalTokens.toLocaleString()}${invocation.tokenUsage.cacheReadTokens ? `, cache read ${invocation.tokenUsage.cacheReadTokens.toLocaleString()}` : ''}`}
          >
            in {formatTokens(invocation.tokenUsage.inputTokens)} / out{' '}
            {formatTokens(invocation.tokenUsage.outputTokens)} tok
          </span>
        )}
        {invocation.startedAt && <span>{new Date(invocation.startedAt).toLocaleTimeString()}</span>}
      </div>
      {replayError && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {replayError}
        </div>
      )}
      {invocation.isActive ? (
        <CliStreamViewer invocationId={invocation.id} taskId={taskId} height="h-[400px]" />
      ) : replay ? (
        <CliStreamViewer
          invocationId={invocation.id}
          taskId={taskId}
          staticOutput={replay.rawOutput}
          staticExitCode={replay.exitCode}
          height="h-[400px]"
        />
      ) : (
        !replayError && <div className="text-xs text-neutral-500">Loading output…</div>
      )}
      {invocation.isActive && idx > 0 && statusMessage && (
        <div className="flex items-center gap-2 rounded-md border border-indigo-900/50 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
          {statusMessage}
        </div>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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

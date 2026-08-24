'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type CliInvocationOutput, type CliInvocationSummary } from '@/lib/api-client';
import type { PaneSide } from '@/lib/split-pane';
import { CliStreamViewer } from './CliStreamViewer';

interface SplitTerminalPaneProps {
  taskId: string;
  /** task_steps row id whose CLI output this column follows. */
  stepRowId: string;
  /** Which side of the split this column currently sits on. */
  side: PaneSide;
  onMove: (side: PaneSide) => void;
}

/** Newest running run, else the newest queued one, else the newest run overall. The
 *  API returns rows newest-first, so "newest" is simply the first match. One column
 *  follows one run; a step with several concurrent runs still shows them all in its
 *  inline terminal. */
function pickInvocation(rows: CliInvocationSummary[]): CliInvocationSummary | null {
  return (
    rows.find((r) => r.isActive && r.startedAt !== null) ??
    rows.find((r) => r.isActive) ??
    rows[0] ??
    null
  );
}

/**
 * The text column of the split view: the browser-testing agent's prose streaming beside
 * the browser it is driving, the way a stream keeps its chat alongside the video.
 *
 * Deliberately thin — `CliStreamViewer` in `cleanOnly` mode owns the WebSocket, the
 * prose accumulation and the stick-to-bottom scrolling. This component only decides
 * WHICH run to follow and re-checks that every couple of seconds, so a step whose next
 * run starts mid-session swaps over without a reload.
 */
export function SplitTerminalPane({ taskId, stepRowId, side, onMove }: SplitTerminalPaneProps) {
  const [invocations, setInvocations] = useState<CliInvocationSummary[] | null>(null);
  const [replay, setReplay] = useState<CliInvocationOutput | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await api.get<{ invocations: CliInvocationSummary[] }>(
        `/tasks/${taskId}/steps/${stepRowId}/cli-invocations`,
      );
      setInvocations(data.invocations);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load CLI invocations');
    }
  }, [taskId, stepRowId]);

  // Same 2s cadence as StepTerminal's list poll: a fresh run has to appear here on its
  // own, since the user is watching the browser rather than the page underneath.
  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 2000);
    return () => clearInterval(t);
  }, [reload]);

  const invocation = invocations ? pickInvocation(invocations) : null;
  const invocationId = invocation?.id ?? null;
  const isActive = invocation?.isActive ?? false;

  // Ended run → fetch its persisted output once and replay it statically, mirroring
  // InvocationPanel (StepTerminal.tsx). Live runs need no fetch; the viewer streams.
  useEffect(() => {
    if (!invocationId || isActive) {
      setReplay(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get<CliInvocationOutput>(
          `/tasks/${taskId}/cli-invocations/${invocationId}/output`,
        );
        if (!cancelled) setReplay(data);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to load output');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, invocationId, isActive]);

  const cleanSupported = invocation?.mode !== 'subagent_sequential';

  return (
    <div className="group relative flex h-full min-h-0 flex-col overflow-hidden rounded border border-neutral-800 bg-neutral-950 p-2">
      {/* Side switch, revealed on hover like the markdown viewer's toolbar. Only the
          button that actually moves the column is offered. */}
      <div className="pointer-events-none absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          onClick={() => onMove(side === 'right' ? 'left' : 'right')}
          className="pointer-events-auto rounded border border-neutral-800 bg-neutral-950/80 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
        >
          Move {side === 'right' ? 'left' : 'right'}
        </button>
      </div>
      {error && <div className="pb-1 text-xs text-red-400">{error}</div>}
      {invocation === null ? (
        <div className="text-xs text-neutral-500">
          {invocations === null ? 'Loading…' : 'No CLI output for this step yet.'}
        </div>
      ) : isActive ? (
        <CliStreamViewer
          key={invocation.id}
          invocationId={invocation.id}
          taskId={taskId}
          fill
          cleanOnly
          cleanSupported={cleanSupported}
          startedAt={invocation.startedAt}
        />
      ) : replay ? (
        <CliStreamViewer
          key={invocation.id}
          invocationId={invocation.id}
          taskId={taskId}
          fill
          cleanOnly
          cleanSupported={cleanSupported}
          staticOutput={replay.streamLog}
          staticCleanOutput={replay.cleanOutput}
          staticExitCode={replay.exitCode}
        />
      ) : (
        !error && <div className="text-xs text-neutral-500">Loading output…</div>
      )}
    </div>
  );
}

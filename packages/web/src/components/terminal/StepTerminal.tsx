'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CliInvocationOutput, type CliInvocationSummary } from '@/lib/api-client';
import { CliStreamViewer } from './CliStreamViewer';

interface StepTerminalProps {
  taskId: string;
  /** UUID of the task_steps row (NOT stepId slug). The cli-invocations route
   *  joins on this column. */
  stepRowId: string;
  /** When true, default to expanded on mount and keep polling the invocation
   *  list while the step is active. Caller should pass step status === running
   *  || waiting_cli. */
  autoExpand: boolean;
}

export function StepTerminal({ taskId, stepRowId, autoExpand }: StepTerminalProps) {
  const [expanded, setExpanded] = useState<boolean>(autoExpand);
  const [invocations, setInvocations] = useState<CliInvocationSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  const count = invocations?.length ?? 0;
  const activeCount = invocations?.filter((i) => i.isActive).length ?? 0;

  return (
    <div className="flex flex-col gap-2">
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
                label={invocations.length > 1 ? `Run ${idx + 1}` : null}
              />
            ))}
        </div>
      )}
    </div>
  );
}

interface InvocationPanelProps {
  taskId: string;
  invocation: CliInvocationSummary;
  label: string | null;
}

function InvocationPanel({ taskId, invocation, label }: InvocationPanelProps) {
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
    <div className="flex flex-col gap-1.5 rounded border border-neutral-800 p-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
        {label && <span className="font-medium text-neutral-200">{label}</span>}
        <span className="rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5 uppercase tracking-wider">
          {invocation.mode.replace(/_/g, ' ')}
        </span>
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
        {invocation.durationMs !== null && (
          <span>{(invocation.durationMs / 1000).toFixed(1)}s</span>
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
    </div>
  );
}

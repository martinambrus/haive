'use client';

import { useEffect, useState } from 'react';
import {
  customToolsCell,
  hasNothingToShow,
  integrationsCell,
  toolUsageRows,
} from '@/lib/call-log-cells';
import {
  getTaskToolUsage,
  type TaskToolUsage,
  type TaskToolUsageCounted,
  type TaskToolUsageStep,
} from '@/lib/api-client';

/** `id (n)` for a counted list, or a dash for an empty one. */
function countedList(items: TaskToolUsageCounted[]): string {
  if (items.length === 0) return '—';
  return items.map((i) => `${i.id} (${i.n})`).join(', ');
}

export function TaskToolUsageTable({ data }: { data: TaskToolUsage }) {
  const rows = toolUsageRows(data.steps);
  const runsCell = (u: TaskToolUsageStep) =>
    u.observable === 0 && u.runs > 0 ? (
      <span className="text-neutral-500">{u.runs} not observable</span>
    ) : (
      `${u.observable}/${u.runs}`
    );
  const personasCell = (u: TaskToolUsageStep) =>
    u.personasAssigned.length === 0 && u.personasRead.length === 0
      ? '—'
      : `${countedList(u.personasAssigned)} → ${countedList(u.personasRead)}`;
  // With no run in the rollup the totals are zeros of nothing measured, so they read as a dash.
  const totals = data.coverage.total === 0 ? null : data.totals;

  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-80 overflow-auto rounded border border-neutral-800">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-neutral-900 text-neutral-400">
            <tr>
              <th className="px-2 py-1 font-medium">Step</th>
              <th className="px-2 py-1 text-right font-medium">observable/runs</th>
              <th className="px-2 py-1 font-medium">personas assigned → opened</th>
              <th className="px-2 py-1 font-medium">skills invoked / opened</th>
              <th className="px-2 py-1 font-medium">MCP</th>
              <th className="px-2 py-1 font-medium">custom tools</th>
              <th className="px-2 py-1 font-medium">integrations</th>
              <th className="px-2 py-1 font-medium">sub-agents</th>
              <th className="px-2 py-1 text-right font-medium">tool calls</th>
            </tr>
          </thead>
          <tbody className="text-neutral-300">
            {rows.map((s) => {
              const u = s.usage;
              return (
                <tr key={s.stepRowId} className="border-t border-neutral-800 align-top">
                  <td className="px-2 py-1 font-mono">
                    {s.stepId}
                    {s.round > 0 && <span className="ml-1 text-neutral-500">r{s.round}</span>}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">{u ? runsCell(u) : '—'}</td>
                  <td className="px-2 py-1 text-indigo-300">{u ? personasCell(u) : '—'}</td>
                  <td className="px-2 py-1 text-emerald-300">
                    {!u || (u.skillsInvoked.length === 0 && u.skillsRead.length === 0)
                      ? '—'
                      : `${countedList(u.skillsInvoked)} / ${countedList(u.skillsRead)}`}
                  </td>
                  <td className="px-2 py-1 text-amber-300">
                    {!u || u.mcp.length === 0
                      ? '—'
                      : u.mcp.map((m) => `${m.server}/${m.tool} (${m.calls})`).join(', ')}
                  </td>
                  <td className="px-2 py-1 text-violet-300">{customToolsCell(s.customTools)}</td>
                  <td className="px-2 py-1 text-teal-300">{integrationsCell(s.integrations)}</td>
                  <td className="px-2 py-1 text-sky-300">{u ? countedList(u.subagents) : '—'}</td>
                  <td className="px-2 py-1 text-right font-mono">{u ? u.toolCalls : '—'}</td>
                </tr>
              );
            })}
            <tr className="border-t border-neutral-700 font-medium text-neutral-200">
              <td className="px-2 py-1">total</td>
              <td className="px-2 py-1 text-right font-mono">{totals ? runsCell(totals) : '—'}</td>
              <td className="px-2 py-1 text-indigo-300">{totals ? personasCell(totals) : '—'}</td>
              <td className="px-2 py-1 text-emerald-300">
                {!totals || (totals.skillsInvoked.length === 0 && totals.skillsRead.length === 0)
                  ? '—'
                  : `${countedList(totals.skillsInvoked)} / ${countedList(totals.skillsRead)}`}
              </td>
              <td className="px-2 py-1 text-amber-300">
                {!totals || totals.mcp.length === 0
                  ? '—'
                  : totals.mcp.map((m) => `${m.server}/${m.tool} (${m.calls})`).join(', ')}
              </td>
              <td className="px-2 py-1 text-violet-300">
                {customToolsCell(data.callTotals.customTools)}
              </td>
              <td className="px-2 py-1 text-teal-300">
                {integrationsCell(data.callTotals.integrations)}
              </td>
              <td className="px-2 py-1 text-sky-300">
                {totals ? countedList(totals.subagents) : '—'}
              </td>
              <td className="px-2 py-1 text-right font-mono">{totals ? totals.toolCalls : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-400">
        {totals ? (
          <>
            {data.coverage.observable} of {data.coverage.total} runs observable
            {data.coverage.partial > 0 && `, ${data.coverage.partial} partial (counts are floors)`}.
            {data.coverage.unobservable > 0 &&
              ` ${data.coverage.unobservable} ran on a CLI whose output carries no tool events (amp, gemini, a sequential sub-agent script) and are listed as not observable.`}
            {data.coverage.unrecorded > 0 &&
              ` ${data.coverage.unrecorded} ran before this record existed.`}{' '}
            Personas assigned by Haive are recorded only once the dispatch-side stamping ships;
            until then only the definition files an agent opened on its own appear. Opened is not
            applied. Custom tools and integrations count every call Haive logged for this task,
            refused calls and replaced runs included, so they need not match the MCP column.
          </>
        ) : (
          'No run of this task is in the rollup, so the columns read from runs show a dash. Custom tools and integrations count every call Haive logged for this task, refused calls and replaced runs included.'
        )}
      </p>
    </div>
  );
}

/** Read on mount, then again when the task ends, a run finishes, or a call count changes. */
export function TaskToolUsagePanel({
  taskId,
  taskCompletedAt,
  loggedCallCount,
  runningCallCount,
  finishedRunCount,
}: {
  taskId: string;
  taskCompletedAt: string | null;
  loggedCallCount: number;
  runningCallCount: number;
  finishedRunCount: number;
}) {
  const [data, setData] = useState<TaskToolUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTaskToolUsage(taskId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message ?? 'Failed to load tool usage');
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, taskCompletedAt, loggedCallCount, runningCallCount, finishedRunCount]);

  if (error && !data) return <p className="text-xs text-red-400">{error}</p>;
  if (!data) return <p className="text-xs text-neutral-500">Loading tool usage…</p>;
  if (hasNothingToShow(data)) {
    return <p className="text-xs text-neutral-500">No CLI run is attributed to a step yet.</p>;
  }

  return <TaskToolUsageTable data={data} />;
}

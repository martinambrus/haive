'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  getEstimationAccuracy,
  type EstimationAccuracyRow,
  type EstimationAccuracySummary,
} from '@/lib/api-client';
import { Card } from '@/components/ui';
import { usePageTitle } from '@/lib/use-page-title';

function fmtHours(h: number | null): string {
  if (h == null) return '—';
  return `${h.toFixed(2)}h`;
}

function fmtSignedPct(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="text-xl font-semibold text-neutral-100">{value}</p>
      {hint && <p className="text-[11px] text-neutral-600">{hint}</p>}
    </div>
  );
}

export default function EstimatesPage() {
  usePageTitle('Estimation accuracy');
  const params = useParams();
  const repositoryId = String(params.id);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<EstimationAccuracyRow[]>([]);
  const [summary, setSummary] = useState<EstimationAccuracySummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getEstimationAccuracy(repositoryId);
        if (cancelled) return;
        setRows(data.rows);
        setSummary(data.summary);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link href="/repos" className="text-xs text-indigo-300 hover:underline">
          ← Repositories
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-neutral-50">Estimation accuracy</h1>
        <p className="text-sm text-neutral-400">
          How the AI effort estimate (from the pre-flight estimate step) compared against the
          measured actual effort on this repository&apos;s completed tasks. The estimator learns
          from these as more tasks finish.
        </p>
      </div>

      {loading && <p className="text-sm text-neutral-500">Loading...</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && !error && summary && (
        <>
          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">Summary</h2>
            {summary.taskCount === 0 ? (
              <p className="mt-2 text-sm text-neutral-500">
                No completed tasks have a recorded AI estimate yet. Accuracy appears here as
                workflow tasks finish the estimate step.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Tasks" value={String(summary.taskCount)} />
                <Stat
                  label="MAPE"
                  value={`${summary.mapePct.toFixed(0)}%`}
                  hint="mean abs. % error"
                />
                <Stat
                  label="Median bias"
                  value={
                    summary.medianBiasFactor == null
                      ? '—'
                      : `${summary.medianBiasFactor.toFixed(2)}×`
                  }
                  hint={
                    summary.medianBiasFactor == null
                      ? undefined
                      : summary.medianBiasFactor > 1
                        ? 'tasks ran longer than estimated'
                        : summary.medianBiasFactor < 1
                          ? 'tasks ran shorter than estimated'
                          : 'on target'
                  }
                />
                <Stat
                  label="Under / over"
                  value={`${summary.underestimateCount} / ${summary.overestimateCount}`}
                  hint="under- vs over-estimated"
                />
              </div>
            )}
          </Card>

          {rows.length > 0 && (
            <Card>
              <h2 className="text-lg font-semibold text-neutral-100">Per task</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-neutral-500">
                      <th className="py-1 pr-3 font-medium">Task</th>
                      <th className="py-1 pr-3 font-medium">AI est.</th>
                      <th className="py-1 pr-3 font-medium">Actual</th>
                      <th className="py-1 pr-3 font-medium">Error</th>
                      <th className="py-1 font-medium">Confirmed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.taskId} className="border-t border-neutral-800">
                        <td className="py-1.5 pr-3">
                          <Link
                            href={`/tasks/${r.taskId}`}
                            className="text-indigo-300 hover:underline"
                          >
                            {r.title}
                          </Link>
                        </td>
                        <td className="py-1.5 pr-3 text-neutral-300">
                          {fmtHours(r.aiEstimatedHours)}
                        </td>
                        <td className="py-1.5 pr-3 text-neutral-300">{fmtHours(r.actualHours)}</td>
                        <td
                          className={`py-1.5 pr-3 ${
                            r.absErrorPct > 50 ? 'text-amber-400' : 'text-neutral-400'
                          }`}
                        >
                          {fmtSignedPct(r.signedErrorPct)}
                        </td>
                        <td className="py-1.5 text-neutral-400">{fmtHours(r.confirmedHours)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-neutral-600">
                Error = (actual − AI estimate) / actual. Positive means the task took longer than
                the AI predicted (under-estimate).
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

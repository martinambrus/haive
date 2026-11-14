import Link from 'next/link';
import { formatCost } from '@haive/web-kit/format-cost';
import { formatDuration } from '@haive/web-kit/format-duration';
import { TIME_CATEGORIES, type TimeCategory } from '@haive/shared/timing';
import type { TestExecution } from '@haive/shared/stats';
import type { StatsTimeCost } from '../api.js';
import { StackedShareBar } from './stacked-share-bar.js';
import { formatAgentHours } from '../lib/format-stats.js';

// Fixed to category, validated against #0a0a0a; named legend also identifies every segment.
export const REPORT_CATEGORY_COLORS: Record<TimeCategory, string> = {
  setup: '#38bdf8',
  planning: '#fb923c',
  implementation: '#a78bfa',
  tests: '#34d399',
  review: '#f472b6',
  delivery: '#facc15',
  other: '#a3a3a3',
};
const LABELS: Record<TimeCategory, string> = {
  setup: 'Setup',
  planning: 'Planning',
  implementation: 'Implementation',
  tests: 'Tests',
  review: 'Review',
  delivery: 'Delivery',
  other: 'Other',
};
export const reportDuration = (ms: number | null) => (ms === null ? '—' : formatDuration(ms));
export function reportTestPhase(ms: number | null, execution: TestExecution) {
  return `${reportDuration(ms)} · ${execution === 'not_run' ? 'not run' : execution === 'ran' ? 'command ran' : 'execution not recorded'}`;
}
function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className="break-words font-mono text-xl text-neutral-100">{value}</div>
      {hint && <div className="text-xs text-neutral-400">{hint}</div>}
    </div>
  );
}

export function TimeCostReport({ report }: { report: StatsTimeCost }) {
  const t = report.totals;
  const money = (usd: number | null) => (usd === null ? '—' : formatCost(usd, report.costDisplay));
  const apiRates = (r: {
    realUsd: number | null;
    notionalUsd: number | null;
    lowerBound: boolean;
  }) =>
    r.realUsd === null && r.notionalUsd === null
      ? '—'
      : `${r.lowerBound ? '≥ ' : ''}${money((r.realUsd ?? 0) + (r.notionalUsd ?? 0))}`;
  return (
    <section className="min-w-0 space-y-6 text-neutral-400" aria-label="Time & cost report">
      {report.scope.providerIgnored && (
        <p className="text-sm">
          Provider filter ignored: this report covers whole completed tasks across all providers.
        </p>
      )}
      <div className="grid grid-cols-2 gap-5 rounded-lg border border-neutral-800 p-4 lg:grid-cols-4">
        <Tile label="Tasks completed" value={String(report.taskCount)} />
        <Tile
          label="Test phase"
          value={reportDuration(t.testsMs)}
          hint={
            t.testExecution === 'not_run'
              ? 'not run'
              : t.testExecution === 'ran'
                ? 'Command execution recorded'
                : 'Execution not recorded'
          }
        />
        <Tile
          label="Workflow work"
          value={reportDuration(report.taskCount > 0 && t.timedTaskCount === 0 ? null : t.workMs)}
          hint={`${formatAgentHours(t.agentMs)} · summed invocation time`}
        />
        <Tile
          label="Human active"
          value={reportDuration(
            report.taskCount > 0 && t.timedTaskCount === 0 ? null : t.userActiveMs,
          )}
        />
        <Tile
          label="Waiting for a person"
          value={reportDuration(t.waitMs)}
          hint={`${t.pairedWaits} paired forms`}
        />
        <Tile label="Billed" value={money(t.realUsd)} />
        <Tile
          label="At API rates"
          value={apiRates(t)}
          hint={
            t.lowerBound
              ? 'Lower bound: some runs have no usable price'
              : 'Billed plus subscription equivalent'
          }
        />
      </div>
      <div className="min-w-0 rounded-lg border border-neutral-800 p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-200">Workflow work by category</h2>
        <StackedShareBar
          className="text-neutral-400 [&_.text-neutral-500]:text-neutral-400"
          segments={TIME_CATEGORIES.map((c) => ({
            key: c,
            label: LABELS[c],
            value: report.byCategory[c].workMs,
            color: REPORT_CATEGORY_COLORS[c],
          }))}
          formatValue={reportDuration}
        />
      </div>
      {report.taskCount === 0 ? (
        <p>No tasks completed in this window.</p>
      ) : (
        <div className="min-w-0 rounded-lg border border-neutral-800 p-3">
          <table className="w-full table-fixed text-xs" aria-label="Completed tasks time and cost">
            <colgroup>
              <col style={{ width: '22%' }} />
              <col style={{ width: '12%' }} />
              {Array.from({ length: 6 }, (_, i) => (
                <col key={i} style={{ width: '11%' }} />
              ))}
            </colgroup>
            <thead>
              <tr className="text-left align-top text-neutral-400">
                {[
                  'Task',
                  'Repository',
                  'Test phase',
                  'Workflow work',
                  'Human active',
                  'Waiting',
                  'Billed',
                  'At API rates',
                ].map((label) => (
                  <th key={label} className="break-words px-1 pb-3 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.taskId} className="border-t border-neutral-800 align-top">
                  <td className="break-words px-1 py-3 [overflow-wrap:anywhere]">
                    <Link
                      className="text-neutral-200 underline hover:text-white"
                      href={`/tasks/${r.taskId}`}
                    >
                      {r.title}
                    </Link>
                  </td>
                  <td className="break-words px-1 py-3 [overflow-wrap:anywhere]">
                    {r.repository ?? '—'}
                  </td>
                  <td className="break-words px-1 py-3">
                    {reportTestPhase(r.testsMs, r.testExecution)}
                  </td>
                  <td className="break-words px-1 py-3 font-mono">{reportDuration(r.workMs)}</td>
                  <td className="break-words px-1 py-3 font-mono">
                    {reportDuration(r.userActiveMs)}
                  </td>
                  <td className="break-words px-1 py-3 font-mono">{reportDuration(r.waitMs)}</td>
                  <td className="break-words px-1 py-3 font-mono">{money(r.realUsd)}</td>
                  <td className="break-words px-1 py-3 font-mono">{apiRates(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.truncated && (
            <p className="mt-3 text-xs">
              Showing the {report.rows.length} tasks with the most work of {report.taskCount}.
              Totals cover all tasks.
            </p>
          )}
        </div>
      )}
      <div className="haive-md haive-md-inherit text-sm text-neutral-400">
        <h2 className="font-medium text-neutral-200">What these figures cover</h2>
        <p>
          All figures cover tasks completed in the selected window, including their whole history.
          Money uses the dates runs happened, so its totals can differ from this report.
        </p>
        {t.timedTaskCount < report.taskCount && (
          <p>
            {report.taskCount - t.timedTaskCount} tasks have no step timing; work and human totals
            sum only recorded tasks.
          </p>
        )}
        <p>
          Workflow work is elapsed step work, including deterministic setup and the test phase;
          agent-hours sum concurrent invocations. Test phase includes setup and skipped commands and
          does not prove that tests executed. Execution coverage comes from surviving verification
          outcomes; earlier attempts may be unrecorded. Test commands run by agents during
          implementation remain in Implementation.
        </p>
        <p>
          Human active counts attention only on a waiting task form. Plan page time is reported
          separately on the Time tab and is excluded here. Steering, testing in another tab and
          forge review are not counted. Waiting measures only a form park closed by its submit;
          open, interrupted or ambiguous waits are unmeasured. {t.unmeasuredWaits} lifecycle records
          or waits could not be paired. A dash means unmeasured; a recorded zero remains zero.
        </p>
        <p>
          {t.unpricedInvocations} runs have no usable price; API rates are a lower bound when any
          are unpriced. {t.unsnapshottedInvocations} runs have no cost snapshot; usable legacy
          reported prices still count. {report.excludedLegacyInvocations} legacy runs without step
          attribution are excluded from costs and agent-hours, matching task provider cards.{' '}
          {t.unattributedInvocations} included runs could not be assigned to a category and appear
          in Other. Costs retained after a provider is deleted can differ from older task provider
          cards.
        </p>
        <p>
          Display currency: {report.costDisplay.currency}, at the window-end rate
          {report.costDisplay.rateDate ? ` dated ${report.costDisplay.rateDate}` : ''}
          {report.costDisplay.approximate ? ' (approximate)' : ''}.
        </p>
      </div>
    </section>
  );
}

import { formatTokens } from '@haive/web-kit/format-tokens';
import type { HostMarkdownView } from '@haive/web-kit/host';
import { Card, CardDescription, CardHeader, CardTitle } from '@haive/web-kit/ui';
import type { StatsFilesRead } from '../api.js';
import { STATS_DASH, formatCount, formatSampledRatio } from '../lib/format-stats.js';
import { CHART_COLORS } from './palette.js';
import { InlineBar } from './ranked-bars.js';

type Available = Extract<StatsFilesRead, { available: true }>;
type FileRow = Available['files']['rows'][number];
type StepRow = Available['steps']['rows'][number];
type Bucket = {
  reads: number;
  chars: number;
  estimatedTokens: number | null;
  share: FileRow['share'];
};

export const NO_REPOSITORY_MESSAGE =
  'Select a repository above to rank the files its agents read; paths of different repositories are not comparable.';

export function estimateText(tokens: number | null): string {
  return tokens === null ? STATS_DASH : `≈${formatTokens(Math.round(tokens))}`;
}

/** A path is agent-supplied text: a newline, a right-to-left override or a zero-width character
 *  could make the line read as another file, so control and format characters show as `\u{...}`
 *  escapes. Display only: the row key and the stored path stay as recorded. */
export function displayPath(path: string): string {
  return path.replace(/[\p{Cc}\p{Cf}]/gu, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);
}

export function fileRowFigures(row: FileRow): string {
  const parts = [
    `${formatCount(row.reads)} reads`,
    `${formatCount(row.runs)} runs`,
    `${formatCount(row.tasks)} tasks`,
    `${formatSampledRatio(row.share, 1)} of file-read tokens`,
  ];
  if (row.weightedRuns < row.runs) {
    parts.push(`weight known in ${formatCount(row.weightedRuns)} of ${formatCount(row.runs)} runs`);
  }
  return parts.join(' · ');
}

export function filesReadMessage({
  repositoryId,
  report,
  failed,
}: {
  repositoryId: string;
  report: StatsFilesRead | null;
  failed: boolean;
}): string | null {
  if (!repositoryId || (report && !report.available)) return NO_REPOSITORY_MESSAGE;
  if (failed) return 'The file-read report could not be loaded.';
  if (!report) return 'Loading...';
  if (report.available) {
    const c = report.coverage;
    if (c.total === 0) return 'No agent run in this window.';
    if (c.observable === 0) {
      return (
        `${formatCount(c.total)} runs in this window, none counts: ` +
        `${formatCount(c.unobservable)} could not be observed (a CLI without tool events or no transcript), ` +
        `${formatCount(c.unrecorded)} have no file-read record, ` +
        `${formatCount(c.inFlight)} are still running.`
      );
    }
  }
  return null;
}

export function filesReadNotes(report: Available): string {
  const notes = [
    'Estimated tokens are characters / 4, weighted by the turns a result stayed in context before compaction. They are not billed tokens: cache reads dominate real spend.',
    'Only weighted runs enter any estimate or share.' +
      (report.coverage.partial > 0
        ? ' Partial runs are floors: their reads and characters are exact floors and carry no estimate.'
        : ''),
    'n= replaces a percentage when too few runs back it.',
    'Step shares count only runs with a seen result, a known context lifetime and recorded token usage.',
    'Runs on CLIs without tool events and runs recorded before this existed are not in the lists.',
  ];
  return notes.join('\n\n');
}

function figure(label: string, value: string, caption: string, amber = false) {
  return (
    <div key={label} className="min-w-0">
      <div className="text-xs text-neutral-400">{label}</div>
      <div
        className={`break-words font-mono text-xl ${amber ? 'text-amber-300' : 'text-neutral-100'}`}
      >
        {value}
      </div>
      <div className="text-xs text-neutral-400">{caption}</div>
    </div>
  );
}

const maxOf = (values: (number | null)[]) => Math.max(0, ...values.map((v) => v ?? 0));

function bucketLine(label: string, b: Bucket, extra: string) {
  return (
    <div className="text-sm text-neutral-400">
      <span className="text-neutral-200">{label}</span>
      {` · ${formatCount(b.reads)} reads · ${estimateText(b.estimatedTokens)} · ${formatSampledRatio(b.share, 1)} of file-read tokens${extra}`}
    </div>
  );
}

function stepRow(row: StepRow, max: number) {
  const measured = row.share.n > 0;
  return (
    <li key={row.stepId} className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 break-all font-mono text-sm text-neutral-200">{row.stepId}</span>
        <span className="shrink-0 font-mono text-sm text-neutral-100">
          {measured ? formatSampledRatio(row.share, 1) : STATS_DASH}
        </span>
      </div>
      {row.estimatedTokens !== null && (
        <InlineBar value={row.estimatedTokens} max={max} color={CHART_COLORS.tokens} />
      )}
      {!measured ? (
        <div className="text-xs text-neutral-400">
          No run was measurable: a share needs a seen result, a known context lifetime and recorded
          token usage.
        </div>
      ) : (
        <>
          <div className="text-xs text-neutral-400">
            {`${estimateText(row.estimatedTokens)} file tokens of ${
              row.promptTokens === null ? STATS_DASH : formatTokens(Math.round(row.promptTokens))
            } exact prompt tokens (fresh + cache read + cache creation) · ${formatCount(row.share.n)} of ${formatCount(row.runs)} runs measured`}
          </div>
          {row.exceedsPrompt && (
            <div className="text-xs text-amber-300">
              The estimate exceeds the exact prompt tokens; it is shown unclamped.
            </div>
          )}
        </>
      )}
    </li>
  );
}

export function FilesReadSection({
  repositoryId,
  report,
  failed,
  MarkdownView,
}: {
  repositoryId: string;
  report: StatsFilesRead | null;
  failed: boolean;
  MarkdownView: HostMarkdownView;
}) {
  const message = filesReadMessage({ repositoryId, report, failed });
  const header = (
    <CardHeader>
      <CardTitle>Files read</CardTitle>
      <CardDescription>
        Files agents read in the selected repository, ranked by estimated tokens (characters / 4, an
        estimate, not billed tokens), and each step&apos;s share of its exact prompt tokens.
      </CardDescription>
    </CardHeader>
  );
  if (message !== null || !report || !report.available) {
    return (
      <Card>
        {header}
        <p className="text-sm text-neutral-400">{message}</p>
      </Card>
    );
  }

  const c = report.coverage;
  const fileMax = maxOf(report.files.rows.map((r) => r.estimatedTokens));
  const stepMax = maxOf(report.steps.rows.map((r) => r.estimatedTokens));
  const { otherPaths, overflow, multiFile } = report;
  return (
    <Card>
      {header}
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {figure(
            'Observable runs',
            formatCount(c.observable),
            `of ${formatCount(c.total)} in the window`,
          )}
          {figure('Weighted runs', formatCount(c.weighted), 'the base of every estimate')}
          {figure(
            'File reads',
            formatCount(report.totals.fileReads),
            `${formatCount(report.totals.fileChars)} characters`,
          )}
          {figure(
            'Estimated tokens',
            estimateText(report.totals.estimatedTokens),
            'characters / 4 over weighted runs',
          )}
          {c.partial > 0 &&
            figure('Partial runs', formatCount(c.partial), 'counts are floors', true)}
        </div>

        {c.byProvider.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-neutral-400">
              <thead>
                <tr className="text-xs">
                  <th className="px-1 py-2 font-medium">Provider</th>
                  <th className="px-1 py-2 font-medium">Runs</th>
                  <th className="px-1 py-2 font-medium">Observable</th>
                  <th className="px-1 py-2 font-medium">Weighted</th>
                  <th className="px-1 py-2 font-medium">Partial</th>
                  <th className="px-1 py-2 font-medium">Not recorded</th>
                </tr>
              </thead>
              <tbody>
                {c.byProvider.map((p) => (
                  <tr key={p.provider ?? '\u0000none'}>
                    <td className="px-1 py-2 text-neutral-200">{p.provider ?? 'no provider'}</td>
                    <td className="px-1 py-2 font-mono">{formatCount(p.total)}</td>
                    <td className="px-1 py-2 font-mono">{formatCount(p.observable)}</td>
                    <td className="px-1 py-2 font-mono">{formatCount(p.weighted)}</td>
                    <td className="px-1 py-2 font-mono">{formatCount(p.partial)}</td>
                    <td className="px-1 py-2 font-mono">{formatCount(p.unrecorded)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="space-y-3">
          {report.files.rows.length === 0 ? (
            <div className="text-sm text-neutral-400">No file path was recorded in these runs.</div>
          ) : (
            <ul className="space-y-3">
              {report.files.rows.map((row) => (
                <li key={row.path} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 break-all font-mono text-sm text-neutral-200">
                      {displayPath(row.path)}
                    </span>
                    <span className="shrink-0 font-mono text-sm text-neutral-100">
                      {estimateText(row.estimatedTokens)}
                    </span>
                  </div>
                  {row.estimatedTokens !== null && (
                    <InlineBar
                      value={row.estimatedTokens}
                      max={fileMax}
                      color={CHART_COLORS.tokens}
                    />
                  )}
                  <div className="text-xs text-neutral-400">{fileRowFigures(row)}</div>
                </li>
              ))}
            </ul>
          )}
          {report.files.truncated && (
            <div className="text-sm text-neutral-400">
              {`Showing the ${formatCount(report.files.rows.length)} top paths of ${formatCount(report.files.count)}.`}
            </div>
          )}
          {otherPaths.paths > 0 &&
            bucketLine(
              `+${formatCount(otherPaths.paths)} more paths`,
              otherPaths,
              ` · ${formatCount(report.files.count)} paths in all, ${report.files.truncated ? 'list truncated' : 'list complete'}`,
            )}
          {overflow.omitted > 0 &&
            bucketLine(
              `${formatCount(overflow.omitted)} paths left off their runs' own 50-file lists`,
              overflow,
              ` · ${formatCount(overflow.runs)} runs, a path counted once per run`,
            )}
          {multiFile.runs > 0 &&
            bucketLine(
              'One shell call read several files, not attributable to one path',
              multiFile,
              ` · ${formatCount(multiFile.runs)} runs`,
            )}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium text-neutral-200">
            Share of each step&apos;s prompt tokens
          </h3>
          <ul className="space-y-3">{report.steps.rows.map((row) => stepRow(row, stepMax))}</ul>
          {report.steps.truncated && (
            <div className="text-sm text-neutral-400">
              {`Showing the ${formatCount(report.steps.rows.length)} steps with the most file tokens of ${formatCount(report.steps.count)}.`}
            </div>
          )}
        </div>

        <div className="text-sm text-neutral-400">
          <MarkdownView
            className="haive-md-inherit max-h-none overflow-visible p-0"
            enhanced={false}
            body={filesReadNotes(report)}
          />
        </div>
      </div>
    </Card>
  );
}

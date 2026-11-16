'use client';
import { MarkdownView } from './markdown-view';
import { Button } from '@/components/ui';
export interface MarkdownReportPage {
  title: string;
  body: string;
  offset: number;
  total: number;
  pageSize: number;
}
/** Generic report reader, including completed forms whose input fields are no longer shown. */
export function PagedMarkdownReport({
  report,
  error,
  onPage,
}: {
  report: MarkdownReportPage | null;
  error?: string;
  onPage: (offset: number) => void;
}) {
  return (
    <>
      <h1 className="text-xl font-semibold">{report?.title ?? 'Task report'}</h1>
      {error ? (
        <MarkdownView body={error} />
      ) : !report ? (
        <MarkdownView body="Loading report…" />
      ) : (
        <>
          <MarkdownView body={report.body} />
          <div className="flex items-center gap-3">
            <Button
              disabled={report.offset === 0}
              onClick={() => onPage(Math.max(0, report.offset - report.pageSize))}
            >
              Previous
            </Button>
            <span>
              {report.total
                ? `${report.offset + 1}–${Math.min(report.offset + report.pageSize, report.total)} of ${report.total} entries`
                : 'No entries'}
            </span>
            <Button
              disabled={report.offset + report.pageSize >= report.total}
              onClick={() => onPage(report.offset + report.pageSize)}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </>
  );
}

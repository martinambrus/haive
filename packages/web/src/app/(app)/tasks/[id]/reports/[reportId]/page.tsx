'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api-client';
import { PagedMarkdownReport, type MarkdownReportPage } from '@/components/markdown/paged-report';
export default function TaskReport({
  params,
}: {
  params: Promise<{ id: string; reportId: string }>;
}) {
  const { id, reportId } = use(params);
  const [offset, setOffset] = useState(0);
  const [report, setReport] = useState<MarkdownReportPage | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setReport(null);
    setError('');
    api
      .get<MarkdownReportPage>(
        `/tasks/${encodeURIComponent(id)}/reports/${encodeURIComponent(reportId)}?offset=${offset}`,
        controller.signal,
      )
      .then((value) => {
        if (!controller.signal.aborted) setReport(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('The report could not be loaded.');
      });
    return () => controller.abort();
  }, [id, reportId, offset]);
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <Link href={`/tasks/${encodeURIComponent(id)}`}>Back to task</Link>
      <PagedMarkdownReport report={report} error={error} onPage={setOffset} />
    </div>
  );
}

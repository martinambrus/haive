'use client';

import { useEffect, useState } from 'react';
import type { LatestRefreshRun, RefreshCliVersionsJobResult } from '@haive/shared/constants';
import { api } from '@/lib/api-client';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { RefreshFailures } from './refresh-failures';

/** Read even with no manual poll: boot and scheduled runs have no browser job id. */
export function LatestRefresh({
  endpoint,
  active,
  result,
}: {
  endpoint: string;
  active: boolean;
  result: RefreshCliVersionsJobResult | null;
}) {
  const [run, setRun] = useState<LatestRefreshRun | null>(null);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const response = await api.get<{ run: LatestRefreshRun | null }>(
          endpoint,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setRun(response.run);
          setLoadError(false);
        }
      } catch {
        if (!controller.signal.aborted) setLoadError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void read(), 10_000);
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [endpoint, active]);

  if (active) return null;
  return (
    <div className="space-y-2 text-sm text-neutral-400">
      {loadError && (
        <MarkdownView body="Unable to load the latest refresh result. Retrying shortly." />
      )}
      {run && (
        <MarkdownView
          body={
            run.finishedAt === null
              ? `The latest ${run.trigger} refresh started at ${run.startedAt} and has not finished. It may still be running or have been interrupted.`
              : `The latest ${run.trigger} refresh finished at ${run.finishedAt}.${run.result?.ok ? ' All sources refreshed successfully.' : ''}`
          }
        />
      )}
      <RefreshFailures result={run ? (run.finishedAt === null ? null : run.result) : result} />
    </div>
  );
}

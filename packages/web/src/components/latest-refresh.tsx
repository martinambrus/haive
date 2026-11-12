'use client';

import { useEffect, useState } from 'react';
import type { LatestRefreshRun, RefreshCliVersionsJobResult } from '@haive/shared/constants';
import { api } from '@/lib/api-client';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { RefreshFailures } from './refresh-failures';

function refreshSummary(result: RefreshCliVersionsJobResult | null): string {
  if (result?.skipped?.length) {
    return `${result.ok ? ' Other sources refreshed successfully.' : ''} Skipped: ${result.skipped.join(', ')}.`;
  }
  return result?.ok ? ' All sources refreshed successfully.' : '';
}

function triggerLabel(trigger: string): string {
  return trigger === 'manual' || trigger === 'scheduled' || trigger === 'boot' ? ` ${trigger}` : '';
}

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
    let inFlight = false;
    let hidden = document.hidden;
    const read = async () => {
      if (controller.signal.aborted || document.hidden || inFlight) return;
      inFlight = true;
      clearTimeout(timer);
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
        inFlight = false;
        if (!controller.signal.aborted && !document.hidden)
          timer = setTimeout(() => void read(), 10_000);
      }
    };
    const onVisibility = () => {
      if (hidden === document.hidden) return;
      hidden = document.hidden;
      clearTimeout(timer);
      if (!hidden) void read();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [endpoint, active]);

  if (active) return null;
  // The durable read can lag the job poll or fail. Only a newer run may supersede
  // the completed result we already have. Without a start time, only a matching
  // run id proves that the local result belongs to the stored run.
  const preferResult =
    result !== null &&
    (!run ||
      run.runId === result.runId ||
      (result.startedAt !== undefined &&
        new Date(run.startedAt).getTime() <= new Date(result.startedAt).getTime()));
  const displayedRun =
    preferResult && (run?.runId !== result?.runId || run?.finishedAt === null) ? null : run;
  return (
    <div className="space-y-2 text-sm text-neutral-400">
      {loadError && (
        <InlineMarkdown body="Unable to load the latest refresh result. Retrying shortly." />
      )}
      {preferResult && !displayedRun && (
        <InlineMarkdown body={`The requested refresh finished.${refreshSummary(result)}`} />
      )}
      {displayedRun && (
        <InlineMarkdown
          body={
            displayedRun.finishedAt === null
              ? `The latest${triggerLabel(displayedRun.trigger)} refresh started at ${new Date(displayedRun.startedAt).toLocaleString()} and has not finished. It may still be running or have been interrupted.`
              : `The latest${triggerLabel(displayedRun.trigger)} refresh finished at ${new Date(displayedRun.finishedAt).toLocaleString()}.${refreshSummary(displayedRun.result)}`
          }
        />
      )}
      <RefreshFailures
        result={preferResult ? result : displayedRun?.finishedAt ? displayedRun.result : null}
      />
    </div>
  );
}

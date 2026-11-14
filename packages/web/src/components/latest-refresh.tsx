'use client';

import { useEffect, useState } from 'react';
import {
  REFRESH_TRIGGER_LABELS,
  type LatestRefreshRun,
  type RefreshCliVersionsJobResult,
  type RefreshTrigger,
} from '@haive/shared/constants';
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
  const label = Object.hasOwn(REFRESH_TRIGGER_LABELS, trigger)
    ? REFRESH_TRIGGER_LABELS[trigger as RefreshTrigger]
    : '';
  return label ? ` ${label}` : '';
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
  const displayedResult = preferResult
    ? result
    : displayedRun?.finishedAt
      ? displayedRun.result
      : null;
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
      <RefreshFailures result={displayedResult} />
      {!!displayedResult?.unsupported?.length && (
        <div className="space-y-2 text-neutral-400">
          <InlineMarkdown body="These models have unsupported feed pricing and remain unpriced unless a manual rate or valid reported total applies." />
          <ul className="space-y-1">
            {displayedResult.unsupported.map(({ model, reason }) => (
              <li key={`${model}:${reason}`} className="flex flex-wrap gap-2">
                <code className="text-indigo-300">{model}</code>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

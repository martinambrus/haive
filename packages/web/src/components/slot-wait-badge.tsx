'use client';

import { Badge } from '@/components/ui';
import { formatDuration } from '@/lib/format-duration';
import type { SlotWait } from '@/lib/api-client';

const KIND_LABEL: Record<SlotWait['kind'], string> = {
  runtime: 'runtime slot',
  agent: 'agent slot',
};

const STALE_HINT =
  'The queue has not checked in for over two minutes — the worker may have died, so this task ' +
  'is probably wedged rather than waiting. Check the worker, then Retry the step.';

/**
 * Badge for a task that is `running` in the database but actually queued behind a capacity
 * cap. Shown INSTEAD of the plain `running` status badge: the whole point is that "running"
 * was indistinguishable from "waiting in line" on the tasks listing. The wait duration
 * re-renders on the caller's poll, so it ticks without a timer of its own.
 */
export function SlotWaitBadge({ slotWait }: { slotWait: SlotWait }) {
  const sinceMs = slotWait.since ? new Date(slotWait.since).getTime() : null;
  const waitedMs = sinceMs === null || Number.isNaN(sinceMs) ? null : Date.now() - sinceMs;
  const waited = waitedMs !== null && waitedMs > 0 ? ` · ${formatDuration(waitedMs)}` : '';
  return (
    <Badge
      variant={slotWait.stale ? 'error' : 'warning'}
      title={
        slotWait.stale
          ? `${slotWait.message ?? 'Queued for a slot'}\n\n${STALE_HINT}`
          : (slotWait.message ?? `Queued for a free ${KIND_LABEL[slotWait.kind]}`)
      }
    >
      waiting: {KIND_LABEL[slotWait.kind]}
      {waited}
      {slotWait.stale ? ' · stalled?' : ''}
    </Badge>
  );
}

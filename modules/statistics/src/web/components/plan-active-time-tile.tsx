import { formatDuration } from '@haive/web-kit/format-duration';
import { StatTile } from './stat-tile.js';

/** Repository/hour attention remains separate from completed-task human effort. */
export function PlanActiveTimeTile({ activeMs }: { activeMs: number | null }) {
  return (
    <StatTile
      label="Plan page"
      value={activeMs == null ? '—' : formatDuration(activeMs)}
      hint="Activity window · all providers · UTC hour starts"
      tone="text-amber-300"
    />
  );
}

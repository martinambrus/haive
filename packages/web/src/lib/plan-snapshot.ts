import type { PlanSnapshotHealth } from '@/lib/api-client';

/** Only git saying "no origin" (false) offers Link to origin; an unknown (null) shows the actions. */
export function showsPushAndPull(snapshot: PlanSnapshotHealth | null): boolean {
  return snapshot !== null && snapshot.hasOrigin !== false;
}
